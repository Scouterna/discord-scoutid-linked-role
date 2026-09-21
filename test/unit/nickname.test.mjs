/**
 * `fitNickname` — how a name and its suffix are made to fit Discord's 32
 * characters, and `{divnamn}` in a suffix pattern.
 *
 * The property worth pinning is which half gives way. Before this, the nickname
 * was `(base + suffix).substring(0, NICK_MAX)`, so the *suffix* was cut — and a
 * cut suffix has no closing paren, which `stripNickSuffix` needs to find it
 * again. The member kept a mangled division forever: every later sync rebuilt
 * the same string, compared it against itself and reported no change, and a
 * member who moved to another troop went on displaying the old one. Measured
 * against the event's 2 117 people with a troop, 228 of them need shortening
 * once the troop name is in the suffix.
 *
 * Pure functions, so no emulator and no ScoutNet: only the config has to exist
 * before guild.js loads.
 */
import test from "node:test";
import assert from "node:assert/strict";

// dotenv prints a banner to stdout on every config() call, and the test runner
// uses that same stream for its own protocol. Quiet it before config.js loads.
process.env.DOTENV_CONFIG_QUIET = "true";

process.env.SCOUTNET_DIVISION_NAMES = "07:Musen,12:Trollsländan";

const {
  fitNickname,
  abbreviatedNames,
  withDivision,
  stripNickSuffix,
  NICK_MAX,
} = await import("../../src/guild.js");

const TROLL = " (AL12-Trollsländan)";

test("a name that fits is left alone", () => {
  assert.equal(fitNickname("Sam Ek", " (07-Musen)"), "Sam Ek (07-Musen)");
});

test("the surname gives way to an initial, not the suffix", () => {
  assert.equal(
    fitNickname("Alexandra Johansson", TROLL),
    "Alexandra J (AL12-Trollsländan)",
  );
});

test("a multi-word surname is shortened from the right", () => {
  // "Anna Svensson B" is 15 and still does not fit beside a 20-character
  // suffix, so the next word gives way too.
  assert.equal(
    fitNickname("Anna Svensson Berg", TROLL),
    "Anna S B (AL12-Trollsländan)",
  );
  assert.deepEqual(abbreviatedNames("Anna Svensson Berg"), [
    "Anna Svensson B",
    "Anna S B",
  ]);
});

test("a short name element is kept whole, not spent for one character", () => {
  // Real names from the event: "Gao" is a surname entire, "af" and "van der"
  // are particles. Reducing them to an initial buys one or two characters and
  // costs the element. Words of three characters or fewer stay.
  assert.equal(
    fitNickname("Jennifer Yfver Gao", " (42-Nyckelpigan)"),
    "Jennifer Y Gao (42-Nyckelpigan)",
  );
  assert.equal(
    fitNickname("Gustav Lind af Hageby", " (44-Krabban)"),
    "Gustav Lind af H (44-Krabban)",
  );
  // Only one step exists: shortening "van" or "der" changes nothing, so the
  // duplicate forms are dropped rather than tried three times.
  assert.deepEqual(abbreviatedNames("Marijn van der Sluijs"), [
    "Marijn van der S",
  ]);
});

test("the first name is never abbreviated away", () => {
  // Nothing shorter than the first name is on offer, so the remainder is cut —
  // but only after every abbreviation has been tried.
  const nick = fitNickname("Bartholomewhildegard", TROLL);
  assert.ok(nick.startsWith("Barthol"), nick);
  assert.ok(nick.endsWith(TROLL), nick);
});

test("the suffix survives intact, whatever the name", () => {
  for (const name of [
    "Sam Ek",
    "Alexandra Johansson",
    "Anna Svensson Berg",
    "Bartholomewhildegard Lindqvist-Åkerström",
  ]) {
    const nick = fitNickname(name, TROLL);
    assert.ok(nick.endsWith(TROLL), `${name} → ${nick}`);
    assert.ok(nick.length <= NICK_MAX, `${name} → ${nick} (${nick.length})`);
  }
});

test("the result can be stripped and re-suffixed — a troop change lands", () => {
  // This is the regression. A truncated suffix left no closing paren, so the
  // base could never be recovered and the *old* division stuck forever.
  const first = fitNickname("Alexandra Johansson", TROLL);
  const base = stripNickSuffix(first);
  assert.equal(base, "Alexandra J");

  const moved = fitNickname("Alexandra Johansson", " (AL07-Musen)");
  assert.equal(moved, "Alexandra Johansson (AL07-Musen)");
  assert.notEqual(moved, first);
});

test("no base name means no rename", () => {
  assert.equal(fitNickname("", TROLL), "");
  assert.equal(fitNickname(null, TROLL), "");
});

test("{divnamn} resolves from the configured names", () => {
  assert.equal(withDivision("AL{div}-{divnamn}", 12), "AL12-Trollsländan");
  assert.equal(withDivision("{div}-{divnamn}", 7), "07-Musen");
});

test("an unnamed division drops the placeholder and its separator", () => {
  // Degrades to what the suffix looked like before names existed, rather than
  // leaving "AL44-" or printing "{divnamn}" at people.
  assert.equal(withDivision("AL{div}-{divnamn}", 44), "AL44");
  assert.equal(withDivision("Ledare-{div}", 44), "Ledare-44");
});
