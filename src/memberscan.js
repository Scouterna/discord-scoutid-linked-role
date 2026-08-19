/**
 * Scheduled member scan — reports who arrived and who is gone.
 *
 * This bot speaks HTTP interactions, not the gateway, so it cannot *receive*
 * `guildMemberAdd` / `guildMemberRemove`. What it can do is fetch the member
 * list, compare it against the previous fetch, and report the difference. The
 * events are the same ones; they arrive one scan interval late and a kick cannot
 * be told from a voluntary leave.
 *
 * That trade buys a lot: no second bot, no privileged gateway intent to keep
 * enabled, no extra deployment to keep alive, and no dependence on a process
 * having been connected at the moment something happened. A gateway bot that was
 * down for an hour has lost that hour permanently — this one just reports the
 * change on its next run.
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

/** `[nick, username, roleIds]` — see storage.js for why it is this compact. */
function toSnapshot(members) {
  const snap = {};
  for (const m of members) {
    snap[m.user.id] = [
      m.nick ?? "",
      m.user.global_name || m.user.username || "",
      (m.roles ?? []).join(","),
    ];
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

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  if (dryRun) eventlog.setDryRun(true);
  const wanted = config.LOG_MEMBER_EVENTS;
  const guildId = config.DISCORD_GUILD_ID;

  if (!guildId) throw new Error("DISCORD_GUILD_ID is not set — nothing to scan");
  if (wanted.size === 0) {
    console.log("LOG_MEMBER_EVENTS is off — member scan disabled, exiting");
    return;
  }
  if (!config.LOG_CHANNEL_ID && !dryRun) {
    console.log("LOG_CHANNEL_ID is not set — nowhere to report, exiting");
    return;
  }
  console.log(`Scanning guild ${guildId} for: ${[...wanted].join(", ")}`);

  const [members, guildRoles] = await Promise.all([
    discord.getGuildMembers(guildId),
    discord.getGuildRoles(guildId),
  ]);
  const roleNames = new Map(guildRoles.map((r) => [r.id, r.name]));
  const nameOf = (id) => roleNames.get(id) ?? id;
  const botIds = new Set(members.filter((m) => m.user?.bot).map((m) => m.user.id));

  const current = toSnapshot(members);
  const previous = await storage.getMemberSnapshot();

  // First run, or a snapshot that could not be parsed. Seeding silently is the
  // point: reporting every existing member as a new arrival would bury the
  // channel and teach everyone to ignore it.
  if (!previous) {
    console.log(`No previous snapshot — seeding baseline of ${members.length} members`);
    if (!dryRun) await storage.storeMemberSnapshot(current);
    return;
  }

  const joined = [];
  const gone = [];
  const renamed = [];
  const roleChanges = [];

  for (const [id, entry] of Object.entries(current)) {
    const before = previous[id];
    if (!before) {
      joined.push({ id, entry });
      continue;
    }
    if (wanted.has("nickname") && before[0] !== entry[0]) {
      renamed.push({ id, from: before[0], to: entry[0] });
    }
    if (wanted.has("roles") && before[2] !== entry[2]) {
      const had = new Set(before[2] ? before[2].split(",") : []);
      const has = new Set(entry[2] ? entry[2].split(",") : []);
      const added = [...has].filter((r) => !had.has(r)).map(nameOf);
      const removed = [...had].filter((r) => !has.has(r)).map(nameOf);
      if (added.length > 0 || removed.length > 0) {
        roleChanges.push({ id, added, removed });
      }
    }
  }
  for (const [id, entry] of Object.entries(previous)) {
    if (!current[id]) gone.push({ id, entry });
  }

  // Only looked up for members who left, so an unchanged guild costs no storage
  // reads at all beyond the snapshot itself.
  let linkedIds = new Set();
  if (gone.length > 0 && wanted.has("leave")) {
    const links = await storage.getAllLinkedUsers();
    linkedIds = new Set(links.map((l) => l.discordUserId));
  }

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
  emit("🏷️ Ändrade roller", roleChanges, ({ id, added, removed }) =>
    eventlog.logMemberRolesChanged({ discordUserId: id, added, removed }),
  );

  const total =
    joined.length + gone.length + renamed.length + roleChanges.length;
  console.log(
    `${members.length} members: ${joined.length} new, ${gone.length} gone, ` +
      `${renamed.length} renamed, ${roleChanges.length} role changes`,
  );

  if (dryRun) {
    console.log("--dry-run: nothing posted, snapshot not saved");
    return;
  }

  if (total === 0) {
    // Nothing to report, but the snapshot still advances — otherwise a member
    // who joined and left between two scans would be reported forever.
    await storage.storeMemberSnapshot(current);
    return;
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
  await storage.storeMemberSnapshot(current);
  console.log("Reported and snapshot saved");
}

main().catch((e) => {
  console.error("Member scan failed:", e);
  process.exit(1);
});
