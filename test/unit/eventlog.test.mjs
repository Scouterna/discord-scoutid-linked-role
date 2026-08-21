/**
 * The event log's three standing rules, plus the batching that keeps it inside
 * Discord's message limit.
 *
 * From CLAUDE.md, and each one is a real failure mode rather than a preference:
 * it must never throw into a caller (a failed log write must not turn a
 * successful link into an error for the user), never delay a caller (a slow
 * Discord API must not slow down `/refresh-scoutid`), and never lose its buffer
 * on shutdown.
 */
import test from "node:test";
import assert from "node:assert/strict";

// dotenv prints a banner to stdout on every config() call, and the test runner
// uses that same stream for its own protocol. Quiet it before config.js loads.
process.env.DOTENV_CONFIG_QUIET = "true";

process.env.TABLE_CONNECTION_STRING =
  "DefaultEndpointsProtocol=https;AccountName=unittest;AccountKey=dGVzdA==;EndpointSuffix=core.windows.net";
process.env.TABLE_NAME = "unittest";
process.env.DISCORD_TOKEN = "fake";
process.env.LOG_CHANNEL_ID = "C1";

const eventlog = await import("../../src/eventlog.js");

let posts = [];
let failWith = null;
let delayMs = 0;

globalThis.fetch = async (url, opts = {}) => {
  if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  if (failWith) return { ok: false, status: failWith, json: async () => ({}) };
  posts.push(JSON.parse(opts.body));
  return { ok: true, status: 200, json: async () => ({}) };
};

async function drain() {
  const ok = await eventlog.flushEventLog();
  return { ok, posts: posts.splice(0) };
}

test("logEvent returns before anything is sent", async () => {
  // The write happens on a timer. If this ever became synchronous, a slow
  // Discord API would start delaying slash commands.
  delayMs = 50;
  const started = Date.now();
  eventlog.logEvent("en rad");
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 20, `logEvent blocked for ${elapsed}ms`);
  await drain();
  delayMs = 0;
});

test("several lines are batched into one message", async () => {
  eventlog.logEvent("rad ett");
  eventlog.logEvent("rad två");
  eventlog.logEvent("rad tre");
  const { posts: sent } = await drain();
  assert.equal(sent.length, 1, "three short lines should cost one API call");
  assert.match(sent[0].content, /rad ett[\s\S]*rad två[\s\S]*rad tre/);
});

test("every line carries a Discord timestamp", async () => {
  eventlog.logEvent("tidsstämplad");
  const { posts: sent } = await drain();
  // `<t:...:T>` renders in each viewer's own timezone, which a fixed string cannot.
  assert.match(sent[0].content, /^<t:\d+:T> tidsstämplad/);
});

test("mentions are suppressed so an audit trail is not a notification storm", async () => {
  eventlog.logEvent("<@123456789> fick en roll");
  const { posts: sent } = await drain();
  // Lines carry `<@id>` on purpose, to be clickable. Without this every entry
  // would ping the person it is about.
  assert.deepEqual(sent[0].allowed_mentions, { parse: [] });
});

test("a long run is split across messages under Discord's limit", async () => {
  for (let i = 0; i < 60; i++) eventlog.logEvent(`rad ${i} ${"x".repeat(60)}`);
  const { posts: sent } = await drain();
  assert.ok(sent.length > 1, "should have split into several messages");
  for (const p of sent) {
    assert.ok(
      p.content.length <= 2000,
      `message of ${p.content.length} chars exceeds the limit`,
    );
  }
  // Nothing may be dropped in the splitting.
  const all = sent.map((p) => p.content).join("\n");
  for (let i = 0; i < 60; i++) assert.match(all, new RegExp(`rad ${i} `));
});

test("a single oversized line is truncated rather than spinning forever", async () => {
  eventlog.logEvent("y".repeat(5000));
  const { posts: sent } = await drain();
  assert.equal(sent.length, 1);
  assert.ok(sent[0].content.length <= 2000);
});

test("an overfull queue drops lines and says so", async () => {
  // The cap is a backstop against unbounded growth. Dropping silently would make
  // the log look complete when it is not.
  for (let i = 0; i < 900; i++) eventlog.logEvent(`rad ${i}`);
  const { posts: sent } = await drain();
  const all = sent.map((p) => p.content).join("\n");
  assert.match(all, /rad\(er\) tappade/);
});

test("a failed write reports failure instead of throwing", async () => {
  failWith = 403;
  eventlog.logEvent("den här går inte fram");
  // The scan depends on this answer to decide whether it may advance its
  // snapshot, and no caller may ever see an exception from logging.
  const ok = await eventlog.flushEventLog();
  assert.equal(ok, false);
  failWith = null;
  posts = [];
});

test("a failed write drops the buffer instead of retrying forever", async () => {
  failWith = 403;
  eventlog.logEvent("förlorad");
  await eventlog.flushEventLog();
  failWith = null;
  const { ok, posts: sent } = await drain();
  assert.equal(ok, true);
  // Holding a channel we cannot write to would just grow the queue; the same
  // lines are in the pod log regardless.
  assert.equal(sent.length, 0, "the failed line should not reappear later");
});

test("flushing an empty buffer succeeds without an API call", async () => {
  const { ok, posts: sent } = await drain();
  assert.equal(ok, true);
  assert.equal(sent.length, 0);
});

// --- The formatters used by the linking and sync flows ---

test("a successful link names the roles it granted", async () => {
  eventlog.logLinked({
    discordUserId: "1",
    scoutId: "12345",
    name: "Anna Andersson",
    roles: ["scout", "Ledare-12"],
  });
  const { posts: sent } = await drain();
  assert.match(sent[0].content, /Anna Andersson/);
  assert.match(sent[0].content, /12345/);
  assert.match(sent[0].content, /Ledare-12/);
});

test("a manual link records who linked whom", async () => {
  eventlog.logManualLink({
    discordUserId: "1",
    scoutId: "999",
    previousScoutId: "111",
    callerId: "42",
    result: { added: ["CMT"], removed: [] },
  });
  const { posts: sent } = await drain();
  // A manual link is an admin vouching for an identity the OAuth flow never
  // confirmed, so both parties belong in the line.
  assert.match(sent[0].content, /<@42>/);
  assert.match(sent[0].content, /<@1>/);
  assert.match(
    sent[0].content,
    /111/,
    "replacing an existing link should be visible",
  );
});

test("a sync that changed nothing is not logged", async () => {
  eventlog.logSync({
    discordUserId: "1",
    callerId: "1",
    result: { added: [], removed: [] },
  });
  const { posts: sent } = await drain();
  // A feed that records non-events is a feed nobody reads.
  assert.equal(sent.length, 0);
});

test("losing the Scout role gets its own unmistakable line", async () => {
  eventlog.logSync({
    discordUserId: "1",
    callerId: "1",
    result: { added: ["Overifierad"], removed: ["Ledare-12", "wsj-event"] },
  });
  const { posts: sent } = await drain();
  // It is the one failure an admin cannot fix for the user, and it would
  // otherwise read as an ordinary role removal.
  assert.match(sent[0].content, /Scout-rollen/);
  // And it has to say what the user must actually *do*. This asserted the word
  // "re-verifiera" while the line told people to run `/linked-role`, which is
  // not a command — the assertion was satisfied by advice nobody could follow.
  // Pin the action instead: clicking Link on the role inside Discord is the only
  // thing that grants a connection-gated role.
  assert.match(sent[0].content, /Kanaler och roller/);
  assert.match(sent[0].content, /Länka/);
});

test("a whole-guild resync is one summary plus only the changed users", async () => {
  const results = [
    { discordUserId: "1", added: ["CMT"], removed: [] },
    { discordUserId: "2", added: [], removed: [] },
    { discordUserId: "3", added: [], removed: [] },
    { discordUserId: "4", error: "Inte länkad till ScoutID" },
  ];
  eventlog.logSyncAll({ callerId: "42", results });
  const { posts: sent } = await drain();
  const all = sent.map((p) => p.content).join("\n");
  assert.match(all, /4 användare/);
  assert.match(all, /1 ändrade/);
  assert.match(all, /1 fel/);
  assert.match(all, /<@1>/);
  // A run over 150 unchanged users must not produce 150 entries.
  assert.doesNotMatch(all, /<@2>/);
  assert.doesNotMatch(all, /<@3>/);
});

test("a rename alone counts as a change", async () => {
  // It did not, so a sync whose only effect was correcting someone's name from
  // ScoutNet reported "0 ändrade" and printed no line at all. Invisible while a
  // human ran the command and watched the reply; permanently invisible once the
  // CronJob runs it at four in the morning.
  eventlog.logSyncAll({
    callerId: "42",
    results: [
      { discordUserId: "1", added: [], removed: [], nickname: "Anna A (AL12)" },
    ],
  });
  const { posts: sent } = await drain();
  const all = sent.map((p) => p.content).join("\n");
  assert.match(all, /1 ändrade/);
  assert.match(all, /<@1>/);
  assert.match(all, /Anna A \(AL12\)/);
});

test("the scheduled sync logs a summary even when nothing changed", async () => {
  // Deliberately different from the per-user lines, which stay silent. A
  // scheduled job that logs nothing is indistinguishable from a scheduled job
  // that stopped running — and this one exists precisely so nobody has to
  // remember it, so its heartbeat has to be visible. One line a night.
  eventlog.logScheduledSyncAll({
    results: [
      { discordUserId: "1", added: [], removed: [] },
      { discordUserId: "2", added: [], removed: [] },
    ],
  });
  const { posts: sent } = await drain();
  const all = sent.map((p) => p.content).join("\n");
  assert.match(all, /Nattlig rollsynk/);
  assert.match(all, /2 användare, 0 ändrade, 0 fel/);
  // Still no per-user noise.
  assert.doesNotMatch(all, /<@1>/);
  // And no caller, because there was none — this is where `<@undefined>` would
  // show up if the summary line were copied from logSyncAll.
  assert.doesNotMatch(all, /undefined/);
});
