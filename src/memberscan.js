/**
 * Member scan — reports who arrived, who is gone, and who changed someone's
 * roles by hand.
 *
 * Two different sources, because they answer different questions:
 *
 * - **Joins, leaves and nicknames** come from diffing the member list against
 *   the previous run. This bot speaks HTTP interactions, not the gateway, so it
 *   cannot *receive* `guildMemberAdd` / `guildMemberRemove`. The events are the
 *   same ones; they arrive one scan interval late, and a kick cannot be told
 *   from a voluntary leave.
 * - **Role changes** come from the Discord audit log, which is the only source
 *   that knows *who* made a change. That matters more than it sounds: the bot
 *   already logs every role change it makes, at the moment it makes it, so a
 *   diff-based report would mostly repeat itself. Filtering the audit log to
 *   "not this bot" leaves exactly what is otherwise invisible — a moderator
 *   editing roles in the Discord UI — and names them while doing it.
 * - **Kicks and bans** come from the audit log too, and turn a departure from
 *   "is no longer a member" into "kicked by X, reason Y". The member list cannot
 *   tell an involuntary removal from someone leaving on their own; nothing in the
 *   diff distinguishes them.
 *
 * The audit log needs View Audit Log on the bot's role. The two categories
 * degrade differently without it, on purpose. Role changes are **skipped** with a
 * warning, because falling back to the diff would report the bot's own changes —
 * the noise this was built to avoid. Departures still report, just without the
 * kick/ban distinction, because the plain line is true either way.
 *
 * ## Why a CronJob and not a timer in the server
 *
 * The web Deployment runs `replicas: 2`. An interval inside it would run in both
 * pods, and every join would be reported twice with no coordination to prevent
 * it. A CronJob runs once per schedule regardless of how many replicas serve
 * HTTP, which is why the snapshot lives in Table Storage rather than in memory.
 *
 * ## Run order matters
 *
 * The new snapshot is saved **only after** the lines are in Discord. If the
 * write fails, the snapshot is left alone and the next run reports the same
 * diff again. Saving first would mean a failed write silently erased the only
 * record that anything changed — and in an audit log, a duplicate on retry is
 * cheap where a hole is not.
 *
 * Usage:
 *   node src/memberscan.js              # scan, report, save
 *   node src/memberscan.js --dry-run    # print what it would report, save nothing
 *
 * `/scan-scoutid` in Discord runs the same `runMemberScan` this file exports.
 */

import config from "./config.js";
import * as discord from "./discord.js";
import * as storage from "./storage.js";
import * as eventlog from "./eventlog.js";

/** Above this many entries in one category, summarise instead of listing. */
const MAX_LINES_PER_CATEGORY = 25;

/** Discord's epoch: a snowflake's high bits are ms since 2015-01-01. */
const DISCORD_EPOCH = 1420070400000n;

function accountCreatedAt(userId) {
  try {
    return Number((BigInt(userId) >> 22n) + DISCORD_EPOCH);
  } catch {
    return null;
  }
}

/** `[nick, username]` — see storage.js for why it is this compact. */
function toSnapshot(members) {
  const snap = {};
  for (const m of members) {
    snap[m.user.id] = [m.nick ?? "", m.user.global_name || m.user.username || ""];
  }
  return snap;
}

function displayName(entry) {
  const [nick, username] = entry;
  return nick || username || "okänd";
}

/**
 * Emit one category of lines, collapsing to a summary when there are too many.
 * A cap that hides what it dropped reads as "nothing else happened", so the
 * summary always names the count.
 */
function emit(sink, label, items, render) {
  if (items.length === 0) return;
  if (items.length > MAX_LINES_PER_CATEGORY) {
    sink(
      `${label}: **${items.length}** stycken — för många att lista rad för rad, kör \`/audit-scoutid\` för detaljer`,
    );
    return;
  }
  for (const item of items) sink(render(item));
}

/**
 * Fetch new entries of one action type and return them with the advanced cursor.
 *
 * A missing cursor seeds from the newest entry and returns nothing: the point of
 * a first run is to start reporting from now, not to replay however much history
 * Discord still retains.
 */
async function fetchAuditType(guildId, actionType, cursor) {
  if (cursor == null) {
    const newest = await discord.getNewestAuditLogId(guildId, actionType);
    // An empty log for this type seeds to the beginning, not to "now". Kicks and
    // bans are rare, so a guild that has never had one returns null here — and
    // seeding null would leave the cursor null, making the *next* run seed again
    // on the very first kick that ever happens and swallow it. There is no
    // history to skip when there is no history.
    return { entries: [], cursor: newest ?? "0", truncated: false };
  }
  const { entries, truncated } = await discord.getAuditLogEntries(guildId, {
    actionType,
    after: cursor,
  });
  return {
    entries,
    cursor: entries.length > 0 ? entries[entries.length - 1].id : cursor,
    truncated,
  };
}

/**
 * Index kick and ban entries by the member they targeted, so a departure can be
 * annotated with how it happened.
 *
 * Bans win over kicks when both exist for one person: a ban is the stronger and
 * later fact, and reporting "kicked" for someone who ended up banned understates
 * what happened.
 */
function removalsByUser(kickEntries, banEntries) {
  const map = new Map();
  for (const e of kickEntries) {
    map.set(e.target_id, { kind: "kick", actorId: e.user_id, reason: e.reason ?? null });
  }
  for (const e of banEntries) {
    map.set(e.target_id, { kind: "ban", actorId: e.user_id, reason: e.reason ?? null });
  }
  return map;
}

/**
 * Turn audit-log entries into role changes made by someone other than the bot.
 *
 * Entries carry `$add` / `$remove` change keys with the role objects, so the
 * names come from the entry itself and need no role lookup.
 */
function roleChangesFromAuditLog(entries, botUserId) {
  const changes = [];
  for (const entry of entries) {
    if (entry.user_id === botUserId) continue;
    const added = [];
    const removed = [];
    for (const change of entry.changes ?? []) {
      const names = (change.new_value ?? []).map((r) => r.name ?? r.id);
      if (change.key === "$add") added.push(...names);
      else if (change.key === "$remove") removed.push(...names);
    }
    if (added.length === 0 && removed.length === 0) continue;
    changes.push({
      discordUserId: entry.target_id,
      actorId: entry.user_id,
      added,
      removed,
      reason: entry.reason ?? null,
    });
  }
  return changes;
}

/**
 * Run one scan. Returns what it found so a caller can report a summary.
 *
 * `{ disabled, seeded, counts, truncated, auditUnavailable }` — `seeded` means
 * this was a first run that established a baseline and deliberately reported
 * nothing.
 */
export async function runMemberScan({ dryRun = false } = {}) {
  const wanted = config.LOG_MEMBER_EVENTS;
  const guildId = config.DISCORD_GUILD_ID;

  if (!guildId) throw new Error("DISCORD_GUILD_ID is not set — nothing to scan");
  if (wanted.size === 0) return { disabled: "LOG_MEMBER_EVENTS is off" };
  if (!config.LOG_CHANNEL_ID && !dryRun) {
    return { disabled: "LOG_CHANNEL_ID is not set — nowhere to report" };
  }

  const members = await discord.getGuildMembers(guildId);
  const current = toSnapshot(members);
  const stored = await storage.getMemberSnapshot();
  const previous = stored?.members ?? null;

  // Which audit-log types this run needs. `leave` wants kicks and bans so a
  // departure can say how it happened; `roles` wants role updates.
  const cursors = { ...(stored?.auditCursors ?? {}) };
  const types = [];
  if (wanted.has("roles")) types.push(discord.AUDIT_MEMBER_ROLE_UPDATE);
  if (wanted.has("leave")) {
    types.push(discord.AUDIT_MEMBER_KICK, discord.AUDIT_MEMBER_BAN_ADD);
  }

  // A 403 means the bot's role lacks View Audit Log; anything else is a real
  // failure and should stop the run.
  let auditUnavailable = false;
  let auditTruncated = false;
  const byType = new Map();
  let botUserId = null;

  if (types.length > 0) {
    try {
      botUserId = await discord.getCurrentBotUserId();
      for (const type of types) {
        const r = await fetchAuditType(guildId, type, cursors[type] ?? null);
        byType.set(type, r.entries);
        cursors[type] = r.cursor;
        auditTruncated = auditTruncated || r.truncated;
      }
    } catch (e) {
      if (e?.status !== 403) throw e;
      auditUnavailable = true;
      byType.clear();
      console.warn(
        "Cannot read the audit log (403) — needs View Audit Log on the bot's " +
          "role. Role changes are skipped; departures still report, without the " +
          "kick/ban distinction.",
      );
    }
  }
  const auditEntries = byType.get(discord.AUDIT_MEMBER_ROLE_UPDATE) ?? [];
  const removals = removalsByUser(
    byType.get(discord.AUDIT_MEMBER_KICK) ?? [],
    byType.get(discord.AUDIT_MEMBER_BAN_ADD) ?? [],
  );

  // First run, or a snapshot that could not be parsed. Seeding silently is the
  // point: reporting every existing member as a new arrival would bury the
  // channel and teach everyone to ignore it.
  if (!previous) {
    if (!dryRun) await storage.storeMemberSnapshot(current, cursors);
    return { seeded: members.length, auditUnavailable, enabled: [...wanted] };
  }

  const joined = [];
  const gone = [];
  const renamed = [];

  for (const [id, entry] of Object.entries(current)) {
    const before = previous[id];
    if (!before) {
      joined.push({ id, entry });
      continue;
    }
    if (wanted.has("nickname") && before[0] !== entry[0]) {
      renamed.push({ id, from: before[0], to: entry[0] });
    }
  }
  for (const [id, entry] of Object.entries(previous)) {
    if (!current[id]) gone.push({ id, entry });
  }

  const roleChanges = roleChangesFromAuditLog(auditEntries, botUserId);

  // Only looked up for members who left, so an unchanged guild costs no storage
  // reads at all beyond the snapshot itself.
  let linkedIds = new Set();
  if (gone.length > 0 && wanted.has("leave")) {
    const links = await storage.getAllLinkedUsers();
    linkedIds = new Set(links.map((l) => l.discordUserId));
  }

  const botIds = new Set(members.filter((m) => m.user?.bot).map((m) => m.user.id));

  // A dry run collects its lines and writes nothing. Routing through a sink
  // rather than a global flag keeps this run's choice local to this run: the
  // server handles requests concurrently, and a process-wide dry-run switch would
  // have silenced an unrelated linking that happened to be logging at the time.
  const lines = [];
  const sink = dryRun ? (line) => lines.push(line) : eventlog.logEvent;

  if (wanted.has("join")) {
    emit(sink, "📥 Nya medlemmar", joined, ({ id, entry }) =>
      eventlog.formatMemberJoined({
        discordUserId: id,
        name: displayName(entry),
        accountCreatedAt: accountCreatedAt(id),
        isBot: botIds.has(id),
      }),
    );
  }
  if (wanted.has("leave")) {
    emit(sink, "📤 Borta ur servern", gone, ({ id, entry }) =>
      eventlog.formatMemberGone({
        discordUserId: id,
        name: displayName(entry),
        stillLinked: linkedIds.has(id),
        removal: removals.get(id) ?? null,
      }),
    );
  }
  emit(sink, "✏️ Ändrade smeknamn", renamed, ({ id, from, to }) =>
    eventlog.formatMemberRenamed({ discordUserId: id, from, to }),
  );
  emit(sink, "🏷️ Rolländringar gjorda för hand", roleChanges, (change) =>
    eventlog.formatManualRoleChange(change),
  );
  if (auditTruncated) {
    sink(
      "⚠️ Audit-loggen hade fler poster än som hämtades — äldre poster kan saknas i den här rapporten.",
    );
  }

  const removed = gone.filter((g) => removals.has(g.id)).length;
  const counts = {
    joined: joined.length,
    gone: gone.length,
    // Of those gone, how many the audit log shows were kicked or banned. Counted
    // rather than folded into `gone` so the summary can say "3 borta (1 kickad)"
    // instead of hiding a moderation action inside a departure count.
    removedByMod: removed,
    renamed: renamed.length,
    roleChanges: roleChanges.length,
  };
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  if (dryRun) {
    return { counts, total, dryRun: true, auditUnavailable, enabled: [...wanted], lines };
  }

  if (total === 0) {
    // Nothing to report, but the snapshot still advances — otherwise a member
    // who joined and left between two scans would be reported forever, and the
    // audit cursor would never move past the bot's own entries.
    await storage.storeMemberSnapshot(current, cursors);
    return { counts, total, auditUnavailable, enabled: [...wanted] };
  }

  const posted = await eventlog.flushEventLog();
  if (!posted) {
    // Thrown rather than exited: the snapshot save is the very next statement,
    // and control flow that depends on process.exit stopping mid-function is
    // one refactor away from silently writing anyway. Failing loudly here also
    // makes the CronJob retry, which is exactly what should happen.
    throw new Error(
      "could not write to the log channel — snapshot left untouched so the " +
        "next run reports this diff again",
    );
  }
  await storage.storeMemberSnapshot(current, cursors);
  return { counts, total, auditUnavailable, enabled: [...wanted] };
}

/** One-line summary, used by both the CLI and the `/scan-scoutid` reply. */
export function formatScanSummary(result) {
  if (result.disabled) return `Scannern är av: ${result.disabled}.`;
  if (result.seeded != null) {
    return (
      `Baslinje sparad för ${result.seeded} medlemmar. Inget rapporterat — ` +
      `första körningen jämför inte mot något. Nästa körning rapporterar ändringar.`
    );
  }
  // Only count the categories that were actually examined. Printing "0
  // rolländringar" for a switched-off category reads as "we looked and found
  // none", which is exactly the wrong conclusion — and it did mislead once, when
  // a scheduled run started 82 seconds before the ConfigMap enabling `roles`
  // landed and still reported a zero for it.
  const c = result.counts;
  const on = new Set(result.enabled ?? []);
  const parts = [];
  if (on.has("join")) parts.push(`${c.joined} nya`);
  if (on.has("leave")) {
    const mod = c.removedByMod > 0 ? ` (varav ${c.removedByMod} kickad/bannad)` : "";
    parts.push(`${c.gone} borta${mod}`);
  }
  if (on.has("nickname")) parts.push(`${c.renamed} namnbyten`);
  if (on.has("roles") && !result.auditUnavailable) {
    parts.push(`${c.roleChanges} rolländringar för hand`);
  }
  let text = parts.length > 0 ? `${parts.join(", ")}.` : "Inga kategorier på.";
  if (result.total === 0 && parts.length > 0) text += " Inget att rapportera.";

  const off = ["join", "leave", "nickname", "roles"].filter((k) => !on.has(k));
  if (off.length > 0) text += ` (avstängt: ${off.join(", ")})`;
  if (result.auditUnavailable) {
    text +=
      "\n⚠️ Rolländringar hoppades över: botens roll saknar **View Audit Log**.";
  }
  if (result.dryRun) text += "\n(dry-run: inget postat, snapshot inte sparad)";
  return text;
}

// --- CLI entrypoint ---
//
// Guarded so importing this module from server.js does not start a scan.

const isCli = process.argv[1]?.endsWith("memberscan.js");

if (isCli) {
  const dryRun = process.argv.includes("--dry-run");
  try {
    const result = await runMemberScan({ dryRun });
    for (const line of result.lines ?? []) console.log(`  ${line}`);
    console.log(formatScanSummary(result));
  } catch (e) {
    console.error("Member scan failed:", e);
    process.exit(1);
  }
}
