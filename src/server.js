import express from "express";
import cookieParser from "cookie-parser";

import config from "./config.js";
import * as discord from "./discord.js";
import * as scoutid from "./scoutid.js";
import * as scoutnet from "./scoutnet.js";
import * as storage from "./storage.js";
import * as roles from "./roles.js";
import * as audit from "./audit.js";
import * as adoption from "./adoption.js";
import * as eventlog from "./eventlog.js";
import { updateMetadata, RELINK_INSTRUCTION } from "./metadata.js";
import { runMemberScan, formatScanSummary } from "./memberscan.js";
import { getSuccessPageHTML } from "./templates.js";

const app = express();
app.use(cookieParser(config.COOKIE_SECRET));

// --- Health checks ---
//
// Three routes, and the difference between them is the point.
//
// `/` is the landing page a human might hit, and stays exactly what it was.
//
// `/healthz` is liveness, and deliberately depends on nothing outside the
// process. Liveness restarts the pod, so hanging it on Table Storage would
// turn a storage blip into every replica restarting at once — a degraded
// service made into no service.
//
// `/readyz` is readiness, and does depend on storage, because a pod that
// cannot reach the table answers every interaction with an error and taking it
// out of the endpoint list is precisely right. Two consequences worth knowing
// before changing it: with `maxUnavailable: 0` a cluster-wide storage outage
// also blocks rollouts, which is the correct answer to "should we deploy into
// this?" but surprising in the moment; and the probe's `failureThreshold` is
// what keeps a single slow request from evicting a healthy pod.

app.get("/", (req, res) => {
  res.send("👋");
});

app.get("/healthz", (req, res) => {
  res.type("text/plain").send("ok");
});

// The probe fires every 10s per pod. The result is cached for slightly less
// than that so a burst of probes cannot become a burst of storage requests,
// and the in-flight promise is shared so a *hung* table does not stack probes
// on top of each other until the pod runs out of sockets.
const READY_CACHE_MS = 5000;
const READY_TIMEOUT_MS = 3000;
let readyCache = { at: 0, ok: false, error: null };
let readyInFlight = null;

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} svarade inte inom ${ms} ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    // Without this the timer keeps the event loop alive for its full duration,
    // which at shutdown means the process lingers for no reason.
    clearTimeout(timer);
  }
}

async function probeStorage() {
  try {
    await withTimeout(storage.ping(), READY_TIMEOUT_MS, "Table Storage");
    readyCache = { at: Date.now(), ok: true, error: null };
  } catch (e) {
    readyCache = { at: Date.now(), ok: false, error: e.message };
  }
  return readyCache;
}

async function isReady() {
  if (Date.now() - readyCache.at < READY_CACHE_MS) return readyCache;
  readyInFlight ??= probeStorage().finally(() => {
    readyInFlight = null;
  });
  return readyInFlight;
}

app.get("/readyz", async (req, res) => {
  const { ok, error } = await isReady();
  if (ok) {
    res.type("text/plain").send("ready");
    return;
  }
  // The reason goes to the log, not to the body: the ingress routes `/` as a
  // prefix, so this route answers the public internet, and Azure's errors carry
  // endpoint names and request ids. A probe only needs the status code.
  console.error(`Readiness check failed: ${error}`);
  res.status(503).type("text/plain").send("storage unreachable");
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

    // ScoutID's tokens are deliberately **not** stored. Nothing could use them:
    // the access token expires within the hour and nothing refreshes it, so every
    // later call failed (16 of 16, measured 2026-08-20). An OAuth credential kept
    // at rest that protects nothing is pure liability — it sits in the table and
    // in every backup. What the flow needed from ScoutID it has already taken:
    // the scoutid, read from a token that was seconds old.
    //
    // Existing `scoutid-token` rows are inert. They can be dropped whenever.

    // Link accounts and push metadata
    await storage.setLinkedScoutIDUserId(discordUserId, scoutIDUser.scoutid);
    await updateMetadata(discordUserId);

    // Assign Discord roles
    let assignedRoles = [];
    try {
      const guildId = config.DISCORD_GUILD_ID;
      if (guildId) {
        // `allowIncomplete`: this path only ever adds roles, so a ScoutNet
        // outage must not fail a verification that otherwise succeeded. The
        // user gets the Scout marker now and the rest at the next sync. Every
        // other caller wants the throw — see getDesiredRoles.
        const desiredRoles = await roles.getDesiredRoles(scoutIDUser.scoutid, {
          allowIncomplete: true,
        });
        if (desiredRoles.length > 0) {
          // What came back, not what was asked for. `scout` is always in the
          // wish list and can never be in the result — it is a managed Linked
          // Role that Discord alone grants — so claiming it was assigned made
          // the log line say the opposite of what happened, in exactly the case
          // worth noticing.
          assignedRoles = await addDiscordRoles(discordUserId, desiredRoles);
        }
      }
    } catch (e) {
      console.error(`Error assigning roles for ${discordUserId}:`, e.message);
    }

    // Update nickname with role suffix
    if (scoutIDUser.name) {
      // Lenient for the same reason, and here it is load-bearing: this call is
      // not wrapped in its own try, so a throw would reach the outer handler
      // and answer a successful linking with a 500 page.
      const suffix = await roles.getNicknameSuffix(scoutIDUser.scoutid, {
        allowIncomplete: true,
      });
      await updateNickname(discordUserId, scoutIDUser.name + suffix);
    }

    eventlog.logLinked({
      discordUserId,
      scoutId: scoutIDUser.scoutid,
      name: scoutIDUser.name,
      roles: assignedRoles,
    });

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

    if (interaction.type === 2 && interaction.data.name === "scan-scoutid") {
      res.json({ type: 5, data: { flags: 64 } });
      scheduleBackground(() => handleScanCommand(interaction));
      return;
    }

    if (
      interaction.type === 2 &&
      interaction.data.name === "adoption-scoutid"
    ) {
      res.json({ type: 5, data: { flags: 64 } });
      scheduleBackground(() => handleAdoptionCommand(interaction));
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
  const dryRun =
    interaction.data.options?.find((o) => o.name === "dryrun")?.value === true;

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

      const results = await roles.syncAllUserRoles(guildId, { dryRun });
      // A dry run leaves no trace in the event log: that channel is the record
      // of what the bot *did*, and writing "would have" lines into it makes the
      // history unreliable for the one question it exists to answer.
      if (!dryRun) eventlog.logSyncAll({ callerId, results });
      if (results.length === 0) {
        await discord.editInteractionResponse(
          token,
          "Inga länkade användare hittades.",
        );
        return;
      }

      const errors = results.filter((r) => r.error);
      // A rename is a change here too — it is the change users notice first.
      const changed = results.filter(
        (r) =>
          !r.error &&
          ((r.added?.length ?? 0) > 0 ||
            (r.removed?.length ?? 0) > 0 ||
            Boolean(r.nickname)),
      );
      const unchanged = results.length - errors.length - changed.length;
      const prefix = dryRun ? "**Dry run — inget ändrades.** " : "";

      const lines = [];
      lines.push(
        `${prefix}Synkade **${results.length}** användare: ${changed.length} med ändringar, ${errors.length} fel, ${unchanged} oförändrade.`,
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
      const result = await roles.syncUserRoles(guildId, targetUserId, {
        dryRun,
      });
      if (!dryRun) {
        eventlog.logSync({ discordUserId: targetUserId, callerId, result });
      }

      if (result.error) {
        await discord.editInteractionResponse(
          token,
          `<@${targetUserId}>: ${result.error}`,
        );
      } else {
        await discord.editInteractionResponse(
          token,
          `${prefixFor(dryRun)}<@${targetUserId}>: ${formatChanges(result)}`,
        );
      }
    } else {
      // No arguments - refresh yourself
      await storage.clearScoutNetCache();
      const result = await roles.syncUserRoles(guildId, callerId, { dryRun });
      if (!dryRun) {
        eventlog.logSync({ discordUserId: callerId, callerId, result });
      }

      if (result.error) {
        await discord.editInteractionResponse(
          token,
          `<@${callerId}>: ${result.error}`,
        );
      } else {
        await discord.editInteractionResponse(
          token,
          `${prefixFor(dryRun)}<@${callerId}>: ${formatChanges(result)}`,
        );
      }
    }
  } catch (e) {
    console.error("Error handling refresh command:", e);
    await discord.editInteractionResponse(token, `Fel: ${e.message}`);
  }
}

async function handleAdoptionCommand(interaction) {
  const token = interaction.token;
  const callerPermissions = BigInt(interaction.member.permissions);
  if ((callerPermissions & ADMIN_PERMISSION) !== ADMIN_PERMISSION) {
    await discord.editInteractionResponse(
      token,
      "Du måste vara admin för att använda det här kommandot.",
    );
    return;
  }

  const includeMissing =
    interaction.data.options?.find((o) => o.name === "saknas")?.value === true;

  try {
    const result = await adoption.runAdoption();
    const summary = adoption.formatAdoptionSummary(result);
    // Always a file as well: the per-group breakdown is 130 lines at full size,
    // and it is the breakdown, not the total, that someone acts on.
    await discord.editInteractionResponseWithFile(
      token,
      summary,
      "adoption-scoutid.txt",
      adoption.formatAdoptionText(result, { includeMissing }),
    );
  } catch (e) {
    console.error("Error handling adoption command:", e);
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

  // `person` is a required option, so Discord rejects the command without one.
  // It used to fall back to `runAudit()` plus its summary here — the same
  // computation over the same data as `/audit-scoutid`, only shorter, which made
  // two commands answer one question and neither of them clearly.
  if (!targetUserId) {
    await discord.editInteractionResponse(
      token,
      "Ange `person`. För serverbilden: `/audit-scoutid` (avvikelser) eller `/adoption-scoutid` (hur många som länkat sig).",
    );
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

      // The name comes from ScoutNet, not ScoutID.
      //
      // This used to fetch it with the stored ScoutID token, which is dead for
      // every link in the table because nothing refreshes it — so the line was
      // always `👤 Namn: (kunde inte hämta — Unexpected token '<' …)`. ScoutNet's
      // name is also the one that matters: it is what the nickname is built from
      // and what the audit compares against.
      //
      // The scoutid stays on its own line above, deliberately: when ScoutNet has
      // nothing to show — not registered, or the event id unset — that number is
      // what lets a leader look the person up in ScoutNet by hand.
      if (config.SCOUTNET_EVENT_ID) {
        try {
          const participant = await scoutnet.getParticipant(scoutId);
          const fullName = participant
            ? [participant.first_name, participant.last_name]
                .filter(Boolean)
                .join(" ")
                .trim()
            : "";
          if (fullName) lines.push(`👤 Namn: ${fullName} (från ScoutNet)`);
          if (!participant) {
            lines.push("📋 ScoutNet: Inte registrerad i evenemanget");
          } else if (scoutnet.isCancelled(participant)) {
            lines.push(
              `📋 ScoutNet: Avregistrerad (${scoutnet.cancelledLabel(participant)})`,
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
      // The attachment gets the plain-text rendering: Discord renders markup and
      // mentions in a message, never in a file, so the markdown version arrives
      // as literal `__…__` and raw numeric ids.
      await discord.editInteractionResponseWithFile(
        token,
        `Audit-rapport: ${result.totals.issues} fynd hos ${result.totals.affectedUsers} personer — full lista i bifogad fil`,
        "audit-scoutid.txt",
        audit.formatAuditText(result),
      );
    }
  } catch (e) {
    console.error("Error handling audit command:", e);
    await discord.editInteractionResponse(token, `Fel: ${e.message}`);
  }
}

/**
 * `/scan-scoutid` — run the member scan now instead of waiting for the CronJob.
 *
 * The detail lines go to #server-logg like a scheduled run; the reply is the
 * summary. A manual run can overlap the CronJob, and the worst case is that the
 * same change is reported twice — which is the trade this whole log makes
 * deliberately, since the alternative is a missing entry.
 */
async function handleScanCommand(interaction) {
  const token = interaction.token;
  const callerId = interaction.member.user.id;
  const callerPermissions = BigInt(interaction.member.permissions);
  const isAdmin = (callerPermissions & ADMIN_PERMISSION) === ADMIN_PERMISSION;

  if (!isAdmin) {
    await discord.editInteractionResponse(
      token,
      "Du måste vara admin för att använda det här kommandot.",
    );
    return;
  }

  const dryRun =
    interaction.data.options?.find((o) => o.name === "dryrun")?.value === true;

  try {
    const result = await runMemberScan({ dryRun });
    if (!dryRun && !result.disabled) {
      eventlog.logEvent(
        `🔎 <@${callerId}> körde \`/scan-scoutid\` — ${result.seeded != null ? `baslinje för ${result.seeded} medlemmar` : `${result.total} ändring(ar)`}`,
      );
    }

    // A dry run posts nothing, so the lines have to come back in the reply or
    // they are lost — the whole point is seeing them before they are written.
    let reply = formatScanSummary(result);
    const lines = result.lines ?? [];
    if (lines.length > 0) {
      const body = lines.join("\n");
      reply +=
        body.length <= 1600
          ? `\n\n${body}`
          : `\n\n${lines.length} rader, för långa för ett svar — kör \`node src/memberscan.js --dry-run\` för hela listan.`;
    }
    await discord.editInteractionResponse(token, reply);
  } catch (e) {
    console.error("Error handling scan command:", e);
    await discord.editInteractionResponse(
      token,
      `Fel vid scanning: ${e.message}`,
    );
  }
}

async function handleLinkCommand(interaction) {
  const guildId = interaction.guild_id;
  const token = interaction.token;
  const callerId = interaction.member.user.id;
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
      messageParts.push(
        "Redan länkad — tvingar om-synk av roller och smeknamn.",
      );
    }

    let participant = null;
    if (config.SCOUTNET_EVENT_ID) {
      try {
        participant = await scoutnet.getParticipant(scoutIdInput);
        if (!participant) {
          messageParts.push(
            `⚠️ ScoutNet känner inte till member_no \`${scoutIdInput}\` — länkar ändå.`,
          );
        } else if (scoutnet.isCancelled(participant)) {
          messageParts.push(
            `⚠️ ScoutNet-deltagaren är avbokad (${scoutnet.cancelledLabel(participant)}).`,
          );
        }
      } catch (e) {
        messageParts.push(`⚠️ Kunde inte slå upp ScoutNet: ${e.message}`);
      }
    }

    await storage.setLinkedScoutIDUserId(targetUserId, scoutIdInput);
    await storage.clearScoutNetCache();
    const result = await roles.syncUserRoles(guildId, targetUserId);

    // Who linked whom is the part worth keeping: a manual link is an admin
    // vouching for an identity the OAuth flow never confirmed.
    eventlog.logManualLink({
      discordUserId: targetUserId,
      scoutId: scoutIdInput,
      previousScoutId: existing && existing !== scoutIdInput ? existing : null,
      callerId,
      result,
    });

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
        `⚠️ Kunde inte pusha metadata — hen kan behöva ${RELINK_INSTRUCTION}: ${e.message}`,
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

/** Marks a reply that describes what *would* happen rather than what did. */
function prefixFor(dryRun) {
  return dryRun ? "**Dry run — inget ändrades.** " : "";
}

function formatChanges({ added, removed }) {
  const parts = [];
  if (added?.length > 0) parts.push(`Lade till: ${added.join(", ")}`);
  if (removed?.length > 0) parts.push(`Tog bort: ${removed.join(", ")}`);
  if (parts.length === 0) return "Inga ändringar";
  return parts.join(". ");
}

// --- Helper functions ---

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

/**
 * Grant roles on the linking path. Returns the names actually granted.
 *
 * Skips managed roles, which `syncUserRoles` has always done and this had not:
 * `scout` is a managed Linked Role, so every link attempted to add it, got a
 * guaranteed error from Discord, and buried it in a `console.error` about the
 * bot's hierarchy position — a misleading message for something that was never
 * possible in the first place.
 *
 * Note what this deliberately does *not* do: apply the verification gate. It
 * cannot. Discord grants the Linked Role after the user finishes on its side,
 * which is after this code has run and the success page has rendered, so a check
 * here would fail for every first-time link. The asymmetry with `syncUserRoles`
 * is therefore real and unavoidable — what is fixed is that the report no longer
 * claims otherwise.
 */
async function addDiscordRoles(userId, roleNames) {
  const granted = [];
  try {
    const guildId = config.DISCORD_GUILD_ID;
    if (!guildId) return granted;

    const guildRoles = await discord.getGuildRoles(guildId);
    const roleMap = new Map();
    for (const role of guildRoles) {
      roleMap.set(role.name.toLowerCase(), role);
    }

    console.log(`Assigning roles [${roleNames.join(", ")}] to user ${userId}`);
    for (const roleName of roleNames) {
      const role = roleMap.get(roleName.toLowerCase());
      if (role?.managed) {
        console.log(
          `Skipping managed role "${roleName}" — Discord grants it, not the bot`,
        );
      } else if (role) {
        try {
          await discord.addRoleToUser(guildId, userId, role.id);
          granted.push(roleName);
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
  return granted;
}

// Exported so tests can drive the routes without the module taking over the
// process. Everything below only happens when this file is the entrypoint —
// under `node src/server.js`, which is what the Dockerfile's exec-form CMD runs.
// Importing it binds no port and installs no signal handler.
export { app };

const isEntrypoint = process.argv[1]?.endsWith("server.js");

const port = process.env.PORT || 3000;
let server = null;
if (isEntrypoint) {
  server = app.listen(port, () => {
    console.log(`App listening on port ${port}`);
  });
}

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
      // Event-log lines are buffered for a few seconds before being written, so
      // they have to be flushed *after* the background work that produces them.
      // Ordering matters: flushing first would miss whatever a slash command
      // logs on its way out.
      // It swallows its own errors, but a rejection here would exit 1 and make
      // a clean rollout look like a failed one.
      return eventlog.flushEventLog().catch(() => {});
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

if (isEntrypoint) {
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
