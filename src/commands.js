import config from "./config.js";
import * as discord from "./discord.js";
import * as scoutnet from "./scoutnet.js";
import * as storage from "./storage.js";
import * as roles from "./roles.js";
import * as audit from "./audit.js";
import * as adoption from "./adoption.js";
import * as eventlog from "./eventlog.js";
import { updateMetadata, RELINK_INSTRUCTION } from "./metadata.js";
import { runMemberScan, formatScanSummary } from "./memberscan.js";
import { displayName, guildNick, partitionResults } from "./guild.js";

/**
 * The slash commands, one handler each. `handlers` is what server.js dispatches
 * on after acknowledging the interaction. One command per question, and the verb
 * is the contract:
 *
 *   /refresh-scoutid    changes   what the roles should be, and sets them
 *   /audit-scoutid      reads     what is inconsistent, right now
 *   /adoption-scoutid   reads     how many of the registered have linked
 *   /status-scoutid     reads     everything the bot knows about one person
 *   /scan-scoutid       changes   what has happened since the last run
 */

const ADMIN_PERMISSION = 0x8n;
const MAX_MESSAGE_CHARS = 2000;

const isAdmin = (interaction) =>
  (BigInt(interaction.member.permissions) & ADMIN_PERMISSION) ===
  ADMIN_PERMISSION;

const option = (interaction, name) =>
  interaction.data.options?.find((o) => o.name === name)?.value;

const flag = (interaction, name) => option(interaction, name) === true;

// A Discord snowflake as the client renders it: 17-20 digits, no formatting.
const SNOWFLAKE = /^\d{17,20}$/;

/**
 * The person a command acts on, from `person` (the picker) or `personid` (a raw
 * id typed by hand).
 *
 * `personid` exists because the picker cannot reach everyone: a member who has
 * not accepted the rules gate is `pending`, and Discord hides those from every
 * user picker and mention autocomplete. They are in the guild, they can hold a
 * link, roles and a nickname — so the one group an admin most often needs to
 * repair is the one the picker refuses to offer.
 *
 * Returns `{ id }` or `{ error }`; the caller replies with the error as-is.
 */
export function targetUser(interaction, { fallback = null, missing } = {}) {
  const picked = option(interaction, "person");
  const typed = option(interaction, "personid");

  if (picked && typed != null)
    return {
      error:
        "Ange antingen `person` eller `personid`, inte båda — de kan peka på olika personer.",
    };

  if (typed != null) {
    const id = String(typed).trim();
    return SNOWFLAKE.test(id)
      ? { id }
      : {
          error: `Ogiltigt \`personid\`: \`${id}\` — ett Discord user-id är 17–20 siffror. Högerklicka på personen och välj *Kopiera användar-ID* (kräver utvecklarläge).`,
        };
  }

  if (picked) return { id: picked };
  return fallback ? { id: fallback } : { error: missing };
}

/**
 * A clause naming the rules gate when the member has not passed it. Such a
 * member takes roles and a nickname normally and still sees no channel at all,
 * so a sync that worked and a sync that did nothing look identical from the
 * outside — this is what separates them. Never throws: it annotates a reply
 * that is already correct without it.
 */
async function pendingNote(guildId, userId) {
  try {
    const member = await discord.getGuildMember(guildId, userId);
    return member?.pending
      ? " ⏳ Hen har inte accepterat serverns regler än, och ser därför inga kanaler oavsett roller."
      : "";
  } catch {
    return "";
  }
}

const reply = (token, content) =>
  discord.editInteractionResponse(token, content);

/**
 * Reply inline when it fits, as a file when it does not. Discord renders
 * `**bold**` and `<@id>` in a message and neither in an attachment, so callers
 * pass two renderings — the file gets plain text with names resolved.
 */
function replyOrAttach(token, message, { filename, summary, full }) {
  if (message.length <= MAX_MESSAGE_CHARS) return reply(token, message);
  return discord.editInteractionResponseWithFile(
    token,
    summary,
    filename,
    full,
  );
}

/**
 * Wrap a handler with the admin gate and a catch-all reply. The gate runs after
 * the interaction is acknowledged, so a rejection arrives as an edit to the
 * deferred response rather than as a status code.
 */
function handler(fn, { admin = false, errorPrefix = "Fel" } = {}) {
  return async (interaction) => {
    const token = interaction.token;
    try {
      if (admin && !isAdmin(interaction)) {
        await reply(
          token,
          "Du måste vara admin för att använda det här kommandot.",
        );
        return;
      }
      await fn(interaction, {
        token,
        guildId: interaction.guild_id,
        callerId: interaction.member.user.id,
        // The interaction carries the invoking member, so a log line that names
        // the caller costs no lookup. Without it the line is a bare mention,
        // which most clients render as `@okänd-användare`.
        callerName: displayName(interaction.member) || null,
      });
    } catch (e) {
      console.error(`Error handling /${interaction.data.name}:`, e);
      await reply(token, `${errorPrefix}: ${e.message}`);
    }
  };
}

// --- Shared rendering ---

/** `{ added, removed }` from a sync → a clause an admin reads in the reply. */
export function formatChanges({ added, removed, nickname }) {
  const parts = [];
  if (added?.length > 0) parts.push(`Lade till: ${added.join(", ")}`);
  if (removed?.length > 0) parts.push(`Tog bort: ${removed.join(", ")}`);
  // The nickname has to be here because `changedAnything` counts it: a member
  // whose only change is the rename lands in the "changed" list, and without
  // this line the report says "240 med ändringar" and then prints "Inga
  // ändringar" 240 times. That is what a suffix change looks like — every
  // member moves, no role does — so the dry run meant to preview it showed
  // nothing at all.
  if (nickname) parts.push(`Smeknamn: ${nickname}`);
  return parts.length > 0 ? parts.join(". ") : "Inga ändringar";
}

/**
 * The sync's own explanation for having nothing to give. "Inga ändringar" is true
 * both for a member who has every role and one who is verified but not in the
 * event — opposite situations, and the note is what separates them.
 */
const noteFor = ({ note } = {}) => (note ? ` — ${note}` : "");

/** Marks a reply that describes what *would* happen rather than what did. */
const dryRunPrefix = (dryRun) =>
  dryRun ? "**Dry run — inget ändrades.** " : "";

/**
 * The same marker for an attachment, without markup — Discord renders nothing
 * inside a file, so the bold form arrives as literal asterisks.
 *
 * The file needs its own copy because it is the half that outlives the
 * exchange: over 2000 characters the report becomes an attachment, and the
 * attachment is what gets saved, pasted and forwarded. Without this line a
 * dry run's file is indistinguishable from a real run's, and the question it
 * leaves open — were 240 people just renamed? — cannot be answered from the
 * report at all.
 */
export const dryRunPlain = (dryRun) =>
  dryRun
    ? "DRY RUN — inget ändrades. Listan visar vad som skulle hända.\n\n"
    : "";

// --- /refresh-scoutid ---

/**
 * Sync one member, or the whole server with `alla:true`. Not admin-gated as a
 * whole — anyone may refresh themselves; someone else or everyone needs admin.
 */
const refresh = handler(
  async (interaction, { token, guildId, callerId, callerName }) => {
    const dryRun = flag(interaction, "dryrun");

    if (flag(interaction, "alla")) {
      if (!isAdmin(interaction)) {
        await reply(token, "Du måste vara admin för att uppdatera alla.");
        return;
      }
      await refreshEveryone(token, guildId, callerId, callerName, dryRun);
      return;
    }

    const { id: targetUserId, error } = targetUser(interaction, {
      fallback: callerId,
    });
    if (error) {
      await reply(token, error);
      return;
    }
    if (targetUserId !== callerId && !isAdmin(interaction)) {
      await reply(token, "Du måste vara admin för att uppdatera andra.");
      return;
    }

    await storage.clearScoutNetCache();
    const result = await roles.syncUserRoles(guildId, targetUserId, { dryRun });
    // A dry run leaves no trace in the event log: that channel records what the
    // bot *did*, and "would have" lines make it unreliable for that question.
    if (!dryRun) {
      eventlog.logSync({
        discordUserId: targetUserId,
        callerId,
        callerName,
        result,
      });
    }

    await reply(
      token,
      result.error
        ? `<@${targetUserId}>: ${result.error}`
        : `${dryRunPrefix(dryRun)}<@${targetUserId}>: ${formatChanges(result)}${noteFor(result)}` +
            (await pendingNote(guildId, targetUserId)),
    );
  },
);

async function refreshEveryone(token, guildId, callerId, callerName, dryRun) {
  const results = await roles.syncAllUserRoles(guildId, { dryRun });
  if (!dryRun) eventlog.logSyncAll({ callerId, callerName, results });

  if (results.length === 0) {
    await reply(token, "Inga länkade användare hittades.");
    return;
  }

  const { changed, errors } = partitionResults(results);
  const unchanged = results.length - errors.length - changed.length;
  const tally = `${changed.length} med ändringar, ${errors.length} fel, ${unchanged} oförändrade.`;

  const lines = [
    `${dryRunPrefix(dryRun)}Synkade **${results.length}** användare: ${tally}`,
  ];
  if (changed.length > 0) {
    lines.push("", "**Ändringar:**");
    for (const r of changed) {
      lines.push(`- <@${r.discordUserId}>: ${formatChanges(r)}`);
    }
  }
  if (errors.length > 0) {
    lines.push("", "**Fel:**");
    for (const r of errors) {
      lines.push(`- <@${r.discordUserId}>: ${r.error}`);
    }
  }

  await replyOrAttach(token, lines.join("\n"), {
    filename: "refresh-scoutid.txt",
    summary: `${dryRunPrefix(dryRun)}Synkade ${results.length} användare: ${changed.length} ändringar, ${errors.length} fel. Full lista i bifogad fil.`,
    full: [
      `${dryRunPlain(dryRun)}Synkade ${results.length} användare: ${tally}`,
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
    ].join("\n"),
  });
}

// --- /status-scoutid ---

/** Everything the bot knows about one person, from all three sources. */
const status = handler(
  async (interaction, { token, guildId }) => {
    const { id: targetUserId, error } = targetUser(interaction, {
      missing:
        "Ange `person`, eller `personid` för den som inte syns i listan. För serverbilden: `/audit-scoutid` (avvikelser) eller `/adoption-scoutid` (hur många som länkat sig).",
    });
    if (error) {
      await reply(token, error);
      return;
    }

    const lines = [`**Status för <@${targetUserId}>**`];

    const scoutId = await storage.getLinkedScoutIDUserId(targetUserId);
    if (!scoutId) {
      lines.push("🔴 Inte länkad till ScoutID");
    } else {
      lines.push(`🟢 Länkad till ScoutID: \`${scoutId}\``);
      // The scoutid stays on its own line above: when ScoutNet has nothing to
      // show, that number is what lets a leader look the person up by hand.
      if (config.SCOUTNET_EVENT_ID)
        lines.push(...(await scoutNetLines(scoutId)));

      try {
        lines.push(
          `🎯 Förväntade roller: ${(await roles.getDesiredRoles(scoutId)).join(", ")}`,
        );
      } catch (e) {
        lines.push(`🎯 Förväntade roller: Fel — ${e.message}`);
      }
    }

    try {
      const member = await discord.getGuildMember(guildId, targetUserId);
      const guildRoles = await discord.getGuildRoles(guildId);
      const byId = new Map(guildRoles.map((r) => [r.id, r.name]));
      const names = (member.roles || []).map((id) => byId.get(id) ?? id).sort();
      lines.push(
        `🏷️ Discord-smeknamn: ${guildNick(member) || "(inget smeknamn)"}`,
      );
      lines.push(
        names.length > 0
          ? `🎭 Nuvarande roller: ${names.join(", ")}`
          : "🎭 Nuvarande roller: (inga)",
      );
      // Worth its own line rather than a footnote: it explains both why the
      // person sees nothing and why the picker would not offer them.
      if (member.pending)
        lines.push(
          "⏳ Har inte accepterat serverns regler — ser inga kanaler oavsett roller, och syns inte i personväljaren",
        );
    } catch (e) {
      lines.push(`🎭 Nuvarande roller: Fel — ${e.message}`);
    }

    const message = lines.join("\n");
    await reply(
      token,
      message.length > MAX_MESSAGE_CHARS
        ? message.substring(0, MAX_MESSAGE_CHARS - 3) + "..."
        : message,
    );
  },
  { admin: true },
);

/** The ScoutNet half of `/status-scoutid`: registration, category, division. */
async function scoutNetLines(scoutId) {
  const lines = [];
  try {
    const participant = await scoutnet.getParticipant(scoutId);
    const name = scoutnet.fullName(participant);
    if (name) lines.push(`👤 Namn: ${name} (från ScoutNet)`);

    if (!participant) {
      lines.push("📋 ScoutNet: Inte registrerad i evenemanget");
    } else if (scoutnet.isCancelled(participant)) {
      lines.push(
        `📋 ScoutNet: Avregistrerad (${scoutnet.cancelledLabel(participant)})`,
      );
    } else {
      const category =
        config.SCOUTNET_FEE_ROLES?.[String(participant.fee_id)] ?? "(okänd)";
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
  return lines;
}

// --- /audit-scoutid ---

const auditCommand = handler(
  async (interaction, { token, guildId }) => {
    const result = await audit.runAudit(guildId);
    await replyOrAttach(token, audit.formatAuditMarkdown(result), {
      filename: "audit-scoutid.txt",
      summary: `Audit-rapport: ${result.totals.issues} fynd hos ${result.totals.affectedUsers} personer — full lista i bifogad fil`,
      full: audit.formatAuditText(result),
    });
  },
  { admin: true },
);

// --- /adoption-scoutid ---

const adoptionCommand = handler(
  async (interaction, { token }) => {
    const result = await adoption.runAdoption();
    // Always a file as well: the per-group breakdown is 130 lines at full size,
    // and it is the breakdown, not the total, that someone acts on.
    await discord.editInteractionResponseWithFile(
      token,
      adoption.formatAdoptionSummary(result),
      "adoption-scoutid.txt",
      adoption.formatAdoptionText(result, {
        includeMissing: flag(interaction, "saknas"),
      }),
    );
  },
  { admin: true },
);

// --- /scan-scoutid ---

/**
 * Run the member scan now instead of waiting for the CronJob. Detail lines go to
 * #server-logg like a scheduled run; the reply is the summary. A manual run may
 * overlap the CronJob, whose worst case is a change reported twice.
 */
const scan = handler(
  async (interaction, { token, callerId, callerName }) => {
    const dryRun = flag(interaction, "dryrun");
    const result = await runMemberScan({ dryRun });

    if (!dryRun && !result.disabled) {
      const what =
        result.seeded != null
          ? `baslinje för ${result.seeded} medlemmar`
          : `${result.total} ändring(ar)`;
      eventlog.logScanRun({ callerId, callerName, what });
    }

    // A dry run posts nothing, so its lines have to come back in the reply or
    // they are lost — seeing them before they are written is the whole point.
    let text = formatScanSummary(result);
    const lines = result.lines ?? [];
    if (lines.length > 0) {
      const body = lines.join("\n");
      text +=
        body.length <= 1600
          ? `\n\n${body}`
          : `\n\n${lines.length} rader, för långa för ett svar — kör \`node src/memberscan.js --dry-run\` för hela listan.`;
    }
    await reply(token, text);
  },
  { admin: true, errorPrefix: "Fel vid scanning" },
);

// --- /link-scoutid ---

/**
 * Link a Discord user to a scoutid by hand. Creates the link, syncs roles, and
 * re-pushes the metadata so Discord re-evaluates the Scout requirement.
 */
const link = handler(
  async (interaction, { token, guildId, callerId, callerName }) => {
    const { id: targetUserId, error } = targetUser(interaction, {
      missing:
        "Ange `person`, eller `personid` för den som inte syns i listan (den som inte accepterat serverns regler göms av Discord i personväljaren).",
    });
    if (error) {
      await reply(token, error);
      return;
    }
    const scoutIdInput = String(option(interaction, "scoutid")).trim();

    if (!/^\d+$/.test(scoutIdInput)) {
      await reply(
        token,
        `Ogiltigt scoutid: \`${scoutIdInput}\` — måste vara numeriskt.`,
      );
      return;
    }

    const parts = [];
    const existing = await storage.getLinkedScoutIDUserId(targetUserId);
    if (existing && existing !== scoutIdInput) {
      parts.push(
        `⚠️ Var länkad till \`${existing}\`, ersätter med \`${scoutIdInput}\`.`,
      );
    } else if (existing === scoutIdInput) {
      parts.push("Redan länkad — tvingar om-synk av roller och smeknamn.");
    }

    if (config.SCOUTNET_EVENT_ID) {
      try {
        const participant = await scoutnet.getParticipant(scoutIdInput);
        if (!participant) {
          parts.push(
            `⚠️ ScoutNet känner inte till member_no \`${scoutIdInput}\` — länkar ändå.`,
          );
        } else if (scoutnet.isCancelled(participant)) {
          parts.push(
            `⚠️ ScoutNet-deltagaren är avbokad (${scoutnet.cancelledLabel(participant)}).`,
          );
        }
      } catch (e) {
        parts.push(`⚠️ Kunde inte slå upp ScoutNet: ${e.message}`);
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
      callerName,
      result,
    });

    parts.push(
      result.error
        ? `Fel vid rolluppdatering: ${result.error}`
        : formatChanges(result),
    );

    // Needs the user's stored OAuth tokens from an earlier /linked-role run.
    try {
      await updateMetadata(targetUserId);
      parts.push(
        `Metadata pushad → Discord uppdaterar ${config.SCOUTNET_SCOUT_ROLE}-rollen.`,
      );
    } catch (e) {
      parts.push(
        `⚠️ Kunde inte pusha metadata — hen kan behöva ${RELINK_INSTRUCTION}: ${e.message}`,
      );
    }

    await reply(
      token,
      `<@${targetUserId}>: Länkad till scoutid \`${scoutIdInput}\`. ${parts.join(" ")}` +
        (await pendingNote(guildId, targetUserId)),
    );
  },
  { admin: true },
);

/** Command name → handler. An unknown name is refused by server.js. */
export const handlers = {
  "refresh-scoutid": refresh,
  "status-scoutid": status,
  "audit-scoutid": auditCommand,
  "adoption-scoutid": adoptionCommand,
  "scan-scoutid": scan,
  "link-scoutid": link,
};
