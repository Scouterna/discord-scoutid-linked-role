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
 *
 * The audit log needs View Audit Log on the bot's role. Without it, role
 * reporting is skipped with a warning rather than falling back to the diff:
 * quietly reporting the bot's own changes is the noise this was built to avoid.
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
function emit(label, items, render) {
  if (items.length === 0) return;
  if (items.length > MAX_LINES_PER_CATEGORY) {
    eventlog.logEvent(
      `${label}: **${items.length}** stycken — för många att lista rad för rad, kör \`/audit-scoutid\` för detaljer`,
    );
    return;
  }
  for (const item of items) render(item);
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

  // Role reporting needs both the audit log and the bot's own id to filter by.
  // A 403 here means the bot's role lacks View Audit Log; anything else is a
  // real failure and should stop the run.
  let auditUnavailable = false;
  let auditEntries = [];
  let auditTruncated = false;
  let newAuditCursor = stored?.lastAuditId ?? null;
  let botUserId = null;

  if (wanted.has("roles")) {
    try {
      botUserId = await discord.getCurrentBotUserId();
      if (newAuditCursor == null) {
        // First run with roles enabled: start from now rather than replaying
        // however much history Discord still retains.
        newAuditCursor = await discord.getNewestAuditLogId(
          guildId,
          discord.AUDIT_MEMBER_ROLE_UPDATE,
        );
      } else {
        const result = await discord.getAuditLogEntries(guildId, {
          actionType: discord.AUDIT_MEMBER_ROLE_UPDATE,
          after: newAuditCursor,
        });
        auditEntries = result.entries;
        auditTruncated = result.truncated;
        if (auditEntries.length > 0) {
          newAuditCursor = auditEntries[auditEntries.length - 1].id;
        }
      }
    } catch (e) {
      if (e?.status !== 403) throw e;
      auditUnavailable = true;
      console.warn(
        "Cannot read the audit log (403) — role reporting needs View Audit Log " +
          "on the bot's role. Skipping role changes; nothing else is affected.",
      );
    }
  }

  // First run, or a snapshot that could not be parsed. Seeding silently is the
  // point: reporting every existing member as a new arrival would bury the
  // channel and teach everyone to ignore it.
  if (!previous) {
    if (!dryRun) await storage.storeMemberSnapshot(current, newAuditCursor);
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

  if (wanted.has("join")) {
    emit("📥 Nya medlemmar", joined, ({ id, entry }) =>
      eventlog.logMemberJoined({
        discordUserId: id,
        name: displayName(entry),
        accountCreatedAt: accountCreatedAt(id),
        isBot: botIds.has(id),
      }),
    );
  }
  if (wanted.has("leave")) {
    emit("📤 Borta ur servern", gone, ({ id, entry }) =>
      eventlog.logMemberGone({
        discordUserId: id,
        name: displayName(entry),
        stillLinked: linkedIds.has(id),
      }),
    );
  }
  emit("✏️ Ändrade smeknamn", renamed, ({ id, from, to }) =>
    eventlog.logMemberRenamed({ discordUserId: id, from, to }),
  );
  emit("🏷️ Rolländringar gjorda för hand", roleChanges, (change) =>
    eventlog.logManualRoleChange(change),
  );
  if (auditTruncated) {
    eventlog.logEvent(
      "⚠️ Audit-loggen hade fler poster än som hämtades — äldre rolländringar kan saknas i den här rapporten.",
    );
  }

  const counts = {
    joined: joined.length,
    gone: gone.length,
    renamed: renamed.length,
    roleChanges: roleChanges.length,
  };
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  if (dryRun) {
    return { counts, total, dryRun: true, auditUnavailable, enabled: [...wanted] };
  }

  if (total === 0) {
    // Nothing to report, but the snapshot still advances — otherwise a member
    // who joined and left between two scans would be reported forever, and the
    // audit cursor would never move past the bot's own entries.
    await storage.storeMemberSnapshot(current, newAuditCursor);
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
  await storage.storeMemberSnapshot(current, newAuditCursor);
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
  if (on.has("leave")) parts.push(`${c.gone} borta`);
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
  if (dryRun) eventlog.setDryRun(true);
  try {
    const result = await runMemberScan({ dryRun });
    console.log(formatScanSummary(result));
  } catch (e) {
    console.error("Member scan failed:", e);
    process.exit(1);
  }
}
