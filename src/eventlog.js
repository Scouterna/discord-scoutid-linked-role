import config from "./config.js";
import * as discord from "./discord.js";
import { RELINK_INSTRUCTION } from "./metadata.js";
import { UNVERIFIED_ROLE, changedAnything, partitionResults } from "./guild.js";

/**
 * What the bot did, as it happens, written to a moderator-only Discord channel —
 * the only durable history there is. `LOG_CHANNEL_ID` unset turns it off.
 *
 * Three rules: **never throw into a caller** (a failed write must not turn a
 * successful link into a user-facing error), **never delay a caller** (`logEvent`
 * buffers and returns; the write happens on a timer), **never lose the buffer on
 * shutdown** (`flushEventLog()` is awaited in server.js's SIGTERM chain).
 */

const FLUSH_INTERVAL_MS = 3000;
const MAX_MESSAGE_CHARS = 1900; // 2000 minus room for the trailing newline
const MAX_QUEUE_LINES = 800; // `/refresh-scoutid alla:true` is ~150 lines

const queue = [];
let timer = null;
let flushing = false;
let dropped = 0;

const enabled = () => Boolean(config.LOG_CHANNEL_ID);

/** Discord renders this in each viewer's own timezone. */
const stamp = () => `<t:${Math.floor(Date.now() / 1000)}:T>`;

/**
 * Buffer one line. Returns immediately; callers never await this. Name the
 * person with `who()` rather than a mention — see there for why.
 */
export function logEvent(line) {
  if (!enabled()) return;
  if (queue.length >= MAX_QUEUE_LINES) {
    dropped++;
    return;
  }
  queue.push(`${stamp()} ${line}`);

  // One shared timer, started lazily. unref so it can never be the reason the
  // process stays alive after the HTTP server has closed.
  if (!timer) {
    timer = setInterval(() => void flushEventLog(), FLUSH_INTERVAL_MS);
    timer.unref?.();
  }
}

/**
 * Send everything buffered. Safe to call concurrently — a second call during a
 * send returns at once and the timer picks up the remainder.
 *
 * Returns false if a write failed, which the member scan branches on: it saves
 * its snapshot only once the lines are in the channel, so a failed write means
 * the next run re-reports the same diff instead of losing it.
 */
export async function flushEventLog() {
  if (!enabled() || flushing || queue.length === 0) return true;
  flushing = true;
  try {
    while (queue.length > 0) {
      let body = "";
      while (
        queue.length > 0 &&
        body.length + queue[0].length + 1 <= MAX_MESSAGE_CHARS
      ) {
        body += (body ? "\n" : "") + queue.shift();
      }
      // A single line longer than the whole budget: truncate rather than spin.
      if (!body) body = queue.shift().slice(0, MAX_MESSAGE_CHARS);

      if (dropped > 0) {
        body += `\n⚠️ ${dropped} rad(er) tappade — kön full.`;
        dropped = 0;
      }
      await discord.postChannelMessage(config.LOG_CHANNEL_ID, body);
    }
    return true;
  } catch (e) {
    console.error(`eventlog: could not write to log channel: ${e.message}`);
    // Drop the buffer. Holding a channel we cannot write to just grows the queue
    // until the backstop trims it anyway, and the same lines are in the pod log.
    queue.length = 0;
    return false;
  } finally {
    flushing = false;
  }
}

// --- Formatters ---

/**
 * How a person is written in a log line: `**Namn**`, or the raw id when no name
 * is known.
 *
 * Deliberately **not** a `<@id>` mention. Suppressing the ping (see discord.js)
 * also leaves the user objects out of the posted message, so a client that has
 * not cached that member renders the mention as `@okänd-användare` — in a guild
 * this size, most people most of the time. Such a mention is not clickable
 * either, so it cost the line its name and bought nothing back. The id is the
 * fallback because it at least pastes into `/status-scoutid personid:`, which
 * the placeholder never could.
 */
const who = (id, name) => (name ? `**${name}**` : `\`${id}\``);

/** `{ added, removed, nickname }` from a sync → one readable clause. */
function describeChanges({ added, removed, nickname } = {}) {
  const parts = [];
  if (added?.length > 0) parts.push(`+ ${added.join(", ")}`);
  if (removed?.length > 0) parts.push(`− ${removed.join(", ")}`);
  if (nickname) parts.push(`smeknamn: \`${nickname}\``);
  return parts.length > 0 ? parts.join(" · ") : "inga ändringar";
}

/** True when this sync was the verification gate closing on someone. */
const wasStripped = (result) =>
  Boolean(result?.added?.includes(UNVERIFIED_ROLE));

/**
 * Which no the gate acted on — `stripReason` carries the probe's answer, and it
 * is absent for a strip that never probed (a Scout role with no link behind it).
 * Without it a strip cannot be told apart from a false one afterwards: the
 * probe's answer is a moment in Discord that nothing else records.
 */
const strippedBecause = (result) =>
  result?.stripReason
    ? ` och kopplingsproben sa nej (${result.stripReason})`
    : "";

/**
 * A user completed the full `/linked-role` OAuth flow. `reason` says *why* when
 * there were no roles to grant — see `roles.explainMissingRoles`. `metadataFailed`
 * earns `⚠️` over `✅`: the link is stored and roles handed out, but the Scout
 * requirement has nothing to evaluate, so the member must come back.
 */
export function logLinked({
  discordUserId,
  scoutId,
  name,
  roles,
  reason,
  metadataFailed,
}) {
  const rolesText =
    roles?.length > 0
      ? roles.join(", ")
      : `inga roller${reason ? ` — ${reason}` : ""}`;
  const tail = metadataFailed
    ? ` — **Discord kunde inte uppdateras**, så \`${config.SCOUTNET_SCOUT_ROLE}\` delas inte ut förrän personen gör om det (${RELINK_INSTRUCTION})`
    : "";
  logEvent(
    `${metadataFailed ? "⚠️" : "✅"} ${who(discordUserId, name)} länkade ScoutID \`${scoutId}\` → ${rolesText}${tail}`,
  );
}

/**
 * An admin created a link by hand with `/link-scoutid`. The target's name rides
 * along on `result`, which the sync fills in from the member it already had.
 */
export function logManualLink({
  discordUserId,
  scoutId,
  previousScoutId,
  callerId,
  callerName,
  result,
}) {
  const replaced = previousScoutId ? ` (ersatte \`${previousScoutId}\`)` : "";
  logEvent(
    `🔗 ${who(callerId, callerName)} länkade ${who(discordUserId, result?.name)} till scoutid \`${scoutId}\`${replaced} — ${describeChanges(result)}`,
  );
}

/** An admin ran `/scan-scoutid` instead of waiting for the CronJob. */
export function logScanRun({ callerId, callerName, what }) {
  logEvent(`🔎 ${who(callerId, callerName)} körde \`/scan-scoutid\` — ${what}`);
}

/**
 * One user's roles were resynced. Silent when nothing changed: a feed that
 * records non-events is a feed nobody reads.
 */
export function logSync({ discordUserId, callerId, callerName, result }) {
  const target = who(discordUserId, result?.name);

  if (result?.error) {
    logEvent(`⚠️ Synk av ${target} misslyckades: ${result.error}`);
    return;
  }
  if (!changedAnything(result)) return;

  // The Scout role disappearing is the security gate closing, and it is the one
  // failure a moderator cannot fix for the user. It reads as an ordinary role
  // removal in the diff, so say so explicitly.
  if (wasStripped(result)) {
    logEvent(
      `🔒 ${target} saknar ${config.SCOUTNET_SCOUT_ROLE}-rollen${strippedBecause(result)} — roller strippade, ${UNVERIFIED_ROLE} satt (måste ${RELINK_INSTRUCTION})`,
    );
    return;
  }

  // Trailing rather than the old `<@id> (av <@id>)`, which put one parenthesis
  // inside another as soon as both mentions became names.
  const by =
    callerId && callerId !== discordUserId
      ? ` — av ${who(callerId, callerName)}`
      : "";
  logEvent(`🔄 ${target} — ${describeChanges(result)}${by}`);
}

/** A whole-guild resync run from Discord. One summary, then the changed users. */
export function logSyncAll({ callerId, callerName, results }) {
  const { changed, errors } = partitionResults(results);
  logEvent(
    `🔁 ${who(callerId, callerName)} körde \`/refresh-scoutid alla:true\` — ${results.length} användare, ${changed.length} ändrade, ${errors.length} fel`,
  );
  logSyncDetail(changed, errors);
}

/**
 * The same report for the nightly CronJob, which has no caller to name.
 *
 * **Silent when nothing changed** — silence is the steady state, a line means
 * something moved. A dead CronJob is visible instead as a stale `LAST SCHEDULE`
 * in `kubectl get cronjob`.
 */
export function logScheduledSyncAll({ results }) {
  const { changed, errors } = partitionResults(results);
  if (changed.length === 0 && errors.length === 0) return;
  logEvent(
    `🌙 Nattlig rollsynk — ${results.length} användare, ${changed.length} ändrade, ${errors.length} fel`,
  );
  logSyncDetail(changed, errors);
}

/** One line per changed user, then one per error. Unchanged users stay silent. */
function logSyncDetail(changed, errors) {
  for (const r of changed) {
    if (wasStripped(r)) {
      logEvent(
        `🔒 ${who(r.discordUserId, r.name)} saknar ${config.SCOUTNET_SCOUT_ROLE}-rollen${strippedBecause(r)} — roller strippade, ${UNVERIFIED_ROLE} satt`,
      );
    } else {
      logEvent(`   ↳ ${who(r.discordUserId, r.name)} — ${describeChanges(r)}`);
    }
  }
  for (const r of errors) {
    logEvent(`   ↳ ⚠️ ${who(r.discordUserId, r.name)} — ${r.error}`);
  }
}

// --- Member events, from the scheduled scan in memberscan.js ---
//
// These four **return** their line instead of logging it, so the scan can build
// a report without writing one: `/scan-scoutid dryrun:true` needs the lines in
// its reply, and routing them through `logEvent` would queue them for the flush
// timer to post — a dry run that was not dry. Handing the caller a string puts
// that decision where it belongs and needs no process-global dry-run flag.

function humanAge(ms) {
  const days = Math.floor(ms / 86400000);
  if (days >= 365) return `${Math.floor(days / 365)} år`;
  if (days >= 1) return `${days} d`;
  const hours = Math.floor(ms / 3600000);
  if (hours >= 1) return `${hours} h`;
  return `${Math.max(1, Math.floor(ms / 60000))} min`;
}

/**
 * Someone new in the guild. The account age makes throwaway accounts visible: a
 * Discord account created minutes ago joining a server for 14–18 year olds is
 * worth a second look, and it is invisible in the member list.
 */
export function formatMemberJoined({
  discordUserId,
  name,
  accountCreatedAt,
  isBot,
}) {
  const age = accountCreatedAt
    ? ` — konto skapat för ${humanAge(Date.now() - accountCreatedAt)} sedan`
    : "";
  return `📥 ${who(discordUserId, name)}${isBot ? " 🤖 bot" : ""} finns i servern${age}`;
}

/**
 * Someone is gone, and — with View Audit Log on the bot's role — *how*.
 *
 * `removal` is `{ kind: "kick" | "ban", actorId, actorName, reason }`, or null.
 * Null covers a voluntary leave and an unreadable audit log alike, so the
 * wording stays "är inte längre medlem" rather than asserting a leave nobody
 * observed.
 *
 * `stillLinked` names the orphan `/audit-scoutid` would report later.
 */
export function formatMemberGone({
  discordUserId,
  name,
  stillLinked,
  removal,
}) {
  const link = stillLinked
    ? " — länkningen kvarstår i storage (`/audit-scoutid` listar den som orphan)"
    : "";
  const why = removal?.reason ? ` — anledning: ${removal.reason}` : "";
  const by = removal?.actorId
    ? ` av ${who(removal.actorId, removal.actorName)}`
    : "";

  // "blev" rather than running two bold runs together: `**Erik** **kickad**`
  // reads as one phrase once the name is no longer separated by a mention.
  if (removal?.kind === "kick") {
    return `👟 ${who(discordUserId, name)} blev **kickad**${by}${why}${link}`;
  }
  if (removal?.kind === "ban") {
    return `⛔ ${who(discordUserId, name)} blev **bannad**${by}${why}${link}`;
  }
  return `📤 ${who(discordUserId, name)} är inte längre medlem${link}`;
}

/**
 * A nickname changed between two scans, whoever changed it.
 *
 * `name` is the *account* name, not the nickname: the nickname is the thing
 * changing and already appears twice in the line, so repeating it would name the
 * account not at all. Without it the line is a bare mention — see `who`.
 */
export function formatMemberRenamed({ discordUserId, name, from, to }) {
  return `✏️ ${who(discordUserId, name)} — smeknamn: \`${from || "—"}\` → \`${to || "—"}\``;
}

/**
 * A role change someone other than the bot made. The actor is the reason the line
 * exists: the bot logs its own changes as it makes them, so what is left is a
 * moderator editing roles by hand, and "who" is the first question asked.
 */
export function formatManualRoleChange({
  discordUserId,
  name,
  actorId,
  actorName,
  added,
  removed,
  reason,
}) {
  const why = reason ? ` — anledning: ${reason}` : "";
  // Actor first, because "who" is the question this category exists to answer.
  // It also keeps both names out of each other's parentheses, which the old
  // `<@id> (av <@id>)` shape could not once each mention became a name.
  const actor = actorId ? who(actorId, actorName) : "**Okänd**";
  return `🏷️ ${actor} ändrade roller för ${who(discordUserId, name)}: ${describeChanges({ added, removed })}${why}`;
}
