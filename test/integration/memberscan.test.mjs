/**
 * Full-flow tests: runs the real scan against real Table Storage (Azurite) with a
 * stubbed Discord API, several times in sequence, so the diff, the snapshot
 * round-trip and the audit cursors are all exercised together.
 *
 * These need the emulator. Start it first:
 *
 *   docker compose up -d azurite
 *   npm run test:integration
 *
 * `npm test` deliberately does not run this file — `test/unit.test.mjs` covers the
 * pure logic with no setup, and a test suite that cannot run without a container
 * is a test suite that stops being run.
 *
 * Every case here exists because it caught something real. They are labelled.
 */
import test from "node:test";
import assert from "node:assert/strict";

// dotenv prints a banner to stdout on every config() call, and the test runner
// uses that same stream for its own protocol. Quiet it before config.js loads.
process.env.DOTENV_CONFIG_QUIET = "true";

import { useAzurite } from "../helpers/azurite.mjs";

await useAzurite("scantest");
process.env.DISCORD_TOKEN = "fake";
process.env.DISCORD_GUILD_ID = "G1";
process.env.LOG_CHANNEL_ID = "C1";
process.env.LOG_MEMBER_EVENTS = "join,leave,nickname,roles";

const BOT_ID = "900000000000000001";
const MOD_ID = "900000000000000002";
const ROLE_UPDATE = 25;
const KICK = 20;
const BAN = 22;

let members = [];
/** Newest-first per action type, the way Discord returns them. */
let audit = { [ROLE_UPDATE]: [], [KICK]: [], [BAN]: [] };
let auditStatus = 200;
let postShouldFail = false;
const posted = [];

const snowflake = (ms) => String((BigInt(ms) - 1420070400000n) << 22n);
const YEAR_AGO = Date.now() - 400 * 86400000;

const M = (id, username, nick, bot = false) => ({
  user: { id, username, global_name: username, bot },
  nick,
});

/** `user_id` is who did it, `target_id` is who it was done to. */
const entry = (id, userId, targetId, extra = {}) => ({
  id,
  user_id: userId,
  target_id: targetId,
  ...extra,
});
const roleEntry = (id, userId, targetId, added = [], removed = []) =>
  entry(id, userId, targetId, {
    changes: [
      ...(added.length ? [{ key: "$add", new_value: added.map((n) => ({ id: n, name: n })) }] : []),
      ...(removed.length ? [{ key: "$remove", new_value: removed.map((n) => ({ id: n, name: n })) }] : []),
    ],
  });

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes("/audit-logs")) {
    if (auditStatus !== 200) {
      return { ok: false, status: auditStatus, json: async () => ({}), text: async () => "{}" };
    }
    const p = new URL(u).searchParams;
    const type = p.get("action_type");
    const limit = Number(p.get("limit") ?? 50);
    const before = p.get("before");
    let list = audit[type] ?? [];
    if (before) list = list.filter((e) => BigInt(e.id) < BigInt(before));
    return { ok: true, status: 200, json: async () => ({ audit_log_entries: list.slice(0, limit) }) };
  }
  if (u.includes("/members?")) {
    const after = new URL(u).searchParams.get("after");
    return { ok: true, status: 200, json: async () => (after === "0" ? members : []) };
  }
  if (u.includes("/users/@me")) return { ok: true, status: 200, json: async () => ({ id: BOT_ID }) };
  if (u.endsWith("/roles")) return { ok: true, status: 200, json: async () => [] };
  if (u.includes("/messages")) {
    if (postShouldFail) return { ok: false, status: 403, json: async () => ({}) };
    posted.push(JSON.parse(opts.body).content);
    return { ok: true, status: 200, json: async () => ({}) };
  }
  throw new Error(`unexpected fetch: ${u}`);
};

const storage = await import("../../src/storage.js");
const scan = await import("../../src/memberscan.js");

// Fail loudly and usefully if the emulator is not up, rather than 15 confusing
// assertion errors.

async function runScan(opts) {
  posted.length = 0;
  const result = await scan.runMemberScan(opts);
  return { result, out: posted.join("\n") };
}

const ANNA = snowflake(YEAR_AGO);
const ERIK = snowflake(YEAR_AGO - 86400000);
const KIM = snowflake(YEAR_AGO - 2 * 86400000);

test("the first run seeds a baseline silently and does not replay history", async () => {
  // Announcing every existing member as a new arrival would bury the channel and
  // teach everyone to ignore it. Old audit entries must not be replayed either.
  members = [M(ANNA, "anna", "Anna Andersson (AL12)"), M(ERIK, "erik", "Erik Svensson"), M(KIM, "kim", null)];
  audit[ROLE_UPDATE] = [roleEntry("500", MOD_ID, ANNA, ["CMT"])];

  const { result, out } = await runScan();
  assert.equal(out, "", "a baseline run must post nothing");
  assert.equal(result.seeded, 3);

  const stored = await storage.getMemberSnapshot();
  assert.equal(Object.keys(stored.members).length, 3);
  assert.equal(stored.auditCursors[ROLE_UPDATE], "500", "cursor should start at the newest entry");
});

test("a diff reports joins, departures, renames and other people's role changes", async () => {
  const NY = snowflake(Date.now() - 8 * 60000);
  members = [
    M(ANNA, "anna", "Anna Andersson (AL12)"), // unchanged
    M(KIM, "kim", "Kim Nilsson"), // renamed
    M(NY, "nyling", null), // joined
  ];
  audit[ROLE_UPDATE] = [
    roleEntry("700", MOD_ID, KIM, ["Ledare-12"], ["Overifierad"]), // a human: report
    roleEntry("600", BOT_ID, ANNA, ["WSJ-event"]), // the bot itself: never report
    ...audit[ROLE_UPDATE],
  ];
  await storage.setLinkedScoutIDUserId(ERIK, "12345");

  const { out } = await runScan();
  assert.match(out, new RegExp(`<@${NY}>`), "join not reported");
  assert.match(out, new RegExp(`<@${ERIK}>`), "departure not reported");
  assert.match(out, /Erik Svensson/, "departure lost the display name");
  assert.match(out, /länkningen kvarstår/, "orphaned link not flagged");
  assert.match(out, /Kim Nilsson/, "rename not reported");
  assert.match(out, /Ledare-12/, "manual role change not reported");
  assert.match(out, new RegExp(`\\(av <@${MOD_ID}>\\)`), "role change did not name the actor");
  assert.doesNotMatch(out, /WSJ-event/, "reported the bot's OWN role change");
  assert.doesNotMatch(out, /CMT/, "replayed an entry older than the cursor");
  assert.doesNotMatch(out, new RegExp(`<@${ANNA}>`), "reported an unchanged member");

  const stored = await storage.getMemberSnapshot();
  assert.equal(stored.auditCursors[ROLE_UPDATE], "700");
});

test("a quiet run posts nothing", async () => {
  const { result, out } = await runScan();
  assert.equal(out, "");
  assert.equal(result.total, 0);
});

test("a kick is reported as a kick, not as a departure", async () => {
  const KICKED = snowflake(YEAR_AGO - 10);
  members = [...members, M(KICKED, "bråkig", "Bråkig Person")];
  await runScan(); // let the join settle so the next run sees only the removal

  members = members.filter((m) => m.user.id !== KICKED);
  audit[KICK] = [entry("800", MOD_ID, KICKED, { reason: "regelbrott" })];

  const { result, out } = await runScan();
  assert.match(out, /kickad/, "a kick must not read as a plain departure");
  assert.match(out, new RegExp(`<@${MOD_ID}>`), "kick did not name the moderator");
  assert.match(out, /anledning: regelbrott/);
  assert.equal(result.counts.removedByMod, 1);
  assert.match(scan.formatScanSummary(result), /varav 1 kickad\/bannad/);
});

test("a ban outranks a kick for the same person", async () => {
  const BANNED = snowflake(YEAR_AGO - 20);
  members = [...members, M(BANNED, "värre", "Värre Person")];
  await runScan();

  members = members.filter((m) => m.user.id !== BANNED);
  // Kicked and then banned. Reporting "kicked" understates what happened.
  audit[KICK] = [entry("900", MOD_ID, BANNED), ...audit[KICK]];
  audit[BAN] = [entry("901", MOD_ID, BANNED)];

  const { out } = await runScan();
  assert.match(out, /bannad/);
  assert.doesNotMatch(out, /kickad/);
});

test("a departure with no audit entry does not claim to know why", async () => {
  const QUIET = snowflake(YEAR_AGO - 30);
  members = [...members, M(QUIET, "tyst", "Tyst Person")];
  await runScan();

  members = members.filter((m) => m.user.id !== QUIET);
  const { result, out } = await runScan();
  assert.match(out, /är inte längre medlem/);
  assert.doesNotMatch(out, /kickad|bannad/);
  assert.equal(result.counts.removedByMod, 0);
});

test("a failed post leaves the snapshot alone so the next run retries", async () => {
  // In an audit trail a duplicate on retry is cheaper than a hole, so the
  // snapshot must only advance after the lines are actually written.
  const LATE = snowflake(YEAR_AGO - 40);
  members = [...members, M(LATE, "sen", "Sen Ankomst")];
  postShouldFail = true;

  const before = JSON.stringify(await storage.getMemberSnapshot());
  await assert.rejects(() => runScan(), /could not write to the log channel/);
  const after = JSON.stringify(await storage.getMemberSnapshot());
  assert.equal(before, after, "snapshot advanced despite a failed post");

  postShouldFail = false;
  const { out } = await runScan();
  assert.match(out, /Sen Ankomst/, "the missed join was not re-reported");
});

test("a dry run writes nothing at all", async () => {
  // Regression: the formatters used to call logEvent internally, so a dry run
  // queued its lines and the flush timer posted them seconds later.
  const GHOST = snowflake(YEAR_AGO - 50);
  members = [...members, M(GHOST, "spöke", "Spöke Person")];

  const before = JSON.stringify(await storage.getMemberSnapshot());
  const { result, out } = await runScan({ dryRun: true });
  assert.equal(out, "", "a dry run posted to the channel");
  assert.equal(
    JSON.stringify(await storage.getMemberSnapshot()),
    before,
    "a dry run advanced the snapshot",
  );
  // The lines still have to come back, or the dry run shows nothing useful.
  assert.ok(result.lines.some((l) => l.includes("Spöke Person")), "dry run returned no lines");
});

test("an unreadable audit log skips roles but still reports departures", async () => {
  auditStatus = 403;
  const { result, out } = await runScan();
  assert.equal(result.auditUnavailable, true);
  assert.match(out, /Spöke Person/, "a 403 must not stop join reporting");
  assert.match(scan.formatScanSummary(result), /View Audit Log/);
  auditStatus = 200;
});

test("the snapshot survives being larger than one Table Storage property", async () => {
  // A property holds 32K UTF-16 *characters*, not 64K bytes: exactly 32768 is
  // rejected, and at 16384 Azurite returned silently corrupted data — an `ä` came
  // back as two replacement characters. Hence the 8192 chunk size, and hence the
  // length check on read.
  //
  // 800 members rather than 2500. The point is to span many properties, and 800
  // spans eight; 2500 additionally made the request body ~365 KB, which Azurite
  // handled over a docker bridge and mishandled over a published port in CI —
  // dropping the trailing `chunks` property so the read came back empty. Real
  // Table Storage takes a 1 MB entity, so that was the emulator's limit, not the
  // code's, and a test that fails on the emulator's framing tests the emulator.
  const big = {};
  for (let i = 0; i < 800; i++) {
    big[`10000000000000${String(i).padStart(4, "0")}`] = [
      `Förnamn Efternamn ${i} (AL07)`,
      `användarnamn${i}`,
    ];
  }
  const chars = JSON.stringify(big).length;
  assert.ok(chars > 32768, `test data only ${chars} chars — not over the property cap`);
  assert.ok(chars > 4 * 8192, "test data should span more than four chunks");

  const cursors = { 25: "12345678901234567890" };
  await storage.storeMemberSnapshot(big, cursors);
  const back = await storage.getMemberSnapshot();

  // Named separately: a null here means the metadata did not survive the write,
  // which is a different failure from the contents not matching.
  assert.ok(back, "snapshot came back as absent — the chunk metadata did not survive");
  assert.deepEqual(back.members, big, "large snapshot did not round-trip intact");
  assert.equal(
    back.auditCursors[25],
    "12345678901234567890",
    "a snowflake cursor must survive as an exact string, not a rounded number",
  );
});

test("a snapshot whose metadata did not land is treated as absent", async () => {
  // The failure CI found: the chunk data was written but the trailing `chunks`
  // property was not, so the read produced an empty string and returned null —
  // silently, which is indistinguishable from "no snapshot yet". Absent means
  // "seed a baseline"; corrupt means something ate the data. They must not look
  // alike, or a storage problem reads as a fresh install.
  await storage.storeMemberSnapshot({ "1": ["Nick", "user"] }, {});

  const { TableClient } = await import("@azure/data-tables");
  const client = TableClient.fromConnectionString(
    process.env.TABLE_CONNECTION_STRING,
    process.env.TABLE_NAME,
    { allowInsecureConnection: true },
  );
  const e = await client.getEntity("membersnapshot", "current");
  delete e.chunks;
  await client.upsertEntity(e, "Replace");

  assert.equal(await storage.getMemberSnapshot(), null);
});

test("a truncated snapshot is treated as absent rather than diffed", async () => {
  // Silent corruption is the dangerous case: a short read would otherwise diff
  // into a report full of members who never joined and never left.
  const snapshot = { "1": ["Nick", "user"] };
  await storage.storeMemberSnapshot(snapshot, {});
  assert.ok(await storage.getMemberSnapshot(), "sanity: the snapshot should read back");

  const { TableClient } = await import("@azure/data-tables");
  const client = TableClient.fromConnectionString(
    process.env.TABLE_CONNECTION_STRING,
    process.env.TABLE_NAME,
    { allowInsecureConnection: true },
  );
  const e = await client.getEntity("membersnapshot", "current");
  await client.upsertEntity({ ...e, chunk0: e.chunk0.slice(0, -5) }, "Replace");

  assert.equal(await storage.getMemberSnapshot(), null, "a short read was accepted as valid");
});
