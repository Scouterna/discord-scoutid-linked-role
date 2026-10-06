/**
 * `src/prune.js` — removing links for accounts that are not in the server.
 *
 *   docker compose up -d azurite
 *   npm run test:integration
 *
 * The cases are the ways a removal could be wrong: a member list that came back
 * short read as absence, and an error read as a 404. Both must keep the link.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { useAzurite } from "../helpers/azurite.mjs";

await useAzurite("prunetest");
process.env.DISCORD_TOKEN = "fake";
process.env.DISCORD_GUILD_ID = "G1";
process.env.LOG_CHANNEL_ID = "";

/** The guild's member ids, as the paginated list returns them. */
let memberIds = [];
/** What a single-member read answers, per id; absent means 404. */
let memberReads = {};

globalThis.fetch = async (url) => {
  const u = String(url);
  const answer = (status, body = {}) => ({
    ok: status === 200,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  if (u.includes("/members?")) {
    return answer(
      200,
      memberIds.map((id) => ({ user: { id }, roles: [] })),
    );
  }
  const one = u.match(/\/members\/([^/?]+)$/);
  if (one) {
    const status = memberReads[one[1]] ?? 404;
    return answer(status, status === 200 ? { user: { id: one[1] } } : {});
  }
  throw new Error(`unexpected fetch: ${u}`);
};

const storage = await import("../../src/storage.js");
const { runPrune } = await import("../../src/prune.js");

/** Reset storage to exactly these links, with tokens for each. */
async function links(ids) {
  for (const l of await storage.getAllLinkedUsers()) {
    await storage.deleteLink(l.discordUserId);
  }
  for (const id of ids) {
    await storage.setLinkedScoutIDUserId(id, `s-${id}`);
    await storage.storeDiscordTokens(id, { access_token: "at" });
  }
}

test("a link for an account outside the server is removed with its tokens", async () => {
  await links(["in1", "in2", "gone"]);
  memberIds = ["in1", "in2"];
  memberReads = {};

  const result = await runPrune();
  assert.deepEqual(
    result.removed.map((l) => l.discordUserId),
    ["gone"],
  );
  assert.equal(await storage.getLinkedScoutIDUserId("gone"), null);
  assert.equal(await storage.getDiscordTokens("gone"), null);
  assert.equal(await storage.getLinkedScoutIDUserId("in1"), "s-in1");
});

test("a dry run removes nothing", async () => {
  await links(["in1", "in2", "gone"]);
  memberIds = ["in1", "in2"];
  memberReads = {};

  const result = await runPrune({ dryRun: true });
  assert.equal(result.removed.length, 1);
  assert.equal(await storage.getLinkedScoutIDUserId("gone"), "s-gone");
});

test("an account missing from the list but not confirmed absent is kept", async () => {
  // The list said no, the single read could not say anything. An unknown is
  // not a no, so the link stays.
  await links(["in1", "in2", "flaky"]);
  memberIds = ["in1", "in2"];
  memberReads = { flaky: 500 };

  const result = await runPrune();
  assert.deepEqual(result.removed, []);
  assert.deepEqual(
    result.kept.map((l) => l.discordUserId),
    ["flaky"],
  );
  assert.equal(await storage.getLinkedScoutIDUserId("flaky"), "s-flaky");
});

test("a member list that came back short stops the run before any removal", async () => {
  // Every link would look absent against an empty list.
  await links(["a", "b", "c"]);
  memberIds = [];
  memberReads = {};

  await assert.rejects(runPrune(), /refusing to read that as absence/);
  assert.equal((await storage.getAllLinkedUsers()).length, 3);
});
