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
/** How many times anything reached for ScoutID. Must stay at zero. */
let scoutIDCalls = 0;
/** What Discord answers when the role-connection is *read* back. */
let connectionStatus = 200;

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const ok = (body) => ({ ok: true, status: 200, json: async () => body });

  if (u.includes("/role-connection")) {
    if ((opts.method ?? "GET") === "GET") {
      // The liveness probe. A read, so it has no effect on what it measures.
      return {
        ok: connectionStatus === 200,
        status: connectionStatus,
        json: async () => ({}),
        text: async () => "{}",
      };
    }
    pushes.push(JSON.parse(opts.body));
    return ok({});
  }

  if (u.includes("userinfo.php")) {
    scoutIDCalls++;
    throw new Error("ScoutID must not be contacted from a stored token");
  }

  throw new Error(`unexpected fetch: ${opts.method ?? "GET"} ${u}`);
};

const storage = await import("../../src/storage.js");
const metadata = await import("../../src/metadata.js");

/** A linked user with usable Discord tokens and, optionally, ScoutID ones. */
async function link(userId, scoutId, { discordToken = true } = {}) {
  await storage.setLinkedScoutIDUserId(userId, scoutId);
  if (discordToken) {
    await storage.storeDiscordTokens(userId, {
      access_token: "at",
      refresh_token: "rt",
      // Far in the future, so no refresh round trip is involved.
      expires_at: Date.now() + 3600_000,
    });
  }
}

test("the push carries `verified: true` and nothing that needs a live ScoutID token", async () => {
  // `verified` is the key the registered schema declares and the `Scout`
  // requirement reads. `scoutid` rides along outside the schema, which Discord
  // stores and no requirement looks at.
  pushes = [];
  scoutIDCalls = 0;
  await link("u1", "111");

  await metadata.updateMetadata("u1");

  assert.equal(pushes.length, 1);
  assert.deepEqual(pushes[0].metadata, { verified: true, scoutid: "111" });
});

test("the push never reaches for ScoutID at all", async () => {
  // This replaces a test that asserted a *failed* ScoutID fetch still left
  // `verified` intact. The failure was guaranteed: the stored access token is
  // dead for every link because nothing refreshes it, so the call cost one
  // certain-to-fail request per user and logged a misleading parse error. Now
  // there is no call to survive, which is a stronger guarantee than a try/catch —
  // and the stub turns any attempt into a hard failure so it cannot creep back.
  pushes = [];
  scoutIDCalls = 0;
  await link("u2", "222");

  await metadata.updateMetadata("u2");

  assert.equal(scoutIDCalls, 0, "something asked ScoutID for data");
  assert.equal(pushes[0].metadata.verified, true);
  assert.equal(pushes[0].metadata.name, undefined);
  assert.equal(pushes[0].metadata.email, undefined);
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
  // Names the action, not a command that does not exist. `/linked-role` is an
  // HTTP route, and opening it does not grant a connection-gated role anyway —
  // only clicking Link inside Discord does.
  assert.match(summary, /Kanaler och roller/);
  assert.match(summary, /Länka/);
  assert.match(summary, /u3/);
});

// --- verifyConnection: three answers, and only one of them may cause a strip ---

test("a live grant is accepted", async () => {
  connectionStatus = 200;
  await link("v1", "901");
  assert.deepEqual((await metadata.verifyConnection("v1")).status, "accepted");
});

test("a revoked grant is rejected", async () => {
  // 401 is Discord saying the user removed the app. That *is* the revocation the
  // Scout role exists to represent, so acting on it is the point.
  connectionStatus = 401;
  await link("v2", "902");
  assert.equal((await metadata.verifyConnection("v2")).status, "rejected");
});

test("an unreachable Discord is unknown, never a no", async () => {
  // The one that matters. If a 500 counted as "not verified", a Discord outage
  // would strip every member at once — the same failure a swallowed ScoutNet
  // error used to cause one user at a time.
  connectionStatus = 500;
  await link("v3", "903");
  assert.equal((await metadata.verifyConnection("v3")).status, "unknown");
});

test("no stored token is rejected, deliberately the less generous reading", async () => {
  // No path leads from here to verified except the user re-linking, so treating
  // it as unknown would leave them verified forever and make /link-scoutid a
  // standing bypass. They have no Scout role either, so this matches what a sync
  // already does today.
  connectionStatus = 200;
  await link("v4", "904", { discordToken: false });
  const r = await metadata.verifyConnection("v4");
  assert.equal(r.status, "rejected");
  assert.match(r.detail, /inget sparat/);
});
