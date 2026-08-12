import express from "express";
import cookieParser from "cookie-parser";

import config from "./config.js";
import * as discord from "./discord.js";
import * as scoutid from "./scoutid.js";
import * as scoutnet from "./scoutnet.js";
import * as storage from "./storage.js";
import * as roles from "./roles.js";
import * as audit from "./audit.js";
import { getSuccessPageHTML } from "./templates.js";

const app = express();
app.use(cookieParser(config.COOKIE_SECRET));

// --- Health check ---

app.get("/", (req, res) => {
  res.send("👋");
});

// --- OAuth flow: step 1 - redirect to Discord ---

app.get("/linked-role", async (req, res) => {
  const { url, state } = discord.getOAuthUrl();
  res.cookie("clientState", state, { maxAge: 1000 * 60 * 5, signed: true });
  res.redirect(url);
});

// --- OAuth flow: step 2 - Discord callback → redirect to ScoutID ---

app.get("/discord-oauth-callback", async (req, res) => {
  try {
    const code = req.query["code"];
    const discordState = req.query["state"];

    const { clientState } = req.signedCookies;
    if (clientState !== discordState) {
      console.error("State verification failed.");
      return res.sendStatus(403);
    }

    const tokens = await discord.getOAuthTokens(code);
    const meData = await discord.getUserData(tokens);
    const userId = meData.user.id;

    await storage.storeDiscordTokens(userId, {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: Date.now() + tokens.expires_in * 1000,
    });

    // Redirect to ScoutID for identity verification
    const { state, codeVerifier, url } = scoutid.getOidcAuthorizationUrl();

    res.cookie("clientState", state, { maxAge: 1000 * 60 * 5, signed: true });
    await storage.storeStateData(state, {
      discordUserId: userId,
      codeVerifier,
    });
    res.redirect(url);
  } catch (e) {
    console.error(e);
    res.sendStatus(500);
  }
});

// --- OAuth flow: step 3 - ScoutID callback → link accounts + assign roles ---

app.get("/scoutid-oauth-callback", async (req, res) => {
  try {
    const state = req.query["state"];
    const { discordUserId, codeVerifier } = await storage.getStateData(state);

    const { clientState } = req.signedCookies;
    if (clientState !== state) {
      console.error("State verification failed.");
      return res.sendStatus(403);
    }

    const code = req.query["code"];
    const tokens = await scoutid.getOidcTokens({ code, codeVerifier });
    const scoutIDUser = await scoutid.getUserData(tokens);

    console.log(
      `Linked ScoutID ${scoutIDUser.scoutid} to Discord user ${discordUserId}`,
    );

    await storage.storeScoutIDTokens(scoutIDUser.scoutid, {
      discord_user_id: discordUserId,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: Date.now() + tokens.expires_in * 1000,
    });

    // Link accounts and push metadata
    await storage.setLinkedScoutIDUserId(discordUserId, scoutIDUser.scoutid);
    await updateMetadata(discordUserId);

    // Assign Discord roles
    try {
      const guildId = config.DISCORD_GUILD_ID;
      if (guildId) {
        const desiredRoles = await roles.getDesiredRoles(scoutIDUser.scoutid);
        if (desiredRoles.length > 0) {
          await addDiscordRoles(discordUserId, desiredRoles);
        }
      }
    } catch (e) {
      console.error(`Error assigning roles for ${discordUserId}:`, e.message);
    }

    // Update nickname with role suffix
    if (scoutIDUser.name) {
      const suffix = await roles.getNicknameSuffix(scoutIDUser.scoutid);
      await updateNickname(discordUserId, scoutIDUser.name + suffix);
    }

    res.send(getSuccessPageHTML());
  } catch (e) {
    console.error(e);
    res.sendStatus(500);
  }
});

// --- Discord interactions (slash commands) ---

const ADMIN_PERMISSION = BigInt(0x8);

// Slash commands ACK within Discord's 3-second window and then do the real
// work a moment later. That work outlives the HTTP response, so draining
// connections at shutdown is not enough on its own — it has to be tracked and
// waited for, or a rollout kills it after the user has already been told the
// command was accepted.
const pendingWork = new Set();

function scheduleBackground(fn, delayMs = 1000) {
  const task = new Promise((resolve) => {
    setTimeout(() => {
      Promise.resolve().then(fn).catch(console.error).finally(resolve);
    }, delayMs);
  });
  pendingWork.add(task);
  task.finally(() => pendingWork.delete(task));
  return task;
}

app.post(
  "/interactions",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const signature = req.headers["x-signature-ed25519"];
    const timestamp = req.headers["x-signature-timestamp"];
    const rawBody = req.body.toString();

    if (
      !discord.verifyInteraction(
        config.DISCORD_PUBLIC_KEY,
        signature,
        timestamp,
        rawBody,
      )
    ) {
      return res.sendStatus(401);
    }

    const interaction = JSON.parse(rawBody);

    // Discord PING verification
    if (interaction.type === 1) {
      return res.json({ type: 1 });
    }

    // Slash command
    if (interaction.type === 2 && interaction.data.name === "refresh-scoutid") {
      // Respond with deferred ephemeral message (type 5, flags 64), then process in background
      res.json({ type: 5, data: { flags: 64 } });
      scheduleBackground(() => handleRefreshCommand(interaction));
      return;
    }

    if (interaction.type === 2 && interaction.data.name === "status-scoutid") {
      res.json({ type: 5, data: { flags: 64 } });
      scheduleBackground(() => handleStatusCommand(interaction));
      return;
    }

    if (interaction.type === 2 && interaction.data.name === "audit-scoutid") {
      res.json({ type: 5, data: { flags: 64 } });
      scheduleBackground(() => handleAuditCommand(interaction));
      return;
    }

    if (interaction.type === 2 && interaction.data.name === "link-scoutid") {
      res.json({ type: 5, data: { flags: 64 } });
      scheduleBackground(() => handleLinkCommand(interaction));
      return;
    }

    res.sendStatus(400);
  },
);

async function handleRefreshCommand(interaction) {
  const guildId = interaction.guild_id;
  const token = interaction.token;
  const callerId = interaction.member.user.id;
  const callerPermissions = BigInt(interaction.member.permissions);
  const isAdmin = (callerPermissions & ADMIN_PERMISSION) === ADMIN_PERMISSION;

  const personOption = interaction.data.options?.find(
    (o) => o.name === "person",
  );
  const allOption = interaction.data.options?.find((o) => o.name === "alla");

  try {
    if (allOption?.value === true) {
      // Refresh all users - admin only
      if (!isAdmin) {
        await discord.editInteractionResponse(
          token,
          "Du måste vara admin för att uppdatera alla.",
        );
        return;
      }

      const linkedUsers = await storage.getAllLinkedUsers();
      console.log(
        `Found ${linkedUsers.length} linked users:`,
        linkedUsers.map((u) => `${u.discordUserId} -> ${u.scoutId}`),
      );

      const results = await roles.syncAllUserRoles(guildId);
      if (results.length === 0) {
        await discord.editInteractionResponse(
          token,
          "Inga länkade användare hittades.",
        );
        return;
      }

      const errors = results.filter((r) => r.error);
      const changed = results.filter(
        (r) => !r.error && ((r.added?.length ?? 0) > 0 || (r.removed?.length ?? 0) > 0),
      );
      const unchanged = results.length - errors.length - changed.length;

      const lines = [];
      lines.push(
        `Synkade **${results.length}** användare: ${changed.length} med ändringar, ${errors.length} fel, ${unchanged} oförändrade.`,
      );
      if (changed.length > 0) {
        lines.push("");
        lines.push("**Ändringar:**");
        for (const r of changed) {
          lines.push(`- <@${r.discordUserId}>: ${formatChanges(r)}`);
        }
      }
      if (errors.length > 0) {
        lines.push("");
        lines.push("**Fel:**");
        for (const r of errors) {
          lines.push(`- <@${r.discordUserId}>: ${r.error}`);
        }
      }

      const message = lines.join("\n");
      if (message.length <= 2000) {
        await discord.editInteractionResponse(token, message);
      } else {
        // Build full detailed report as attachment
        const full = [
          `Synkade ${results.length} användare: ${changed.length} med ändringar, ${errors.length} fel, ${unchanged} oförändrade.`,
          "",
          "=== Ändringar ===",
          ...changed.map((r) => `${r.discordUserId}: ${formatChanges(r)}`),
          "",
          "=== Fel ===",
          ...errors.map((r) => `${r.discordUserId}: ${r.error}`),
          "",
          "=== Oförändrade ===",
          ...results
            .filter((r) => !r.error && !changed.includes(r))
            .map((r) => r.discordUserId),
        ].join("\n");
        await discord.editInteractionResponseWithFile(
          token,
          `Synkade ${results.length} användare: ${changed.length} ändringar, ${errors.length} fel. Full lista i bifogad fil.`,
          "refresh-scoutid.txt",
          full,
        );
      }
    } else if (personOption) {
      // Refresh specific person
      const targetUserId = personOption.value;

      if (targetUserId !== callerId && !isAdmin) {
        await discord.editInteractionResponse(
          token,
          "Du måste vara admin för att uppdatera andra.",
        );
        return;
      }

      await storage.clearScoutNetCache();
      const result = await roles.syncUserRoles(guildId, targetUserId);

      if (result.error) {
        await discord.editInteractionResponse(
          token,
          `<@${targetUserId}>: ${result.error}`,
        );
      } else {
        await discord.editInteractionResponse(
          token,
          `<@${targetUserId}>: ${formatChanges(result)}`,
        );
      }
    } else {
      // No arguments - refresh yourself
      await storage.clearScoutNetCache();
      const result = await roles.syncUserRoles(guildId, callerId);

      if (result.error) {
        await discord.editInteractionResponse(
          token,
          `<@${callerId}>: ${result.error}`,
        );
      } else {
        await discord.editInteractionResponse(
          token,
          `<@${callerId}>: ${formatChanges(result)}`,
        );
      }
    }
  } catch (e) {
    console.error("Error handling refresh command:", e);
    await discord.editInteractionResponse(token, `Fel: ${e.message}`);
  }
}

async function handleStatusCommand(interaction) {
  const guildId = interaction.guild_id;
  const token = interaction.token;
  const callerPermissions = BigInt(interaction.member.permissions);
  const isAdmin = (callerPermissions & ADMIN_PERMISSION) === ADMIN_PERMISSION;

  if (!isAdmin) {
    await discord.editInteractionResponse(
      token,
      "Du måste vara admin för att använda det här kommandot.",
    );
    return;
  }

  const targetUserId = interaction.data.options?.find(
    (o) => o.name === "person",
  )?.value;

  // No person argument → server-wide audit summary
  if (!targetUserId) {
    try {
      const result = await audit.runAudit(guildId);
      const summary = audit.summarizeAudit(result);
      await discord.editInteractionResponse(
        token,
        `**Server-status**\n${summary}\n\nKör \`/audit-scoutid\` för full rapport.`,
      );
    } catch (e) {
      console.error("Error handling status summary:", e);
      await discord.editInteractionResponse(token, `Fel: ${e.message}`);
    }
    return;
  }

  try {
    const lines = [];
    lines.push(`**Status för <@${targetUserId}>**`);

    // ScoutID link
    const scoutId = await storage.getLinkedScoutIDUserId(targetUserId);
    if (!scoutId) {
      lines.push("🔴 Inte länkad till ScoutID");
    } else {
      lines.push(`🟢 Länkad till ScoutID: \`${scoutId}\``);

      // ScoutID name (from stored tokens)
      try {
        const scoutIDTokens = await storage.getScoutIDTokens(scoutId);
        if (scoutIDTokens) {
          const scoutIDData = await scoutid.getUserData(scoutIDTokens);
          lines.push(`👤 Namn: ${scoutIDData.name}`);
        }
      } catch (e) {
        lines.push(`👤 Namn: (kunde inte hämta — ${e.message})`);
      }

      // ScoutNet participant info
      if (config.SCOUTNET_EVENT_ID) {
        try {
          const participant = await scoutnet.getParticipant(scoutId);
          if (!participant) {
            lines.push("📋 ScoutNet: Inte registrerad i evenemanget");
          } else if (participant.cancelled_date != null) {
            lines.push(
              `📋 ScoutNet: Avregistrerad (${participant.cancelled_date})`,
            );
          } else {
            const category =
              config.SCOUTNET_FEE_ROLES?.[String(participant.fee_id)] ??
              "(okänd)";
            const divConfig = config.SCOUTNET_DIVISION_ROLES?.[category];
            const division = divConfig
              ? participant.questions?.[divConfig.questionId] || null
              : null;
            lines.push(
              `📋 ScoutNet: fee_id=${participant.fee_id}, kategori=${category}, avdelning=${division ?? "(saknas)"}`,
            );
          }
        } catch (e) {
          lines.push(`📋 ScoutNet: Fel — ${e.message}`);
        }
      }

      // Desired roles
      try {
        const desiredRoles = await roles.getDesiredRoles(scoutId);
        lines.push(`🎯 Förväntade roller: ${desiredRoles.join(", ")}`);
      } catch (e) {
        lines.push(`🎯 Förväntade roller: Fel — ${e.message}`);
      }
    }

    // Current Discord roles
    try {
      const member = await discord.getGuildMember(guildId, targetUserId);
      const guildRoles = await discord.getGuildRoles(guildId);
      const roleMap = Object.fromEntries(guildRoles.map((r) => [r.id, r.name]));
      const memberRoleNames = (member.roles || [])
        .map((id) => roleMap[id] ?? id)
        .sort();
      const nick =
        member.nick || member.user?.global_name || "(inget smeknamn)";
      lines.push(`🏷️ Discord-smeknamn: ${nick}`);
      lines.push(
        memberRoleNames.length > 0
          ? `🎭 Nuvarande roller: ${memberRoleNames.join(", ")}`
          : "🎭 Nuvarande roller: (inga)",
      );
    } catch (e) {
      lines.push(`🎭 Nuvarande roller: Fel — ${e.message}`);
    }

    const message = lines.join("\n");
    await discord.editInteractionResponse(
      token,
      message.length > 2000 ? message.substring(0, 1997) + "..." : message,
    );
  } catch (e) {
    console.error("Error handling status command:", e);
    await discord.editInteractionResponse(token, `Fel: ${e.message}`);
  }
}

async function handleAuditCommand(interaction) {
  const guildId = interaction.guild_id;
  const token = interaction.token;
  const callerPermissions = BigInt(interaction.member.permissions);
  const isAdmin = (callerPermissions & ADMIN_PERMISSION) === ADMIN_PERMISSION;

  if (!isAdmin) {
    await discord.editInteractionResponse(
      token,
      "Du måste vara admin för att använda det här kommandot.",
    );
    return;
  }

  try {
    const result = await audit.runAudit(guildId);
    const message = audit.formatAuditMarkdown(result);
    if (message.length <= 2000) {
      await discord.editInteractionResponse(token, message);
    } else {
      await discord.editInteractionResponseWithFile(
        token,
        `Audit-rapport (${result.totals.issues} avvikelser, full lista i bifogad fil)`,
        "audit-scoutid.txt",
        message,
      );
    }
  } catch (e) {
    console.error("Error handling audit command:", e);
    await discord.editInteractionResponse(token, `Fel: ${e.message}`);
  }
}

async function handleLinkCommand(interaction) {
  const guildId = interaction.guild_id;
  const token = interaction.token;
  const callerPermissions = BigInt(interaction.member.permissions);
  const isAdmin = (callerPermissions & ADMIN_PERMISSION) === ADMIN_PERMISSION;

  if (!isAdmin) {
    await discord.editInteractionResponse(
      token,
      "Du måste vara admin för att använda det här kommandot.",
    );
    return;
  }

  const targetUserId = interaction.data.options.find(
    (o) => o.name === "person",
  ).value;
  const scoutIdInput = interaction.data.options
    .find((o) => o.name === "scoutid")
    .value.trim();

  if (!/^\d+$/.test(scoutIdInput)) {
    await discord.editInteractionResponse(
      token,
      `Ogiltigt scoutid: \`${scoutIdInput}\` — måste vara numeriskt.`,
    );
    return;
  }

  try {
    const messageParts = [];

    const existing = await storage.getLinkedScoutIDUserId(targetUserId);
    if (existing && existing !== scoutIdInput) {
      messageParts.push(
        `⚠️ Var länkad till \`${existing}\`, ersätter med \`${scoutIdInput}\`.`,
      );
    } else if (existing === scoutIdInput) {
      messageParts.push("Redan länkad — tvingar om-synk av roller och smeknamn.");
    }

    let participant = null;
    if (config.SCOUTNET_EVENT_ID) {
      try {
        participant = await scoutnet.getParticipant(scoutIdInput);
        if (!participant) {
          messageParts.push(
            `⚠️ ScoutNet känner inte till member_no \`${scoutIdInput}\` — länkar ändå.`,
          );
        } else if (participant.cancelled_date != null) {
          messageParts.push(
            `⚠️ ScoutNet-deltagaren är avbokad (${participant.cancelled_date}).`,
          );
        }
      } catch (e) {
        messageParts.push(`⚠️ Kunde inte slå upp ScoutNet: ${e.message}`);
      }
    }

    await storage.setLinkedScoutIDUserId(targetUserId, scoutIdInput);
    await storage.clearScoutNetCache();
    const result = await roles.syncUserRoles(guildId, targetUserId);

    if (result.error) {
      messageParts.push(`Fel vid rolluppdatering: ${result.error}`);
    } else {
      messageParts.push(formatChanges(result));
    }

    // Try to re-push Linked Role metadata so Discord can re-assign Scout role.
    // Requires user's OAuth tokens to still be in storage from a previous /linked-role.
    try {
      await updateMetadata(targetUserId);
      messageParts.push("Metadata pushad → Discord uppdaterar Scout-rollen.");
    } catch (e) {
      messageParts.push(
        `⚠️ Kunde inte pusha metadata (Scout-rollen kan behöva re-verifieras via \`/linked-role\`): ${e.message}`,
      );
    }

    await discord.editInteractionResponse(
      token,
      `<@${targetUserId}>: Länkad till scoutid \`${scoutIdInput}\`. ${messageParts.join(" ")}`,
    );
  } catch (e) {
    console.error("Error handling link command:", e);
    await discord.editInteractionResponse(token, `Fel: ${e.message}`);
  }
}

function normalizeName(s) {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

function formatChanges({ added, removed }) {
  const parts = [];
  if (added?.length > 0) parts.push(`Lade till: ${added.join(", ")}`);
  if (removed?.length > 0) parts.push(`Tog bort: ${removed.join(", ")}`);
  if (parts.length === 0) return "Inga ändringar";
  return parts.join(". ");
}

// --- Helper functions ---

async function updateMetadata(discordUserId) {
  const scoutId = await storage.getLinkedScoutIDUserId(discordUserId);
  if (!scoutId) throw new Error("ingen storage-länk");

  const discordTokens = await storage.getDiscordTokens(discordUserId);
  if (!discordTokens) {
    throw new Error("Discord OAuth-tokens saknas i storage");
  }

  let metadata = { scoutid: scoutId };
  try {
    const scoutIDTokens = await storage.getScoutIDTokens(scoutId);
    if (scoutIDTokens) {
      const scoutIDData = await scoutid.getUserData(scoutIDTokens);
      metadata = {
        scoutid: scoutIDData.scoutid,
        email: scoutIDData.email,
        name: scoutIDData.name,
      };
    }
  } catch (e) {
    console.error(`Error fetching ScoutID data: ${e.message}`);
  }

  await discord.pushMetadata(discordUserId, discordTokens, metadata);
}

async function updateNickname(userId, nickname) {
  try {
    if (nickname.length > 32) nickname = nickname.substring(0, 32);

    const guildId = config.DISCORD_GUILD_ID;
    if (guildId) {
      await discord.updateGuildMemberNickname(guildId, userId, nickname);
    } else {
      const discordTokens = await storage.getDiscordTokens(userId);
      if (!discordTokens) return;
      const guilds = await discord.getUserGuilds(discordTokens);
      for (const guild of guilds) {
        await discord.updateGuildMemberNickname(guild.id, userId, nickname);
      }
    }
  } catch (e) {
    console.error(`Error updating nickname for ${userId}:`, e.message);
  }
}

async function addDiscordRoles(userId, roleNames) {
  try {
    const guildId = config.DISCORD_GUILD_ID;
    if (!guildId) return;

    const guildRoles = await discord.getGuildRoles(guildId);
    const roleMap = new Map();
    for (const role of guildRoles) {
      roleMap.set(role.name.toLowerCase(), role);
    }

    console.log(`Assigning roles [${roleNames.join(", ")}] to user ${userId}`);
    for (const roleName of roleNames) {
      const role = roleMap.get(roleName.toLowerCase());
      if (role) {
        try {
          await discord.addRoleToUser(guildId, userId, role.id);
          console.log(
            `Added role "${roleName}" (${role.id}) to user ${userId}`,
          );
        } catch (e) {
          console.error(
            `Failed to add role "${roleName}" (${role.id}) to user ${userId}: ${e.message} (bot role may be too low in hierarchy)`,
          );
        }
      } else {
        console.warn(
          `Role "${roleName}" not found in guild — create it in Discord`,
        );
      }
    }
  } catch (e) {
    console.error(`Error adding roles for ${userId}:`, e.message);
  }
}

const port = process.env.PORT || 3000;
const server = app.listen(port, () => {
  console.log(`App listening on port ${port}`);
});

// --- Graceful shutdown ---
//
// Kubernetes sends SIGTERM, then SIGKILLs after terminationGracePeriodSeconds
// (60). The preStop hook spends the first 10 of those keeping the pod in
// service while its endpoint removal propagates, so the budget here is ~50s —
// stay under it and always exit on our own terms.
//
// Node installs no default SIGTERM handler, and as PID 1 it would otherwise
// ignore the signal entirely and wait for the SIGKILL. This handler is what
// makes terminationGracePeriodSeconds mean anything.
const SHUTDOWN_TIMEOUT_MS = 40_000;

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, draining`);

  // Backstop: never let a wedged request or hung fetch hold the pod open past
  // the grace period, where it would be SIGKILLed mid-write instead.
  const forceExit = setTimeout(() => {
    console.error(
      `Drain exceeded ${SHUTDOWN_TIMEOUT_MS}ms, exiting with work outstanding`,
    );
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  // Stop accepting new connections. Idle keep-alives are closed explicitly —
  // server.close() alone waits for them and would stall the whole drain.
  const closed = new Promise((resolve) => server.close(resolve));
  server.closeIdleConnections();

  closed
    .then(() => {
      if (pendingWork.size > 0) {
        console.log(`waiting for ${pendingWork.size} background task(s)`);
      }
      return Promise.allSettled([...pendingWork]);
    })
    .then(() => {
      console.log("drain complete, exiting");
      process.exit(0);
    })
    .catch((e) => {
      console.error("error while draining:", e);
      process.exit(1);
    });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
