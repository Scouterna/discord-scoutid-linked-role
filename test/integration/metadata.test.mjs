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
process.env.SCOUTNET_EVENT_ID = "9999";
process.env.SCOUTNET_PARTICIPANTS_APIKEY = "fake";

/** Pushed metadata bodies, in order. */
let pushes = [];
/** How many times anything reached for ScoutID. Must stay at zero. */
let scoutIDCalls = 0;
/** What Discord answers when the role-connection is *read* back. */
let connectionStatus = 200;
/** Access tokens Discord has already expired, whatever the stored expiry says. */
let staleAccessTokens = new Set();
/** How many reads went out with a stale token — the margin cases pin zero. */
let staleReads = 0;
/** What a refresh yields; null is Discord saying the grant is gone. */
let refreshedTokens = null;
let refreshCalls = 0;
/** ScoutNet's participant list, and whether the fetch fails. */
let participants = {};
let scoutNetDown = false;

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const ok = (body) => ({ ok: true, status: 200, json: async () => body });

  if (u.includes("/role-connection")) {
    if ((opts.method ?? "GET") === "GET") {
      // The liveness probe. A read, so it has no effect on what it measures.
      // A stale token answers 401 regardless of `connectionStatus`: Discord
      // judges the token it was handed, not the one the store believes in.
      const token = (opts.headers?.Authorization ?? "").replace("Bearer ", "");
      if (staleAccessTokens.has(token)) {
        staleReads++;
        return {
          ok: false,
          status: 401,
          json: async () => ({}),
          text: async () => "{}",
        };
      }
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

  if (u.includes("oauth2/token")) {
    // A refresh attempt. The body is how Discord says the grant is gone.
    refreshCalls++;
    if (refreshedTokens) return ok(refreshedTokens);
    return {
      ok: false,
      status: 400,
      statusText: "Bad Request",
      json: async () => ({ error: "invalid_grant" }),
      text: async () => '{"error": "invalid_grant"}',
    };
  }

  if (u.includes("scoutnet.se")) {
    if (scoutNetDown) throw new Error("ScoutNet unreachable");
    return ok({ participants });
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
  // 401 is Discord saying no — but only after the refresh token has been asked
  // too: a revoked app kills both, so here the retry also fails, and *that* is
  // the revocation the Scout role exists to represent.
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

test("a dead refresh token is rejected, not unknown", async () => {
  // The user revoked the app *and* their access token has expired, so the probe
  // never reaches the role-connection read — the refresh fails first, with
  // `invalid_grant` in the body. That is Discord saying the grant is gone, which
  // is the same real no as a 401, and it must not hide behind "could not ask":
  // unknown is never acted on, so it would leave the member verified forever.
  connectionStatus = 200;
  await storage.setLinkedScoutIDUserId("v5", "905");
  await storage.storeDiscordTokens("v5", {
    access_token: "expired",
    refresh_token: "revoked",
    expires_at: Date.now() - 1000,
  });
  const r = await metadata.verifyConnection("v5");
  assert.equal(r.status, "rejected");
  assert.match(r.detail, /invalid_grant/i);
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

test("an access token Discord already expired is not a revocation", async () => {
  // The flap: the probe refreshes tokens at 04:10 and probes them at 04:10
  // seven days later, and the stored expiry — stamped after the round trip —
  // sits seconds later than Discord's. A 401 in that gap is a stale cache, not
  // a revoked grant. The refresh token answers for the grant: alive here, so
  // the probe must refresh, read again, and accept — never strip.
  connectionStatus = 200;
  staleAccessTokens = new Set(["at-stale"]);
  refreshedTokens = {
    access_token: "at-fresh",
    refresh_token: "rt-2",
    expires_in: 604800,
  };
  await storage.setLinkedScoutIDUserId("v6", "906");
  await storage.storeDiscordTokens("v6", {
    access_token: "at-stale",
    refresh_token: "rt-1",
    expires_at: Date.now() + 3600_000, // the store still believes in it
  });

  const r = await metadata.verifyConnection("v6");

  assert.equal(r.status, "accepted");
  // Discord rotates on refresh, so the new pair must be what is stored now —
  // the old refresh token is dead the moment the refresh succeeded.
  const stored = await storage.getDiscordTokens("v6");
  assert.equal(stored.access_token, "at-fresh");
  assert.equal(stored.refresh_token, "rt-2");
});

test("a token inside the refresh margin is refreshed before it is used", async () => {
  // What keeps the weekly 04:10 collision from happening at all: a token this
  // close to its stored expiry is already past Discord's, so it never goes out.
  connectionStatus = 200;
  staleReads = 0;
  staleAccessTokens = new Set(["at-old"]);
  refreshedTokens = {
    access_token: "at-new",
    refresh_token: "rt-3",
    expires_in: 604800,
  };
  await storage.setLinkedScoutIDUserId("v7", "907");
  await storage.storeDiscordTokens("v7", {
    access_token: "at-old",
    refresh_token: "rt-old",
    expires_at: Date.now() + 30_000, // inside the 60 s margin
  });

  const r = await metadata.verifyConnection("v7");

  assert.equal(r.status, "accepted");
  assert.equal(staleReads, 0, "the stale token must never reach Discord");
});

test("the read-only probe never refreshes, and a 401 from it is unknown", async () => {
  // The audit's mode. A refresh rotates and re-stores the pair — a write — so
  // the audit may not spend it, and without it a 401 cannot be told apart from
  // a revocation. `unknown` is the honest answer, and the audit already has
  // words for it.
  connectionStatus = 200;
  refreshCalls = 0;
  staleAccessTokens = new Set(["at-stale-ro"]);
  refreshedTokens = {
    access_token: "at-never",
    refresh_token: "rt-never",
    expires_in: 604800,
  };
  await storage.setLinkedScoutIDUserId("v8", "908");
  await storage.storeDiscordTokens("v8", {
    access_token: "at-stale-ro",
    refresh_token: "rt-ro",
    expires_at: Date.now() - 1000, // expired — the full probe would refresh here
  });

  const r = await metadata.verifyConnection("v8", { readOnly: true });

  assert.equal(r.status, "unknown");
  assert.equal(refreshCalls, 0, "read-only must not touch the token endpoint");
  const stored = await storage.getDiscordTokens("v8");
  assert.equal(stored.refresh_token, "rt-ro", "nothing may be re-stored");

  staleAccessTokens = new Set();
  refreshedTokens = null;
});

// --- platform_username: the only part of the push Discord ever displays ---

test("the connection card shows the ScoutNet name", async () => {
  // The metadata keys are read by role requirements and otherwise invisible, so
  // the card said nothing at all until this field was set.
  pushes = [];
  scoutNetDown = false;
  participants = { 777: { first_name: "Anna", last_name: "Andersson" } };
  await storage.clearScoutNetCache();
  await link("p1", "777");

  await metadata.updateMetadata("p1");

  assert.equal(pushes[0].platform_username, "Anna Andersson");
  assert.equal(pushes[0].platform_name, "ScoutID");
});

test("someone with no ScoutNet record still gets a clean push", async () => {
  pushes = [];
  scoutNetDown = false;
  participants = {};
  await storage.clearScoutNetCache();
  await link("p2", "778");

  await metadata.updateMetadata("p2");

  assert.equal(pushes[0].platform_username, "");
  assert.equal(pushes[0].metadata.verified, true);
});

test("a ScoutNet outage still pushes `verified`", async () => {
  // The priority that matters: the flag is what the Scout requirement reads, and
  // a display name is not worth risking it for. The cost is stated rather than
  // hidden — PUT replaces the whole object, so this push clears the shown name
  // until the next one succeeds.
  pushes = [];
  participants = { 779: { first_name: "Erik", last_name: "Svensson" } };
  await storage.clearScoutNetCache();
  await link("p3", "779");
  scoutNetDown = true;

  await metadata.updateMetadata("p3");

  assert.equal(pushes.length, 1, "the push must still happen");
  assert.equal(pushes[0].metadata.verified, true);
  assert.equal(pushes[0].platform_username, "");
});
