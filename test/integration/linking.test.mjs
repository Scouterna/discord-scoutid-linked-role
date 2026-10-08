/**
 * The `/scoutid-oauth-callback` route: the one request a member's whole linking
 * hangs on, driven over a real socket against real Table Storage.
 *
 *   docker compose up -d azurite
 *   npm run test:integration
 *
 * It exists because of what happened on 2026-08-24. The metadata push was
 * awaited unwrapped, so a Discord 429 — a *transient* refusal, on a call that
 * would have worked a second later — reached the outer catch and answered a
 * member whose link had already been stored with a bare `500`. No roles, no
 * nickname, no line in the event log, nothing to act on. She did the only thing
 * the page left her: ran the flow again, three times in ten seconds.
 *
 * Nothing tested that path, because it is an exception branch in a route that
 * needs a signed cookie, a state row and four different upstreams to reach.
 * That is exactly the sort of path worth the harness.
 */
import test from "node:test";
import assert from "node:assert/strict";
import signature from "cookie-signature";

import { useAzurite } from "../helpers/azurite.mjs";

await useAzurite("linktest");
process.env.DISCORD_TOKEN = "fake";
process.env.DISCORD_CLIENT_ID = "app-1";
process.env.DISCORD_CLIENT_SECRET = "shh";
process.env.DISCORD_PUBLIC_KEY = "00";
process.env.DISCORD_GUILD_ID = "G1";
process.env.COOKIE_SECRET = "test-cookie-secret";
process.env.SCOUTID_CLIENT_ID = "sid";
process.env.SCOUTID_CLIENT_SECRET = "sid-secret";
process.env.SCOUTNET_EVENT_ID = "9999";
process.env.SCOUTNET_PARTICIPANTS_APIKEY = "fake";
process.env.SCOUTNET_SCOUT_ROLE = "scout";
process.env.SCOUTNET_EVENT_ROLE = "Event";
process.env.SCOUTNET_FEE_ROLES = "25697:cmt";
process.env.SCOUTNET_NICKNAME_SUFFIXES = "cmt::CMT";
process.env.LOG_CHANNEL_ID = "C1";

const GUILD_ROLES = [
  { id: "r-scout", name: "scout", managed: true },
  { id: "r-event", name: "Event", managed: false },
  { id: "r-cmt", name: "CMT", managed: false },
];

/** What the role-connection PUT answers. 429 stands in for the real incident. */
let pushStatus = 200;
/** What a write to the member answers. 404 = this user is not in the guild. */
let memberWriteStatus = 200;
/** What a read of the member answers: the membership check before linking. */
let memberReadStatus = 200;
let participants = {};
/** ScoutNet answering 503 — the outage `allowIncomplete` exists for. */
let scoutnetDown = false;
const calls = { rolesAdded: [], nicks: [], logs: [] };

const storage = await import("../../src/storage.js");
const eventlog = await import("../../src/eventlog.js");
const { app } = await import("../../src/server.js");
const { RELINK_PATH } = await import("../../src/metadata.js");

const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
const BASE = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  // The test's own requests, or the route would answer itself.
  if (u.startsWith(BASE)) return realFetch(url, opts);
  const ok = (body) => ({ ok: true, status: 200, json: async () => body });
  const refused = (status) => ({
    ok: false,
    status,
    json: async () => ({}),
    text: async () => "{}",
  });

  // Discord's half of the flow, for the cases that start at its callback.
  if (u.endsWith("/oauth2/token")) {
    return ok({
      access_token: "dc-at",
      refresh_token: "dc-rt",
      expires_in: 3600,
    });
  }
  if (u.endsWith("/oauth2/@me")) {
    return ok({ user: { id: "u9", username: "andra", global_name: null } });
  }
  if (u.includes("access_token.php")) {
    return ok({ access_token: "sid-at", expires_in: 3600 });
  }
  if (u.includes("userinfo.php")) {
    return {
      ok: true,
      status: 200,
      // getUserData reads the body as text first: SimpleSAMLphp answers a dead
      // token with HTTP 200 and an HTML page.
      text: async () =>
        JSON.stringify({
          given_name: "Sandra",
          family_name: "Gauffin",
          profile: "3259703",
          email: "s@example.com",
        }),
    };
  }
  if (u.includes("scoutnet.se")) {
    return scoutnetDown ? refused(503) : ok({ participants });
  }
  if (u.includes("/role-connection")) {
    if (pushStatus === 200) return ok({});
    return {
      ok: false,
      status: pushStatus,
      statusText: "Too Many Requests",
      // Honoured by the retry now, so keep it short: three attempts otherwise
      // spend the old fixed ladder's 3 seconds inside one test.
      headers: { get: (h) => (h === "retry-after" ? "0.05" : null) },
      text: async () => '{"retry_after":0.05}',
      json: async () => ({ retry_after: 0.05 }),
    };
  }
  if (u.endsWith("/roles")) return ok(GUILD_ROLES);
  if (u.includes("/channels/C1/messages")) {
    calls.logs.push(JSON.parse(opts.body).content);
    return ok({});
  }
  const roleChange = u.match(/\/members\/[^/]+\/roles\/([^/?]+)$/);
  if (roleChange) {
    if (memberWriteStatus !== 200) return refused(memberWriteStatus);
    calls.rolesAdded.push(roleChange[1]);
    return ok({});
  }
  if (u.match(/\/members\/[^/?]+$/)) {
    if (opts.method === "PATCH") {
      if (memberWriteStatus !== 200) return refused(memberWriteStatus);
      calls.nicks.push(JSON.parse(opts.body).nick);
      return ok({});
    }
    if (memberReadStatus !== 200) return refused(memberReadStatus);
    return ok({ user: { id: "u1" }, nick: null, roles: ["r-scout"] });
  }
  throw new Error(`unexpected fetch: ${opts.method ?? "GET"} ${u}`);
};

/** Walk the callback the way a returning browser does: state row + cookie. */
async function completeLinking({
  userId,
  state,
  discordUsername = "sandra",
  storeState = true,
  cookieState = state,
}) {
  calls.rolesAdded.length = 0;
  calls.nicks.length = 0;
  calls.logs.length = 0;
  if (storeState) {
    await storage.storeStateData(state, {
      discordUserId: userId,
      discordUsername,
      codeVerifier: "pkce",
    });
  }
  await storage.storeDiscordTokens(userId, {
    access_token: "at",
    refresh_token: "rt",
    expires_at: Date.now() + 3600_000,
  });
  await storage.clearScoutNetCache();

  const signed = "s:" + signature.sign(cookieState, process.env.COOKIE_SECRET);
  const res = await fetch(
    `${BASE}/scoutid-oauth-callback?state=${state}&code=abc`,
    { headers: { Cookie: `clientState=${encodeURIComponent(signed)}` } },
  );
  const body = await res.text();
  await eventlog.flushEventLog();
  return { status: res.status, body };
}

test("a linking that works answers with the success page", async () => {
  pushStatus = 200;
  participants = {
    3259703: {
      fee_id: 25697,
      cancelled_date: null,
      first_name: "Sandra",
      last_name: "Gauffin",
      questions: {},
    },
  };

  const { status, body } = await completeLinking({ userId: "u1", state: "s1" });
  assert.equal(status, 200);
  assert.match(body, /Successfully Linked/);
  assert.equal(await storage.getLinkedScoutIDUserId("u1"), "3259703");
  assert.deepEqual(calls.rolesAdded.sort(), ["r-cmt", "r-event"]);
  assert.deepEqual(calls.nicks, ["Sandra Gauffin (CMT)"]);
  assert.match(calls.logs.join("\n"), /✅ \*\*Sandra Gauffin\*\*/);
});

test("a failed metadata push still links, still assigns, and says what is missing", async () => {
  pushStatus = 429;
  participants = {
    3259703: {
      fee_id: 25697,
      cancelled_date: null,
      first_name: "Sandra",
      last_name: "Gauffin",
      questions: {},
    },
  };

  const { status, body } = await completeLinking({ userId: "u2", state: "s2" });
  // The old answer here was 500 and nothing else.
  assert.equal(status, 200);
  assert.match(body, /Nästan klart/);
  assert.ok(
    body.includes(RELINK_PATH),
    "the page must name the path back, and take it from the single source",
  );
  assert.doesNotMatch(body, /\{\{/, "no placeholder left unreplaced");
  // The role name is configurable, so an HTML file is the easiest place for a
  // copy of it to hide: nothing that imports the page would ever fail.
  assert.match(body, /<strong>scout<\/strong>-rollen/);

  // Everything that does not depend on the push still happened.
  assert.equal(await storage.getLinkedScoutIDUserId("u2"), "3259703");
  assert.deepEqual(calls.rolesAdded.sort(), ["r-cmt", "r-event"]);
  assert.deepEqual(calls.nicks, ["Sandra Gauffin (CMT)"]);

  // And the log says the one thing an admin cannot see anywhere else: Discord
  // holds no `verified`, so the Scout role will not arrive on its own.
  const line = calls.logs.join("\n");
  assert.match(line, /⚠️/);
  assert.match(line, /Discord kunde inte uppdateras/);
  assert.match(
    line,
    new RegExp(RELINK_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
});

test("a member who is not in the event is told so, on the page and in the log", async () => {
  // This test used to assert the success page — the bug written down as the
  // specification. A member with no roles was told it worked.
  pushStatus = 200;
  participants = {};

  const { status, body } = await completeLinking({ userId: "u3", state: "s3" });
  assert.equal(status, 200);
  assert.match(body, /Inga roller/);
  assert.match(body, /aktiv anmälan/);
  assert.doesNotMatch(body, /Successfully Linked/);
  // Nothing to grant — `scout` is managed, Discord's to give — and the line
  // says why rather than stopping at "inga roller".
  assert.deepEqual(calls.rolesAdded, []);
  const line = calls.logs.join("\n");
  assert.match(line, /inga roller — inte anmäld i eventet/);
  assert.match(line, /⚠️/);
  assert.doesNotMatch(line, /✅/);
});

test("a ScoutNet outage says the roles are coming, not that none exist", async () => {
  pushStatus = 200;
  scoutnetDown = true;
  try {
    const { status, body } = await completeLinking({
      userId: "u6",
      state: "s6",
    });
    assert.equal(status, 200);
    assert.match(body, /Rollerna kommer senare/);
    assert.doesNotMatch(body, /aktiv anmälan/);
    assert.equal(await storage.getLinkedScoutIDUserId("u6"), "3259703");
  } finally {
    scoutnetDown = false;
  }
});

test("an account outside the server is turned away before anything is stored", async () => {
  // 2026-09-21: a leader linked fifteen times from a second Discord account,
  // created seven minutes before the first attempt, that had never joined the
  // server. 2026-09-26: a participant, five times. Each linking stored a link
  // that could never give anything, and every sync since reported its 404.
  // The name is the one fact that tells a member which account they used — and
  // it is text someone else chose, so it must arrive escaped.
  pushStatus = 200;
  memberReadStatus = 404;
  participants = {
    3259703: {
      fee_id: 25697,
      cancelled_date: null,
      first_name: "Sandra",
      last_name: "Gauffin",
      questions: {},
    },
  };

  try {
    const { status, body } = await completeLinking({
      userId: "u4",
      state: "s4",
      discordUsername: "<b>hugo</b>",
    });
    assert.equal(status, 200);
    assert.match(body, /Fel Discord-konto/);
    assert.match(body, /ingenting kopplats/);
    assert.ok(body.includes("&lt;b&gt;hugo&lt;/b&gt;"), "username escaped");
    assert.ok(!body.includes("<b>hugo</b>"));
    assert.ok(body.includes(RELINK_PATH), "names the path back");
    assert.doesNotMatch(body, /\{\{/, "no placeholder left unreplaced");
    assert.equal(await storage.getLinkedScoutIDUserId("u4"), null);
    assert.deepEqual(calls.rolesAdded, []);
    assert.deepEqual(calls.nicks, []);

    const line = calls.logs.join("\n");
    assert.match(line, /⛔/);
    assert.match(line, /3259703/);
    assert.match(line, /inte är med i servern — ingenting sparat/);
  } finally {
    memberReadStatus = 200;
  }
});

test("the Discord step turns the account away before ScoutID", async () => {
  // Checked first where it is cheapest for the member: no ScoutID login for a
  // linking that cannot work, and no Discord tokens stored for the account.
  memberReadStatus = 404;
  calls.logs.length = 0;
  try {
    const signed = "s:" + signature.sign("d1", process.env.COOKIE_SECRET);
    const res = await fetch(
      `${BASE}/discord-oauth-callback?state=d1&code=abc`,
      {
        headers: { Cookie: `clientState=${encodeURIComponent(signed)}` },
        redirect: "manual",
      },
    );
    const body = await res.text();
    await eventlog.flushEventLog();
    assert.equal(res.status, 200, "a page, not the redirect to ScoutID");
    assert.match(body, /Fel Discord-konto/);
    assert.match(body, /andra/);
    assert.equal(await storage.getDiscordTokens("u9"), null);
    assert.match(calls.logs.join("\n"), /⛔/);
  } finally {
    memberReadStatus = 200;
  }
});

test("an unanswered membership check does not stop a linking", async () => {
  // A Discord error is an unknown, not a no — the same rule as everywhere else.
  pushStatus = 200;
  memberReadStatus = 500;
  participants = {
    3259703: {
      fee_id: 25697,
      cancelled_date: null,
      first_name: "Sandra",
      last_name: "Gauffin",
      questions: {},
    },
  };
  try {
    const { body } = await completeLinking({ userId: "u6", state: "s6" });
    assert.doesNotMatch(body, /Fel Discord-konto/);
    assert.equal(await storage.getLinkedScoutIDUserId("u6"), "3259703");
  } finally {
    memberReadStatus = 200;
  }
});

test("a member who leaves between the check and the writes is still told", async () => {
  // The writes' 404 remains the fallback, and the link is the half that worked.
  pushStatus = 200;
  memberWriteStatus = 404;
  participants = {
    3259703: {
      fee_id: 25697,
      cancelled_date: null,
      first_name: "Sandra",
      last_name: "Gauffin",
      questions: {},
    },
  };
  try {
    const { body } = await completeLinking({ userId: "u10", state: "s10" });
    assert.match(body, /Fel Discord-konto/);
    assert.doesNotMatch(body, /Successfully Linked/);
    const line = calls.logs.join("\n");
    assert.match(line, /inte med i servern/);
    assert.doesNotMatch(line, /finns de i servern/);
  } finally {
    memberWriteStatus = 200;
  }
});

test("a live, mapped participant with a real refusal is not called absent", async () => {
  // 403 is the hierarchy answer. Keeping the two apart is the point of the
  // change: one is fixed in Server Settings, the other by the member.
  pushStatus = 200;
  memberWriteStatus = 403;
  participants = {
    3259703: {
      fee_id: 25697,
      cancelled_date: null,
      first_name: "Sandra",
      last_name: "Gauffin",
      questions: {},
    },
  };

  try {
    const { body } = await completeLinking({ userId: "u5", state: "s5" });
    assert.match(body, /Inga roller/);
    assert.doesNotMatch(body, /Fel Discord-konto/);
    const line = calls.logs.join("\n");
    assert.match(line, /nekade/);
    assert.doesNotMatch(line, /inte med i servern/);
  } finally {
    memberWriteStatus = 200;
  }
});

test("an expired state answers with a page, not a bare 500", async () => {
  // Six times in four days before this: `getStateData` returns null once the
  // ten-minute state is gone, and destructuring it threw.
  const { status, body } = await completeLinking({
    userId: "u7",
    state: "never-stored",
    storeState: false,
  });
  assert.equal(status, 400);
  assert.match(body, /Länkningen gick inte igenom/);
  assert.match(body, /gått ut/);
  assert.equal(await storage.getLinkedScoutIDUserId("u7"), null);
});

test("a cookie from another flow answers with a page, not a bare 403", async () => {
  const { status, body } = await completeLinking({
    userId: "u8",
    state: "s8",
    cookieState: "someone-elses",
  });
  assert.equal(status, 403);
  assert.match(body, /Länkningen gick inte igenom/);
  assert.equal(await storage.getLinkedScoutIDUserId("u8"), null);
});
