/**
 * Verification event log — writes what the bot did, as it happens, to a
 * moderator-only Discord channel.
 *
 * This information exists today only in `kubectl logs`, which means it exists
 * for as long as the current pod does. Every deploy throws away the record of
 * who linked, what roles they got, and who lost the Scout role and got stripped
 * — and those are exactly the questions asked afterwards, when someone cannot
 * see a channel and nobody remembers whether they ever verified.
 *
 * `/audit-scoutid` answers the *state* question ("who is inconsistent right
 * now"). It cannot answer the *history* question, because nothing keeps history.
 * This does.
 *
 * Member joins and leaves land in the same channel, from
 * [src/memberscan.js](src/memberscan.js) — a scheduled diff of the member list
 * rather than live events, because this bot speaks HTTP interactions and has no
 * gateway connection to receive them on.
 *
 * ## Rules this module holds itself to
 *
 * - **Never throw into a caller.** A failed log write must not turn a
 *   successful link into an error for the user.
 * - **Never delay a caller.** `logEvent` buffers and returns; the write happens
 *   on a timer. A slow Discord API cannot slow down `/refresh-scoutid`.
 * - **Never lose the buffer on shutdown.** `flushEventLog()` is awaited by the
 *   SIGTERM handler in server.js, alongside the other background work a
 *   rollout has to wait for.
 */

import config from "./config.js";
import * as discord from "./discord.js";

const FLUSH_INTERVAL_MS = 3000;
const MAX_MESSAGE_CHARS = 1900; // 2000 minus room for the trailing newline
const MAX_QUEUE_LINES = 800; // `/refresh-scoutid alla:true` is ~150 lines

const queue = [];
let timer = null;
let flushing = false;
let dropped = 0;
function enabled() {
  return Boolean(config.LOG_CHANNEL_ID);
}

/** Discord renders this in each viewer's own timezone. */
function stamp() {
  return `<t:${Math.floor(Date.now() / 1000)}:T>`;
}

/**
 * Buffer one line. Returns immediately; callers never await this.
 *
 * Include `<@id>` for the person the line is about — it makes the entry
 * clickable, and `postChannelMessage` suppresses the ping.
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
 * Send everything buffered. Safe to call concurrently — a second call while a
 * send is in flight returns at once, and the timer picks up the remainder.
 *
 * Returns true if the buffer was drained (or there was nothing to drain), false
 * if a write failed. The scheduled member scan depends on that answer: it only
 * saves its new snapshot once the lines describing the change are actually in
 * the channel, so a failed write means the next run re-reports the same diff
 * instead of losing it. Duplicates on retry beat silent loss in an audit trail.
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
    // Drop the buffer. Holding a channel we cannot write to just grows the
    // queue until the backstop trims it anyway, and the same lines are in the
    // pod log regardless.
    queue.length = 0;
    return false;
  } finally {
    flushing = false;
  }
}

// --- Formatters for the events worth a line each ---

const UNVERIFIED = "Overifierad";

/** `{ added, removed, nickname }` from syncUserRoles → one readable clause. */
function describeChanges({ added, removed, nickname } = {}) {
  const parts = [];
  if (added?.length > 0) parts.push(`+ ${added.join(", ")}`);
  if (removed?.length > 0) parts.push(`− ${removed.join(", ")}`);
  if (nickname) parts.push(`smeknamn: \`${nickname}\``);
  return parts.length > 0 ? parts.join(" · ") : "inga ändringar";
}

/** True when this sync was the verification gate closing on someone. */
function wasStripped(result) {
  return Boolean(result?.added?.includes(UNVERIFIED));
}

/** A user completed the full `/linked-role` OAuth flow. */
export function logLinked({ discordUserId, scoutId, name, roles }) {
  const rolesText = roles?.length > 0 ? roles.join(", ") : "inga roller";
  logEvent(
    `✅ **${name || "okänt namn"}** (<@${discordUserId}>) länkade ScoutID \`${scoutId}\` → ${rolesText}`,
  );
}

/** An admin created a link by hand with `/link-scoutid`. */
export function logManualLink({
  discordUserId,
  scoutId,
  previousScoutId,
  callerId,
  result,
}) {
  const replaced = previousScoutId ? ` (ersatte \`${previousScoutId}\`)` : "";
  logEvent(
    `🔗 <@${callerId}> länkade <@${discordUserId}> till scoutid \`${scoutId}\`${replaced} — ${describeChanges(result)}`,
  );
}

/**
 * One user's roles were resynced. Skipped when nothing changed: a feed that
 * records non-events is a feed nobody reads.
 */
export function logSync({ discordUserId, callerId, result }) {
  if (result?.error) {
    logEvent(`⚠️ Synk av <@${discordUserId}> misslyckades: ${result.error}`);
    return;
  }
  const changed =
    result?.added?.length > 0 ||
    result?.removed?.length > 0 ||
    result?.nickname;
  if (!changed) return;

  // The Scout role disappearing is the security gate closing, and it is the one
  // failure a moderator cannot fix for the user — only the user can re-run
  // `/linked-role`. It reads as an ordinary role removal in the diff, so say so.
  if (wasStripped(result)) {
    logEvent(
      `🔒 <@${discordUserId}> saknar Scout-rollen — roller strippade, ${UNVERIFIED} satt (måste re-verifiera via /linked-role själv)`,
    );
    return;
  }

  const by =
    callerId && callerId !== discordUserId ? ` (av <@${callerId}>)` : "";
  logEvent(`🔄 <@${discordUserId}>${by} — ${describeChanges(result)}`);
}

// --- Member events, from the scheduled scan in memberscan.js ---

function humanAge(ms) {
  const days = Math.floor(ms / 86400000);
  if (days >= 365) return `${Math.floor(days / 365)} år`;
  if (days >= 1) return `${days} d`;
  const hours = Math.floor(ms / 3600000);
  if (hours >= 1) return `${hours} h`;
  return `${Math.max(1, Math.floor(ms / 60000))} min`;
}

/**
 * Someone new in the guild. The account age is there to make throwaway accounts
 * visible: a Discord account created minutes ago joining a server for 14–18 year
 * olds is worth a second look, and it is invisible in the member list.
 */
// These four **return** their line instead of logging it. The scan needs to be
// able to build a report without writing one: `/scan-scoutid torrkor:true` used
// to format its lines through `logEvent`, which queued them and let the flush
// timer post them a few seconds later — a dry run that was not dry. Handing the
// caller a string moves that decision to the caller, where it belongs, and
// removes the need for a process-global dry-run flag that would have swallowed
// unrelated events happening concurrently in the same pod.

/**
 * Someone new in the guild. The account age is there to make throwaway accounts
 * visible: a Discord account created minutes ago joining a server for 14–18 year
 * olds is worth a second look, and it is invisible in the member list.
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
  return `📥 **${name}** (<@${discordUserId}>)${isBot ? " 🤖 bot" : ""} finns i servern${age}`;
}

/**
 * Someone is gone, and — since the bot gained View Audit Log — *how*.
 *
 * `removal` is `{ kind: "kick" | "ban", actorId, reason }` when the audit log
 * shows the departure was involuntary, and null when it does not. Null genuinely
 * means "no such entry", which covers a voluntary leave and an unreadable audit
 * log alike, so the wording stays "är inte längre medlem" rather than asserting
 * a leave that was never observed.
 *
 * `stillLinked` matters: a link left behind is what `/audit-scoutid` will report
 * as an orphan later, so naming it here saves the connection being made twice.
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
  const by = removal?.actorId ? ` av <@${removal.actorId}>` : "";

  if (removal?.kind === "kick") {
    return `👟 **${name}** (<@${discordUserId}>) **kickad**${by}${why}${link}`;
  }
  if (removal?.kind === "ban") {
    return `⛔ **${name}** (<@${discordUserId}>) **bannad**${by}${why}${link}`;
  }
  return `📤 **${name}** (<@${discordUserId}>) är inte längre medlem${link}`;
}

/** A nickname changed between two scans, whoever changed it. */
export function formatMemberRenamed({ discordUserId, from, to }) {
  return `✏️ <@${discordUserId}> — smeknamn: \`${from || "—"}\` → \`${to || "—"}\``;
}

/**
 * A role change someone other than the bot made, from the Discord audit log.
 *
 * The actor is the reason this line exists. The bot's own role changes are
 * already logged as they happen, so what is left is a moderator editing roles by
 * hand — and "who did it" is the first question asked about one of those.
 */
export function formatManualRoleChange({
  discordUserId,
  actorId,
  added,
  removed,
  reason,
}) {
  const by = actorId ? ` (av <@${actorId}>)` : "";
  const why = reason ? ` — anledning: ${reason}` : "";
  return `🏷️ <@${discordUserId}>${by} — ${describeChanges({ added, removed })}${why}`;
}

/**
 * A whole-guild resync. One summary line, then one line per changed user —
 * a run over 150 unchanged users must not produce 150 log entries.
 */
export function logSyncAll({ callerId, results }) {
  const errors = results.filter((r) => r.error);
  const changed = results.filter(
    (r) =>
      !r.error && ((r.added?.length ?? 0) > 0 || (r.removed?.length ?? 0) > 0),
  );
  logEvent(
    `🔁 <@${callerId}> körde \`/refresh-scoutid alla:true\` — ${results.length} användare, ${changed.length} ändrade, ${errors.length} fel`,
  );
  for (const r of changed) {
    if (wasStripped(r)) {
      logEvent(
        `🔒 <@${r.discordUserId}> saknar Scout-rollen — roller strippade, ${UNVERIFIED} satt`,
      );
    } else {
      logEvent(`   ↳ <@${r.discordUserId}> — ${describeChanges(r)}`);
    }
  }
  for (const r of errors) {
    logEvent(`   ↳ ⚠️ <@${r.discordUserId}> — ${r.error}`);
  }
}
