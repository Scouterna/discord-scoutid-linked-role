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
  "deltagare:{div}:,ledare:AL{div}:AL,ist:IST{div}:IST,cmt::CMT";
// `grantRoles` returns early without a configured guild, so the cases below
// would all pass vacuously.
process.env.DISCORD_GUILD_ID = "G1";
process.env.DISCORD_TOKEN = "test-token";

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

const FEE = {
  deltagare: 25694,
  ist: 25696,
  istOther: 25702,
  ledare: 33293,
  cmt: 25697,
};

test("a linked member always gets the scout role", async () => {
  await withParticipants({});
  // Not in the event at all: linking alone earns the marker and nothing else.
  assert.deepEqual(await roles.getDesiredRoles("1"), ["scout"]);
});

test("the `cancelled` flag alone counts as cancelled", async () => {
  // ScoutNet carries two fields and the boolean is the broader one: of 2769 live
  // records, 175 had `cancelled: true` and only 168 had a `cancelled_date`. The
  // seven in between were unconfirmed, unpaid registrations cancelled without a
  // date, and reading only the date let them through as live participants.
  await withParticipants({
    1: {
      fee_id: FEE.deltagare,
      cancelled: true,
      cancelled_date: null,
      questions: { 88168: "7" },
    },
  });
  assert.deepEqual(await roles.getDesiredRoles("1"), ["scout"]);
});

test("a cancelled registration counts as not registered", async () => {
  await withParticipants({
    1: {
      fee_id: FEE.deltagare,
      cancelled_date: "2026-05-01",
      questions: { 88168: "7" },
    },
  });
  const r = await roles.getDesiredRoles("1");
  assert.deepEqual(
    r,
    ["scout"],
    "a cancelled participant must lose event access",
  );
});

test("a participant gets the event role, the division role and no flat marker", async () => {
  await withParticipants({
    1: {
      fee_id: FEE.deltagare,
      cancelled_date: null,
      questions: { 88168: "7" },
    },
  });
  const r = await roles.getDesiredRoles("1");
  // Zero-padded to two digits: ScoutNet answers "7", the Discord role is "-07".
  assert.deepEqual(r, ["scout", "wsj-event", "Deltagare-07"]);
  // Participants deliberately have no flat marker — its absence is what makes
  // the AutoMod link filter apply to them.
  assert.ok(
    !r.includes("Deltagare"),
    "participants must not get a flat marker",
  );
});

test("a leader gets both the division role and the flat marker", async () => {
  await withParticipants({
    2: {
      fee_id: FEE.ledare,
      cancelled_date: null,
      questions: { 107592: "12" },
    },
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
    6: {
      fee_id: FEE.istOther,
      cancelled_date: null,
      questions: { 88168: "7" },
    },
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
    9: {
      fee_id: FEE.deltagare,
      cancelled_date: null,
      questions: { 88168: "42" },
    },
  });
  assert.deepEqual(await roles.getDesiredRoles("9"), [
    "scout",
    "wsj-event",
    "Deltagare-42",
  ]);
});

/** Make the next ScoutNet fetch fail the way a real outage does. */
async function withScoutNetDown() {
  await storage.clearScoutNetCache();
  globalThis.fetch = async () => ({
    ok: false,
    status: 500,
    statusText: "Server Error",
    text: async () => "boom",
  });
}

test("a ScoutNet failure throws instead of looking like an empty answer", async () => {
  await withScoutNetDown();
  // This used to return ["scout"], which reads to syncUserRoles as "not
  // registered in the event" — an instruction to take the event, category and
  // division roles away. A ScoutNet outage during `/refresh-scoutid alla:true`
  // therefore disarmed everyone it reached. The throw is the fix.
  await assert.rejects(() => roles.getDesiredRoles("1"), /ScoutNet API error/);
});

test("allowIncomplete degrades to the scout role, for the linking path", async () => {
  await withScoutNetDown();
  // Only the linking flow passes this, and only because it exclusively *adds*
  // roles: verification must not fail because ScoutNet is down, and the rest
  // arrives at the next sync.
  assert.deepEqual(
    await roles.getDesiredRoles("1", { allowIncomplete: true }),
    ["scout"],
  );
});

test("a ScoutNet failure throws for the nickname suffix too", async () => {
  await withScoutNetDown();
  // "" is a real instruction to rename someone without a suffix, not a shrug.
  await assert.rejects(
    () => roles.getNicknameSuffix("2"),
    /ScoutNet API error/,
  );
  assert.equal(
    await roles.getNicknameSuffix("2", { allowIncomplete: true }),
    "",
  );
});

// --- Nickname suffixes ---

test("the suffix uses the division when there is one", async () => {
  await withParticipants({
    2: {
      fee_id: FEE.ledare,
      cancelled_date: null,
      questions: { 107592: "12" },
    },
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
    1: {
      fee_id: FEE.deltagare,
      cancelled_date: null,
      questions: { 88168: "3" },
    },
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

// --- `explainMissingRoles`: why there was nothing to grant ---
//
// The linking log used to end in a bare `→ inga roller`, which said that
// something was wrong without saying what. These cases pin the four answers
// apart — and pin the outage *not* to look like any of the other three.

test("not being in the event is named as such", async () => {
  await withParticipants({});
  assert.equal(await roles.explainMissingRoles("1"), "inte anmäld i eventet");
});

test("a cancelled registration is distinguished from an absent one", async () => {
  await withParticipants({
    1: { fee_id: FEE.cmt, cancelled: true, cancelled_date: "2026-08-01" },
  });
  assert.match(await roles.explainMissingRoles("1"), /avbokad.*2026-08-01/);
  // The flag alone still counts, and says so rather than inventing a date.
  await withParticipants({ 2: { fee_id: FEE.cmt, cancelled: true } });
  assert.match(await roles.explainMissingRoles("2"), /avbokad.*utan datum/);
});

test("an unmapped fee_id names the id and the variable to add it to", async () => {
  await withParticipants({
    1: { fee_id: 99999, cancelled_date: null, questions: {} },
  });
  const why = await roles.explainMissingRoles("1");
  assert.match(why, /99999/);
  assert.match(why, /SCOUTNET_FEE_ROLES/);
});

test("a live, mapped participant has nothing to explain", async () => {
  await withParticipants({
    1: { fee_id: FEE.cmt, cancelled_date: null, questions: {} },
  });
  // null, not a sentence: an empty result for this person means the roles are
  // missing from the guild or the writes failed, and saying "not registered"
  // would send whoever reads it to ScoutNet to look for someone who is there.
  assert.equal(await roles.explainMissingRoles("1"), null);
});

test("a ScoutNet outage is reported as an outage, never as absence", async () => {
  await withScoutNetDown();
  // The whole reason this function exists rather than a check on the role list:
  // the linking path asks with `allowIncomplete`, so "not registered" and
  // "could not ask" both arrive as ["scout"]. Printing the unknown as a known
  // no would move getDesiredRoles' original bug into the log.
  const why = await roles.explainMissingRoles("1");
  assert.match(why, /kunde inte nå ScoutNet/);
  assert.doesNotMatch(why, /anmäld/);
});

test("explaining never throws, whatever ScoutNet does", async () => {
  await storage.clearScoutNetCache();
  globalThis.fetch = async () => {
    throw new Error("socket hang up");
  };
  // It explains a linking; it must not be able to fail one.
  assert.match(await roles.explainMissingRoles("1"), /kunde inte nå ScoutNet/);
});

// --- `grantRoles`: why an empty result is empty ---

const GUILD_ROLES = [
  { id: "r-scout", name: "scout", managed: true },
  { id: "r-event", name: "wsj-event", managed: false },
  { id: "r-led47", name: "Ledare-47", managed: false },
];

/**
 * Drive `grantRoles` over a stubbed Discord: the guild's role list, then one
 * `PUT` per role, answered by `putStatus`.
 */
function withGuild({ guildRoles = GUILD_ROLES, putStatus = 200 } = {}) {
  const attempted = [];
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (href.endsWith("/roles") && (init?.method ?? "GET") === "GET") {
      return { ok: true, status: 200, json: async () => guildRoles };
    }
    if (init?.method === "PUT") {
      attempted.push(href.split("/roles/")[1]);
      if (putStatus === 200) return { ok: true, status: 200 };
      return {
        ok: false,
        status: putStatus,
        json: async () => ({}),
        text: async () => "{}",
      };
    }
    throw new Error(`unexpected request: ${init?.method ?? "GET"} ${href}`);
  };
  return attempted;
}

test("a linking from an account that never joined the server says so", async () => {
  const attempted = withGuild({ putStatus: 404 });
  const { granted, problem } = await roles.grantRoles("u1", [
    "scout",
    "wsj-event",
    "Ledare-47",
  ]);

  // The incident of 2026-09-21: every role existed, the member did not. The old
  // line asked "finns de i servern?" — about the roles — fifteen times, which is
  // the one question that was already answered yes.
  assert.deepEqual(granted, []);
  assert.match(problem, /inte med i servern/);
  assert.match(problem, /annat konto/);
  // The managed role is never attempted, so it cannot be the source of the 404.
  assert.deepEqual(attempted, ["r-event", "r-led47"]);
});

test("a refusal is reported as a refusal, not as an absent member", async () => {
  withGuild({ putStatus: 403 });
  const { problem } = await roles.grantRoles("u1", ["wsj-event"]);
  // 403 is the hierarchy answer — the reading the old text applied to every
  // failure. It is kept, but only where Discord actually gave it.
  assert.match(problem, /nekade/);
  assert.doesNotMatch(problem, /inte med i servern/);
});

test("a role missing from the guild is named, not guessed at", async () => {
  withGuild({ guildRoles: [{ id: "r-scout", name: "scout", managed: true }] });
  const { granted, problem } = await roles.grantRoles("u1", [
    "scout",
    "Ledare-47",
  ]);
  assert.deepEqual(granted, []);
  assert.match(problem, /Ledare-47/);
});

test("the skipped scout role is not a problem", async () => {
  withGuild();
  const { granted, problem } = await roles.grantRoles("u1", [
    "scout",
    "wsj-event",
    "Ledare-47",
  ]);
  // `scout` is managed and absent from `granted` by design — Discord grants it.
  // Reporting that as a fault would put a warning on every healthy linking.
  assert.deepEqual(granted, ["wsj-event", "Ledare-47"]);
  assert.equal(problem, null);
});
