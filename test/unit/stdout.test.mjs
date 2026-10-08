/**
 * What the CLI jobs print. stdout ends up in a log store every organisation
 * member can read, so it must not carry ScoutNet member numbers, names or
 * nicknames. (The Discord event log is a separate, private channel.)
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.DOTENV_CONFIG_QUIET = "true";
process.env.TABLE_CONNECTION_STRING =
  "DefaultEndpointsProtocol=https;AccountName=unittest;AccountKey=dGVzdA==;EndpointSuffix=core.windows.net";
process.env.TABLE_NAME = "unittest";
process.env.DISCORD_TOKEN = "fake";
process.env.DISCORD_GUILD_ID = "G1";

const { formatRefreshSummary } = await import("../../src/refresh.js");
const { formatPruneSummary } = await import("../../src/prune.js");

test("formatRefreshSummary says a nickname changed without printing it", () => {
  const out = formatRefreshSummary({
    results: [{}],
    changed: [
      {
        discordUserId: "42",
        added: ["Ledare-12"],
        removed: ["Gammal"],
        nickname: "Anna Andersson (AL12)",
      },
    ],
    errors: [],
    dryRun: false,
  });
  assert.match(out, /42 — \+ Ledare-12 · - Gammal · smeknamn ändrat/);
  assert.doesNotMatch(out, /Anna|Andersson|AL12/);
});

test("formatPruneSummary does not print the member number", () => {
  const out = formatPruneSummary({
    links: 5,
    removed: [{ discordUserId: "42", scoutId: "1234567" }],
    kept: [],
    dryRun: false,
  });
  assert.match(out, /42/);
  assert.doesNotMatch(out, /1234567/);
});
