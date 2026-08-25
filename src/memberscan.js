import config from "./config.js";
import * as discord from "./discord.js";
import * as storage from "./storage.js";
import * as eventlog from "./eventlog.js";

/**
 * Member scan — who arrived, who is gone, and who changed roles by hand.
 *
 * Two sources. **Joins, leaves and nicknames** come from diffing the member list
 * against the previous run, since this bot speaks HTTP interactions and has no
 * gateway to receive `guildMemberAdd` on; the price is one interval's delay.
 * **Role changes, kicks and bans** come from the audit log, the only source that
 * knows *who* did something — and since the bot logs its own role changes as it
 * makes them, filtering to "not this bot" leaves what is otherwise invisible.
 *
 * The audit log needs **View Audit Log** on the bot's role, and the categories
 * degrade differently without it: role changes are *skipped*, because falling
 * back to the diff would report the bot's own changes, while departures still
 * report without the kick/ban distinction, which is true either way.
 *
 * **A CronJob and not a timer in the server**, because the Deployment runs
 * `replicas: 2` and an interval inside it would report every join twice — also
 * why the snapshot lives in Table Storage.
 *
 * **Run order matters.** The snapshot is saved only *after* the lines are in
 * Discord, so a failed write leaves it alone and the next run reports the same
 * diff again. In an audit log a duplicate on retry is cheap where a hole is not.
 *
 *   node src/memberscan.js              # scan, report, save
 *   node src/memberscan.js --dry-run    # print what it would report, save nothing
 */

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

/** `[nick, username]` per member — see storage.js for why it is this compact. */
function toSnapshot(members) {
  const snap = {};
  for (const m of members) {
    snap[m.user.id] = [
      m.nick ?? "",
      m.user.global_name || m.user.username || "",
    ];
  }
  return snap;
}

const displayName = ([nick, username]) => nick || username || "okänd";

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
 * New entries of one action type, plus the advanced cursor. A missing cursor seeds
 * from the newest entry and returns nothing, so a first run starts reporting from
 * now. An **empty** log seeds to `"0"` and not null — a null cursor would make the
 * next run seed again on the first kick that ever happens and swallow it.
 */
async function fetchAuditType(guildId, actionType, cursor) {
  if (cursor == null) {
    const newest = await discord.getNewestAuditLogId(guildId, actionType);
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
 * Kick and ban entries indexed by target, so a departure can say how it happened.
 * A ban wins over a kick for the same person: it is the stronger and later fact.
 */
function removalsByUser(kickEntries, banEntries) {
  const map = new Map();
  for (const [kind, entries] of [
    ["kick", kickEntries],
    ["ban", banEntries],
  ]) {
    for (const e of entries) {
      map.set(e.target_id, {
        kind,
        actorId: e.user_id,
        reason: e.reason ?? null,
      });
    }
  }
  return map;
}

/**
 * Audit-log entries turned into role changes made by someone other than the bot.
 * The `$add` / `$remove` change keys carry the role objects, so the names come
 * from the entry and need no role lookup.
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
 * Read the audit log for the types this run needs. A 403 means the role lacks
 * View Audit Log and is handled; anything else stops the run.
 */
async function readAuditLog(guildId, types, cursors) {
  const byType = new Map();
  if (types.length === 0) {
    return { byType, botUserId: null, unavailable: false, truncated: false };
  }
  try {
    const botUserId = await discord.getCurrentBotUserId();
    let truncated = false;
    for (const type of types) {
      const r = await fetchAuditType(guildId, type, cursors[type] ?? null);
      byType.set(type, r.entries);
      cursors[type] = r.cursor;
      truncated = truncated || r.truncated;
    }
    return { byType, botUserId, unavailable: false, truncated };
  } catch (e) {
    if (e?.status !== 403) throw e;
    console.warn(
      "Cannot read the audit log (403) — needs View Audit Log on the bot's " +
        "role. Role changes are skipped; departures still report, without the " +
        "kick/ban distinction.",
    );
    return {
      byType: new Map(),
      botUserId: null,
      unavailable: true,
      truncated: false,
    };
  }
}

/**
 * Run one scan. Returns `{ disabled, seeded, counts, total, lines, truncated,
 * auditUnavailable, enabled }` — `seeded` means this was a first run that
 * established a baseline and deliberately reported nothing.
 */
export async function runMemberScan({ dryRun = false } = {}) {
  const wanted = config.LOG_MEMBER_EVENTS;
  const guildId = config.DISCORD_GUILD_ID;

  if (!guildId) {
    throw new Error("DISCORD_GUILD_ID is not set — nothing to scan");
  }
  if (wanted.size === 0) return { disabled: "LOG_MEMBER_EVENTS is off" };
  if (!config.LOG_CHANNEL_ID && !dryRun) {
    return { disabled: "LOG_CHANNEL_ID is not set — nowhere to report" };
  }

  const members = await discord.getGuildMembers(guildId);
  const current = toSnapshot(members);
  const stored = await storage.getMemberSnapshot();
  const previous = stored?.members ?? null;

  // `leave` wants kicks and bans so a departure can say how it happened;
  // `roles` wants role updates.
  const cursors = { ...(stored?.auditCursors ?? {}) };
  const types = [];
  if (wanted.has("roles")) types.push(discord.AUDIT_MEMBER_ROLE_UPDATE);
  if (wanted.has("leave")) {
    types.push(discord.AUDIT_MEMBER_KICK, discord.AUDIT_MEMBER_BAN_ADD);
  }
  const audit = await readAuditLog(guildId, types, cursors);
  const removals = removalsByUser(
    audit.byType.get(discord.AUDIT_MEMBER_KICK) ?? [],
    audit.byType.get(discord.AUDIT_MEMBER_BAN_ADD) ?? [],
  );

  // First run, or a snapshot that could not be parsed. Seeding silently is the
  // point: reporting every existing member as a new arrival would bury the
  // channel and teach everyone to ignore it.
  if (!previous) {
    if (!dryRun) await storage.storeMemberSnapshot(current, cursors);
    return {
      seeded: members.length,
      auditUnavailable: audit.unavailable,
      enabled: [...wanted],
    };
  }

  const joined = [];
  const gone = [];
  const renamed = [];
  for (const [id, entry] of Object.entries(current)) {
    const before = previous[id];
    if (!before) joined.push({ id, entry });
    else if (wanted.has("nickname") && before[0] !== entry[0]) {
      renamed.push({ id, from: before[0], to: entry[0] });
    }
  }
  for (const [id, entry] of Object.entries(previous)) {
    if (!current[id]) gone.push({ id, entry });
  }

  const roleChanges = roleChangesFromAuditLog(
    audit.byType.get(discord.AUDIT_MEMBER_ROLE_UPDATE) ?? [],
    audit.botUserId,
  );

  // Only looked up for members who left, so an unchanged guild costs no storage
  // reads beyond the snapshot itself.
  let linkedIds = new Set();
  if (gone.length > 0 && wanted.has("leave")) {
    const links = await storage.getAllLinkedUsers();
    linkedIds = new Set(links.map((l) => l.discordUserId));
  }
  const botIds = new Set(
    members.filter((m) => m.user?.bot).map((m) => m.user.id),
  );

  // A dry run collects its lines and writes nothing. A sink rather than a global
  // flag keeps this run's choice local to this run: the server handles requests
  // concurrently, and a process-wide switch would silence an unrelated linking
  // that happened to be logging at the time.
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
  if (audit.truncated) {
    sink(
      "⚠️ Audit-loggen hade fler poster än som hämtades — äldre poster kan saknas i den här rapporten.",
    );
  }

  const counts = {
    joined: joined.length,
    gone: gone.length,
    // Counted separately rather than folded into `gone`, so the summary can say
    // "3 borta (1 kickad)" instead of hiding a moderation action in a departure.
    removedByMod: gone.filter((g) => removals.has(g.id)).length,
    renamed: renamed.length,
    roleChanges: roleChanges.length,
  };
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const result = {
    counts,
    total,
    auditUnavailable: audit.unavailable,
    enabled: [...wanted],
  };

  if (dryRun) return { ...result, dryRun: true, lines };

  // Nothing to report, but the snapshot still advances — otherwise a member who
  // joined and left between two scans would be reported forever, and the audit
  // cursor would never move past the bot's own entries.
  if (total > 0 && !(await eventlog.flushEventLog())) {
    // Thrown rather than exited: the snapshot save is the very next statement,
    // and control flow that depends on process.exit stopping mid-function is one
    // refactor away from silently writing anyway. Failing loudly also makes the
    // CronJob retry, which is exactly what should happen.
    throw new Error(
      "could not write to the log channel — snapshot left untouched so the " +
        "next run reports this diff again",
    );
  }
  await storage.storeMemberSnapshot(current, cursors);
  return result;
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

  // Only the categories that were actually examined. "0 rolländringar" for a
  // switched-off category reads as "we looked and found none", which is exactly
  // the wrong conclusion.
  const c = result.counts;
  const on = new Set(result.enabled ?? []);
  const parts = [];
  if (on.has("join")) parts.push(`${c.joined} nya`);
  if (on.has("leave")) {
    const mod =
      c.removedByMod > 0 ? ` (varav ${c.removedByMod} kickad/bannad)` : "";
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

// Guarded so importing this module from the server does not start a scan.
if (process.argv[1]?.endsWith("memberscan.js")) {
  try {
    const result = await runMemberScan({
      dryRun: process.argv.includes("--dry-run"),
    });
    for (const line of result.lines ?? []) console.log(`  ${line}`);
    console.log(formatScanSummary(result));
  } catch (e) {
    console.error("Member scan failed:", e);
    process.exit(1);
  }
}
