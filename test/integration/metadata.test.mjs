/**
 * Linked Role metadata — what this app tells Discord, and what the `Scout`
 * role's requirement reads.
 *
 *   docker compose up -d azurite
 *   npm run test:integration
 *
 * Needs the emulator because every path here starts from a stored link and a
 * stored token; whether a token exists is the whole branch.
 *
 * This code was untestable until it moved out of the OAuth callback in
 * server.js, which is why a missing `verified` key survived unnoticed long
 * enough for the `Scout` requirement to be switched off in Server Settings.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { useAzurite } from "../helpers/azurite.mjs";

await useAzurite("metadatatest");
process.env.DISCORD_TOKEN = "fake";
process.env.DISCORD_CLIENT_ID = "app-1";
process.env.DISCORD_CLIENT_SECRET = "shh";
process.env.LOG_CHANNEL_ID = "";

/** Pushed metadata bodies, in order. */
let pushes = [];
/** What ScoutID's userinfo endpoint answers. */
let scoutIDResponse = "json";

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const ok = (body) => ({ ok: true, status: 200, json: async () => body });

  if (u.includes("/role-connection")) {
    pushes.push(JSON.parse(opts.body));
    return ok({});
  }

  if (u.includes("userinfo.php")) {
    if (scoutIDResponse === "html") {
      // What SimpleSAMLphp actually answers for a token it no longer accepts:
      // HTTP *200* with an HTML page. `response.ok` is true, and `.json()`
      // throws `Unexpected token '<'`.
      return {
        ok: true,
        status: 200,
        json: async () => JSON.parse("<!DOCTYPE html><html></html>"),
      };
    }
    return ok({
      given_name: "Anna",
      family_name: "Andersson",
      profile: "111",
      email: "anna@example.com",
    });
  }

  throw new Error(`unexpected fetch: ${opts.method ?? "GET"} ${u}`);
};

const storage = await import("../../src/storage.js");
const metadata = await import("../../src/metadata.js");

/** A linked user with usable Discord tokens and, optionally, ScoutID ones. */
async function link(
  userId,
  scoutId,
  { discordToken = true, scoutIDToken = true } = {},
) {
  await storage.setLinkedScoutIDUserId(userId, scoutId);
  if (discordToken) {
    await storage.storeDiscordTokens(userId, {
      access_token: "at",
      refresh_token: "rt",
      // Far in the future, so no refresh round trip is involved.
      expires_at: Date.now() + 3600_000,
    });
  }
  if (scoutIDToken) {
    await storage.storeScoutIDTokens(scoutId, {
      access_token: "at",
      refresh_token: "rt",
      expires_at: Date.now() + 3600_000,
    });
  }
}

test("the push carries `verified: true`", async () => {
  // The key the registered schema declares and the `Scout` requirement reads.
  // Nothing pushed it until 2026-08-20, so Discord held no value, the
  // requirement could never be satisfied, and it ended up switched off.
  pushes = [];
  scoutIDResponse = "json";
  await link("u1", "111");

  await metadata.updateMetadata("u1");

  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].metadata.verified, true);
  assert.equal(pushes[0].metadata.name, "Anna Andersson");
});

test("a dead ScoutID token does not cost the user their `verified` flag", async () => {
  // ScoutID's refresh token is stored but never used, so `getUserData` fails for
  // every link older than the access token's lifetime. That must degrade the
  // *display* fields only: losing `verified` here would revoke the Scout role
  // over a name lookup.
  pushes = [];
  scoutIDResponse = "html";
  await link("u2", "222");

  await metadata.updateMetadata("u2");

  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].metadata.verified, true);
  assert.equal(pushes[0].metadata.name, undefined, "no name is expected here");
  assert.equal(pushes[0].metadata.scoutid, "222");
});

test("a link with no Discord token cannot be pushed at all", async () => {
  pushes = [];
  await link("u3", "333", { discordToken: false });

  await assert.rejects(
    () => metadata.updateMetadata("u3"),
    /Discord OAuth-tokens saknas/,
  );
  assert.deepEqual(pushes, []);
});

test("pushAllMetadata separates 'no token' from 'failed'", async () => {
  // They need different remedies, and only one of them *has* a remedy: a user
  // with no stored token can only fix it by running /linked-role themselves, and
  // they are exactly who loses the Scout role when the requirement goes on. That
  // list is the reason to run this before flipping the switch, so it must not be
  // buried among transient errors.
  pushes = [];
  scoutIDResponse = "json";

  const result = await metadata.pushAllMetadata();

  assert.ok(result.pushed.includes("u1"), "u1 has tokens and should be pushed");
  assert.ok(
    result.pushed.includes("u2"),
    "a dead ScoutID token is not a failure",
  );
  assert.deepEqual(result.noTokens, ["u3"]);
  assert.deepEqual(result.failed, []);
  assert.equal(result.total, 3);
  // Every push must carry the flag — that is the state the requirement reads.
  assert.ok(pushes.length >= 2);
  assert.ok(pushes.every((p) => p.metadata.verified === true));
});

test("a dry run reports the same split and pushes nothing", async () => {
  pushes = [];

  const result = await metadata.pushAllMetadata({ dryRun: true });

  assert.deepEqual(result.pushed.sort(), ["u1", "u2"]);
  assert.deepEqual(result.noTokens, ["u3"]);
  assert.deepEqual(pushes, [], "a dry run must not touch Discord");
  assert.match(metadata.formatPushSummary(result), /dry-run/);
});

test("the summary names who has to act themselves", async () => {
  // The one line an admin has to read before switching the requirement on.
  const summary = metadata.formatPushSummary(
    await metadata.pushAllMetadata({ dryRun: true }),
  );
  assert.match(summary, /utan Discord-token/);
  assert.match(summary, /linked-role/);
  assert.match(summary, /u3/);
});
