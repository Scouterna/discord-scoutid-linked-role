/**
 * The env-var parsers in config.js.
 *
 * These decide which Discord role every member gets, from strings typed by hand
 * into a ConfigMap. A parser that silently drops a malformed entry does not fail —
 * it hands out the wrong roles, or none, to a whole category of people. So the
 * tests pin down what happens to bad input as much as to good input.
 *
 * They are called directly rather than through `process.env` and a re-imported
 * module. The earlier version did the latter, and importing config.js once per
 * case made dotenv print its banner to stdout fourteen times, straight into the
 * stream the test runner uses for its own protocol. It passed locally and failed
 * in CI with "Unable to deserialize cloned data" — a good argument for testing a
 * pure function as a pure function.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.DOTENV_CONFIG_QUIET = "true";
process.env.TABLE_CONNECTION_STRING =
  "DefaultEndpointsProtocol=https;AccountName=unittest;AccountKey=dGVzdA==;EndpointSuffix=core.windows.net";

const {
  parseFeeRoles,
  parseNicknameSuffixes,
  parseDivisionRoles,
  parseCategoryRoles,
  parseMemberEvents,
} = await import("../../src/config.js");

test("fee roles map fee ids to categories", () => {
  assert.deepEqual(
    parseFeeRoles("25694:deltagare,25696:ist,33293:ledare,25697:cmt"),
    {
      25694: "deltagare",
      25696: "ist",
      33293: "ledare",
      25697: "cmt",
    },
  );
});

test("several fee ids may share one category", () => {
  // Two IST travel groups both map to `ist`: the patrol numbering is shared, so
  // the bot cannot and need not tell them apart.
  const m = parseFeeRoles("25696:ist,25702:ist");
  assert.equal(m["25696"], "ist");
  assert.equal(m["25702"], "ist");
});

test("a repeated fee id keeps the last category", () => {
  // The production config contains `46628:cmt` twice. Harmless, but the
  // behaviour should be known rather than discovered during an incident.
  assert.equal(parseFeeRoles("1:ist,1:cmt")["1"], "cmt");
});

test("fee roles tolerate whitespace and skip incomplete pairs", () => {
  assert.deepEqual(parseFeeRoles(" 1 : ist , 2 , :x , 3:cmt "), {
    1: "ist",
    3: "cmt",
  });
});

test("an empty fee-role config is null, not an empty object", () => {
  // roles.js branches on truthiness, so the difference matters.
  assert.equal(parseFeeRoles(""), null);
  assert.equal(parseFeeRoles(undefined), null);
  assert.equal(parseFeeRoles("garbage"), null);
});

test("division roles carry a per-category question id and both patterns", () => {
  const m = parseDivisionRoles(
    "deltagare:88168:Deltagare-{div}:Deltagare-Väntande,ledare:107592:Ledare-{div}:Ledare-Väntande",
  );
  assert.deepEqual(m.deltagare, {
    questionId: "88168",
    withDiv: "Deltagare-{div}",
    withoutDiv: "Deltagare-Väntande",
  });
  // Each category asks ScoutNet a different question for its division number.
  assert.equal(m.ledare.questionId, "107592");
});

test("a division entry with the wrong number of parts is dropped whole", () => {
  // Four colon-separated parts are required. A three-part entry is not
  // half-applied — it vanishes, and that category then falls back to using the
  // category name as its role. Worth knowing: the symptom is a missing
  // `Deltagare-07`, not a parse error.
  const m = parseDivisionRoles(
    "deltagare:88168:Deltagare-{div},ledare:107592:Ledare-{div}:Ledare-Väntande",
  );
  assert.equal(m.deltagare, undefined);
  assert.ok(m.ledare, "the well-formed entry should survive");
});

test("nickname suffixes allow an empty half", () => {
  const m = parseNicknameSuffixes(
    "deltagare:{div}:,ledare:AL{div}:AL,cmt::CMT",
  );
  // deltagare gets a suffix only when a division is known; cmt only when not.
  assert.deepEqual(m.deltagare, { withDiv: "{div}", withoutDiv: "" });
  assert.deepEqual(m.cmt, { withDiv: "", withoutDiv: "CMT" });
  assert.deepEqual(m.ledare, { withDiv: "AL{div}", withoutDiv: "AL" });
});

test("flat category roles are a plain category-to-role map", () => {
  assert.deepEqual(parseCategoryRoles("ledare:Ledare,ist:IST"), {
    ledare: "Ledare",
    ist: "IST",
  });
});

test("deltagare deliberately has no flat marker", () => {
  // Its absence is what makes the AutoMod link filter hit participants: the rule
  // exempts the markers, and there is none for them. A marker added here would
  // silently switch the filter off for every participant.
  assert.equal(
    parseCategoryRoles("ledare:Ledare,ist:IST").deltagare,
    undefined,
  );
});

test("member events default to join, leave and nickname", () => {
  const s = parseMemberEvents(undefined);
  assert.deepEqual([...s].sort(), ["join", "leave", "nickname"]);
  // `roles` needs View Audit Log, so it is never on by default.
  assert.equal(s.has("roles"), false);
});

test("member events can be switched off entirely", () => {
  for (const value of ["off", "none", "", "  ", "OFF"]) {
    assert.equal(
      parseMemberEvents(value).size,
      0,
      `"${value}" should disable the scan`,
    );
  }
});

test("member events ignore unknown names and accept case and spacing", () => {
  assert.deepEqual([...parseMemberEvents(" Join , ROLES , bogus ")].sort(), [
    "join",
    "roles",
  ]);
});

test("every accepted member event is recognised", () => {
  const s = parseMemberEvents("join,leave,nickname,roles");
  assert.deepEqual([...s].sort(), ["join", "leave", "nickname", "roles"]);
});
