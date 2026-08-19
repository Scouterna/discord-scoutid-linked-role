/**
 * The env-var parsers in config.js.
 *
 * These decide which Discord role every member gets, from strings typed by hand
 * into a ConfigMap. A parser that silently drops a malformed entry does not fail —
 * it hands out the wrong roles, or none, to a whole category of people. So the
 * tests pin down what happens to bad input as much as to good input.
 *
 * config.js exports only the assembled `config` object and reads `process.env` at
 * import time, so each case sets the environment and re-imports with a
 * cache-busting query string to get a fresh module instance.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.TABLE_CONNECTION_STRING =
  "DefaultEndpointsProtocol=https;AccountName=unittest;AccountKey=dGVzdA==;EndpointSuffix=core.windows.net";

let instance = 0;
async function configWith(env) {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const mod = await import(`../../src/config.js?case=${instance++}`);
  return mod.default;
}

test("fee roles map fee ids to categories", async () => {
  const c = await configWith({
    SCOUTNET_FEE_ROLES: "25694:deltagare,25696:ist,33293:ledare,25697:cmt",
  });
  assert.deepEqual(c.SCOUTNET_FEE_ROLES, {
    25694: "deltagare",
    25696: "ist",
    33293: "ledare",
    25697: "cmt",
  });
});

test("several fee ids may share one category", async () => {
  // Two travel groups both map to `ist`: the patrol numbering is shared, so the
  // bot cannot and need not tell them apart.
  const c = await configWith({ SCOUTNET_FEE_ROLES: "25696:ist,25702:ist" });
  assert.equal(c.SCOUTNET_FEE_ROLES["25696"], "ist");
  assert.equal(c.SCOUTNET_FEE_ROLES["25702"], "ist");
});

test("a repeated fee id keeps the last category", async () => {
  // The production config contains `46628:cmt` twice. Harmless, but the
  // behaviour should be known rather than discovered during an incident.
  const c = await configWith({ SCOUTNET_FEE_ROLES: "1:ist,1:cmt" });
  assert.equal(c.SCOUTNET_FEE_ROLES["1"], "cmt");
});

test("fee roles tolerate whitespace and skip incomplete pairs", async () => {
  const c = await configWith({ SCOUTNET_FEE_ROLES: " 1 : ist , 2 , :x , 3:cmt " });
  assert.deepEqual(c.SCOUTNET_FEE_ROLES, { 1: "ist", 3: "cmt" });
});

test("an empty fee-role config is null, not an empty object", async () => {
  // roles.js branches on truthiness, so the difference matters.
  assert.equal((await configWith({ SCOUTNET_FEE_ROLES: "" })).SCOUTNET_FEE_ROLES, null);
  assert.equal((await configWith({ SCOUTNET_FEE_ROLES: "garbage" })).SCOUTNET_FEE_ROLES, null);
});

test("division roles carry a per-category question id and both patterns", async () => {
  const c = await configWith({
    SCOUTNET_DIVISION_ROLES:
      "deltagare:88168:Deltagare-{div}:Deltagare-Väntande,ledare:107592:Ledare-{div}:Ledare-Väntande",
  });
  assert.deepEqual(c.SCOUTNET_DIVISION_ROLES.deltagare, {
    questionId: "88168",
    withDiv: "Deltagare-{div}",
    withoutDiv: "Deltagare-Väntande",
  });
  // Each category asks ScoutNet a different question for its division number.
  assert.equal(c.SCOUTNET_DIVISION_ROLES.ledare.questionId, "107592");
});

test("a division entry with the wrong number of parts is dropped whole", async () => {
  // Four colon-separated parts are required. A three-part entry is not
  // half-applied — it vanishes, and that category then falls back to using the
  // category name as its role. Worth knowing: the symptom is a missing
  // `Deltagare-07`, not a parse error.
  const c = await configWith({
    SCOUTNET_DIVISION_ROLES: "deltagare:88168:Deltagare-{div},ledare:107592:Ledare-{div}:Ledare-Väntande",
  });
  assert.equal(c.SCOUTNET_DIVISION_ROLES.deltagare, undefined);
  assert.ok(c.SCOUTNET_DIVISION_ROLES.ledare, "the well-formed entry should survive");
});

test("nickname suffixes allow an empty half", async () => {
  const c = await configWith({
    SCOUTNET_NICKNAME_SUFFIXES: "deltagare:{div}:,ledare:AL{div}:AL,cmt::CMT",
  });
  // deltagare gets a suffix only when a division is known; cmt only when not.
  assert.deepEqual(c.SCOUTNET_NICKNAME_SUFFIXES.deltagare, { withDiv: "{div}", withoutDiv: "" });
  assert.deepEqual(c.SCOUTNET_NICKNAME_SUFFIXES.cmt, { withDiv: "", withoutDiv: "CMT" });
  assert.deepEqual(c.SCOUTNET_NICKNAME_SUFFIXES.ledare, { withDiv: "AL{div}", withoutDiv: "AL" });
});

test("flat category roles are a plain category-to-role map", async () => {
  const c = await configWith({ SCOUTNET_CATEGORY_ROLES: "ledare:Ledare,ist:IST" });
  assert.deepEqual(c.SCOUTNET_CATEGORY_ROLES, { ledare: "Ledare", ist: "IST" });
});

test("deltagare deliberately has no flat marker", async () => {
  // Its absence is what makes the AutoMod link filter hit participants: the rule
  // exempts the markers, and there is none for them. A marker added here would
  // silently switch the filter off for every participant.
  const c = await configWith({ SCOUTNET_CATEGORY_ROLES: "ledare:Ledare,ist:IST" });
  assert.equal(c.SCOUTNET_CATEGORY_ROLES.deltagare, undefined);
});

test("member events default to join, leave and nickname", async () => {
  const c = await configWith({ LOG_MEMBER_EVENTS: undefined });
  assert.deepEqual([...c.LOG_MEMBER_EVENTS].sort(), ["join", "leave", "nickname"]);
  // `roles` needs View Audit Log, so it is never on by default.
  assert.equal(c.LOG_MEMBER_EVENTS.has("roles"), false);
});

test("member events can be switched off entirely", async () => {
  for (const value of ["off", "none", "", "  "]) {
    const c = await configWith({ LOG_MEMBER_EVENTS: value });
    assert.equal(c.LOG_MEMBER_EVENTS.size, 0, `"${value}" should disable the scan`);
  }
});

test("member events ignore unknown names and accept case and spacing", async () => {
  const c = await configWith({ LOG_MEMBER_EVENTS: " Join , ROLES , bogus " });
  assert.deepEqual([...c.LOG_MEMBER_EVENTS].sort(), ["join", "roles"]);
});
