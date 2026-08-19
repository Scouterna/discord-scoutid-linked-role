/**
 * `getDesiredRoles` and `getNicknameSuffix` — the decision about who gets which
 * role, which is the decision about who can see which channel.
 *
 * No emulator needed: the ScoutNet participant list is cached in process memory
 * (it exceeds Table Storage's per-property limit), so stubbing `fetch` and
 * clearing that cache is enough to drive the whole path.
 *
 * The config here mirrors production closely enough that the cases mean something
 * — same question ids, same patterns, same flat markers.
 */
import test from "node:test";
import assert from "node:assert/strict";

// dotenv prints a banner to stdout on every config() call, and the test runner
// uses that same stream for its own protocol. Quiet it before config.js loads.
process.env.DOTENV_CONFIG_QUIET = "true";

process.env.TABLE_CONNECTION_STRING =
  "DefaultEndpointsProtocol=https;AccountName=unittest;AccountKey=dGVzdA==;EndpointSuffix=core.windows.net";
process.env.TABLE_NAME = "unittest";
process.env.SCOUTNET_EVENT_ID = "9999";
process.env.SCOUTNET_PARTICIPANTS_APIKEY = "fake";
process.env.SCOUTNET_SCOUT_ROLE = "scout";
process.env.SCOUTNET_EVENT_ROLE = "wsj-event";
process.env.SCOUTNET_FEE_ROLES =
  "25694:deltagare,25696:ist,25702:ist,33293:ledare,25697:cmt";
process.env.SCOUTNET_DIVISION_ROLES =
  "deltagare:88168:Deltagare-{div}:Deltagare-Väntande," +
  "ist:88168:IST-Patrull-{div}:IST-Väntande," +
  "ledare:107592:Ledare-{div}:Ledare-Väntande";
process.env.SCOUTNET_CATEGORY_ROLES = "ledare:Ledare,ist:IST";
process.env.SCOUTNET_NICKNAME_SUFFIXES =
  "deltagare:{div}:,ledare:AL{div}:AL,ist:IST-{div}:IST,cmt::CMT";

const storage = await import("../../src/storage.js");
const roles = await import("../../src/roles.js");

/** Serve one participant list to the next ScoutNet fetch. */
async function withParticipants(participants) {
  await storage.clearScoutNetCache();
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ participants }),
  });
}

const FEE = { deltagare: 25694, ist: 25696, istOther: 25702, ledare: 33293, cmt: 25697 };

test("a linked member always gets the scout role", async () => {
  await withParticipants({});
  // Not in the event at all: linking alone earns the marker and nothing else.
  assert.deepEqual(await roles.getDesiredRoles("1"), ["scout"]);
});

test("a cancelled registration counts as not registered", async () => {
  await withParticipants({
    1: { fee_id: FEE.deltagare, cancelled_date: "2026-05-01", questions: { 88168: "7" } },
  });
  const r = await roles.getDesiredRoles("1");
  assert.deepEqual(r, ["scout"], "a cancelled participant must lose event access");
});

test("a participant gets the event role, the division role and no flat marker", async () => {
  await withParticipants({
    1: { fee_id: FEE.deltagare, cancelled_date: null, questions: { 88168: "7" } },
  });
  const r = await roles.getDesiredRoles("1");
  // Zero-padded to two digits: ScoutNet answers "7", the Discord role is "-07".
  assert.deepEqual(r, ["scout", "wsj-event", "Deltagare-07"]);
  // Participants deliberately have no flat marker — its absence is what makes
  // the AutoMod link filter apply to them.
  assert.ok(!r.includes("Deltagare"), "participants must not get a flat marker");
});

test("a leader gets both the division role and the flat marker", async () => {
  await withParticipants({
    2: { fee_id: FEE.ledare, cancelled_date: null, questions: { 107592: "12" } },
  });
  const r = await roles.getDesiredRoles("2");
  assert.deepEqual(r, ["scout", "wsj-event", "Ledare", "Ledare-12"]);
});

test("each category reads its own question for the division", async () => {
  // A leader's division comes from 107592; answering only 88168 must not be
  // mistaken for a division.
  await withParticipants({
    3: { fee_id: FEE.ledare, cancelled_date: null, questions: { 88168: "5" } },
  });
  assert.deepEqual(await roles.getDesiredRoles("3"), [
    "scout",
    "wsj-event",
    "Ledare",
    "Ledare-Väntande",
  ]);
});

test("a missing division answer falls back to the pending role", async () => {
  await withParticipants({
    4: { fee_id: FEE.deltagare, cancelled_date: null, questions: {} },
  });
  assert.deepEqual(await roles.getDesiredRoles("4"), [
    "scout",
    "wsj-event",
    "Deltagare-Väntande",
  ]);
});

test("both IST travel groups produce the same patrol role", async () => {
  // The patrols share one numbering across rundresa and egenresa, so patrol 07
  // belongs to exactly one of them and the bot need not tell them apart.
  await withParticipants({
    5: { fee_id: FEE.ist, cancelled_date: null, questions: { 88168: "7" } },
    6: { fee_id: FEE.istOther, cancelled_date: null, questions: { 88168: "7" } },
  });
  const a = await roles.getDesiredRoles("5");
  const b = await roles.getDesiredRoles("6");
  assert.deepEqual(a, b);
  assert.ok(a.includes("IST-Patrull-07"));
  assert.ok(a.includes("IST"), "IST should also get its flat marker");
});

test("a category with no division config uses the category name as the role", async () => {
  await withParticipants({
    7: { fee_id: FEE.cmt, cancelled_date: null, questions: {} },
  });
  const r = await roles.getDesiredRoles("7");
  // Returned lowercase; the guild role is `CMT` and matching is case-insensitive
  // in syncUserRoles. Changing that match would break this silently.
  assert.deepEqual(r, ["scout", "wsj-event", "cmt"]);
});

test("an unmapped fee id yields event access but no category role", async () => {
  await withParticipants({
    8: { fee_id: 111111, cancelled_date: null, questions: { 88168: "3" } },
  });
  // `/audit-scoutid` reports the unknown fee_id; the person still gets in, which
  // is the safer failure — they are registered for the event.
  assert.deepEqual(await roles.getDesiredRoles("8"), ["scout", "wsj-event"]);
});

test("a division number of 10 or more is not padded further", async () => {
  await withParticipants({
    9: { fee_id: FEE.deltagare, cancelled_date: null, questions: { 88168: "42" } },
  });
  assert.deepEqual(await roles.getDesiredRoles("9"), [
    "scout",
    "wsj-event",
    "Deltagare-42",
  ]);
});

test("a ScoutNet failure degrades to the scout role instead of throwing", async () => {
  await storage.clearScoutNetCache();
  globalThis.fetch = async () => ({
    ok: false,
    status: 500,
    statusText: "Server Error",
    text: async () => "boom",
  });
  // Linking must not fail because ScoutNet is down; the user gets the marker and
  // a later `/refresh-scoutid` fills in the rest.
  assert.deepEqual(await roles.getDesiredRoles("1"), ["scout"]);
});

// --- Nickname suffixes ---

test("the suffix uses the division when there is one", async () => {
  await withParticipants({
    2: { fee_id: FEE.ledare, cancelled_date: null, questions: { 107592: "12" } },
  });
  assert.equal(await roles.getNicknameSuffix("2"), " (AL12)");
});

test("the suffix falls back to the division-less form", async () => {
  await withParticipants({
    2: { fee_id: FEE.ledare, cancelled_date: null, questions: {} },
  });
  assert.equal(await roles.getNicknameSuffix("2"), " (AL)");
});

test("a participant's suffix is the bare division number", async () => {
  await withParticipants({
    1: { fee_id: FEE.deltagare, cancelled_date: null, questions: { 88168: "3" } },
  });
  assert.equal(await roles.getNicknameSuffix("1"), " (03)");
});

test("a configured empty half means no suffix at all", async () => {
  // deltagare is configured as `{div}:` — nothing without a division.
  await withParticipants({
    1: { fee_id: FEE.deltagare, cancelled_date: null, questions: {} },
  });
  assert.equal(await roles.getNicknameSuffix("1"), "");
});

test("someone outside the event gets no suffix", async () => {
  await withParticipants({});
  assert.equal(await roles.getNicknameSuffix("1"), "");
});

test("CMT gets a suffix even with no division", async () => {
  await withParticipants({
    7: { fee_id: FEE.cmt, cancelled_date: null, questions: {} },
  });
  assert.equal(await roles.getNicknameSuffix("7"), " (CMT)");
});
