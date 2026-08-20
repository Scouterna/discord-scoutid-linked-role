/**
 * The event log switched off.
 *
 * A separate file because `LOG_CHANNEL_ID` has to be absent from the moment
 * config.js is first imported. Cache-busting the import of eventlog.js does not
 * help: it re-imports the module but not its already-resolved `./config.js`, so
 * the fresh instance still sees the old value. One process, one configuration.
 *
 * The property under test is that an unset channel makes everything else behave
 * identically — no throw, no queue growth, no API call.
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
// Empty rather than deleted: dotenv would otherwise fill it in from the repo's
// own .env, and the test would pass or fail depending on the developer's setup.
process.env.LOG_CHANNEL_ID = "";

let calls = 0;
globalThis.fetch = async () => {
  calls++;
  return { ok: true, status: 200, json: async () => ({}) };
};

const eventlog = await import("../../src/eventlog.js");

test("an unset channel means no API calls and no errors", async () => {
  eventlog.logEvent("ska inte skickas");
  eventlog.logLinked({
    discordUserId: "1",
    scoutId: "1",
    name: "Anna",
    roles: [],
  });
  eventlog.logSyncAll({
    callerId: "1",
    results: [{ discordUserId: "2", added: ["CMT"], removed: [] }],
  });

  assert.equal(
    await eventlog.flushEventLog(),
    true,
    "flushing a disabled log should succeed",
  );
  assert.equal(calls, 0, "nothing should have been sent");
});

test("the formatters still work with the log switched off", async () => {
  // memberscan uses these to build a dry-run report, which must not depend on
  // whether the channel is configured.
  assert.match(
    eventlog.formatMemberJoined({ discordUserId: "1", name: "Anna" }),
    /Anna/,
  );
  assert.equal(calls, 0);
});
