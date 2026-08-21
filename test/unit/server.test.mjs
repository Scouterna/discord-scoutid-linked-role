/**
 * The HTTP surface: the interactions endpoint and the health route.
 *
 * The signature check is the only thing between `/interactions` and anyone on
 * the internet posting a forged admin command, so it is tested from both sides —
 * a real ed25519 keypair is generated here and requests are signed properly, the
 * way Discord signs them.
 *
 * `src/server.js` binds no port when imported; it listens only when it is the
 * process entrypoint. These tests bind their own ephemeral port instead, so no
 * HTTP client dependency is needed and the routes run exactly as deployed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.DOTENV_CONFIG_QUIET = "true";
process.env.TABLE_CONNECTION_STRING =
  "DefaultEndpointsProtocol=https;AccountName=unittest;AccountKey=dGVzdA==;EndpointSuffix=core.windows.net";
process.env.TABLE_NAME = "unittest";
process.env.DISCORD_TOKEN = "fake";
process.env.DISCORD_CLIENT_ID = "app-1";
process.env.DISCORD_GUILD_ID = "G1";
process.env.LOG_CHANNEL_ID = "";

// Discord signs with ed25519 and publishes the raw public key as hex. Generating
// a real pair means the valid path is exercised too, not just the rejection.
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const RAW_PUBLIC_KEY = publicKey
  .export({ format: "der", type: "spki" })
  .subarray(12) // strip the fixed SPKI prefix Discord omits
  .toString("hex");
process.env.DISCORD_PUBLIC_KEY = RAW_PUBLIC_KEY;

const { app } = await import("../../src/server.js");

const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
const BASE = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

/**
 * Capture what the background handlers send back to Discord, keyed by the
 * interaction token from the webhook URL.
 *
 * Keyed rather than counted because handlers ACK immediately and do the work
 * about a second later: an earlier test's reply lands while a later one is
 * waiting, and a plain counter picks it up. Each test uses its own token.
 */
const edits = new Map();
const realFetch = globalThis.fetch;

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  // Requests *to* the test server are the tests themselves — pass them through,
  // or the stub answers them and nothing is ever exercised.
  if (u.startsWith(BASE)) return realFetch(url, opts);
  const webhook = u.match(/\/webhooks\/[^/]+\/([^/]+)\//);
  if (webhook) {
    const token = webhook[1];
    if (!edits.has(token)) edits.set(token, []);
    edits.get(token).push(JSON.parse(opts.body));
    return { ok: true, status: 200, json: async () => ({}) };
  }
  // Anything else a handler reaches for is not what this file is testing.
  return { ok: true, status: 200, json: async () => ({}) };
};

/** Wait for the deferred handler behind `token` to reply, or time out. */
async function replyFor(token, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const got = edits.get(token);
    if (got?.length) return got;
    await new Promise((r) => setTimeout(r, 50));
  }
  return [];
}

function post(body, { sign = true } = {}) {
  const raw = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = sign
    ? crypto
        .sign(null, Buffer.from(timestamp + raw), privateKey)
        .toString("hex")
    : "00".repeat(64);
  return fetch(`${BASE}/interactions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-signature-ed25519": signature,
      "x-signature-timestamp": timestamp,
    },
    body: raw,
  });
}

let tokenSeq = 0;
const command = (name, { admin = true, options, token } = {}) => ({
  type: 2,
  guild_id: "G1",
  token: token ?? `tok-${name}-${tokenSeq++}`,
  data: { name, ...(options ? { options } : {}) },
  member: {
    user: { id: "caller-1" },
    // 8 is ADMINISTRATOR; 0 is an ordinary member.
    permissions: admin ? "8" : "0",
  },
});

test("the landing route answers", async () => {
  const res = await fetch(`${BASE}/`);
  assert.equal(res.status, 200);
});

test("liveness depends on nothing outside the process", async () => {
  // The whole reason /healthz exists separately from /readyz. Liveness restarts
  // the pod, so if it reached Table Storage a storage blip would restart every
  // replica at once. This suite has no emulator and no network — and that is
  // exactly the environment /healthz must answer 200 in.
  const res = await fetch(`${BASE}/healthz`);
  assert.equal(res.status, 200);
});

test("readiness fails when storage is unreachable", async () => {
  // The connection string here points at an account that does not exist, which
  // is the closest a unit test gets to a storage outage. 503 is the useful
  // answer: it takes the pod out of the Service instead of leaving it to answer
  // every interaction with an error. /readyz is also what deploy.yml polls.
  //
  // This does not break the suite's no-network rule: the call fails whether or
  // not there is a network, and the route's own 3-second timeout bounds how long
  // it can take to find out. The 200 path needs a real table, so it lives in
  // test/integration/health.test.mjs.
  const res = await fetch(`${BASE}/readyz`);
  assert.equal(res.status, 503);
  // Deliberately says nothing useful: the ingress routes `/` as a prefix, so
  // this answers the public internet, and Azure's errors carry endpoint names
  // and request ids. The reason goes to the pod log.
  assert.equal(await res.text(), "storage unreachable");
});

test("an unsigned interaction is rejected", async () => {
  const res = await post({ type: 1 }, { sign: false });
  assert.equal(res.status, 401);
});

test("a signature over different content is rejected", async () => {
  // Signing one body and sending another is the replay/tamper case.
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto
    .sign(
      null,
      Buffer.from(timestamp + JSON.stringify({ type: 1 })),
      privateKey,
    )
    .toString("hex");
  const res = await fetch(`${BASE}/interactions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-signature-ed25519": signature,
      "x-signature-timestamp": timestamp,
    },
    body: JSON.stringify({ type: 2, data: { name: "audit-scoutid" } }),
  });
  assert.equal(res.status, 401);
});

test("a correctly signed PING is answered with a PONG", async () => {
  // Discord sends this when the endpoint URL is saved, and refuses the URL
  // unless it comes back as `{ type: 1 }`.
  const res = await post({ type: 1 });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { type: 1 });
});

test("an unknown command is refused rather than silently accepted", async () => {
  const res = await post(command("nagot-annat"));
  assert.equal(res.status, 400);
});

for (const name of [
  "refresh-scoutid",
  "status-scoutid",
  "audit-scoutid",
  "scan-scoutid",
  "link-scoutid",
  "adoption-scoutid",
]) {
  test(`/${name} is acknowledged immediately and ephemerally`, async () => {
    // Discord drops the interaction unless it is acknowledged within 3 seconds,
    // so every command defers first and does the real work afterwards. Type 5 is
    // "thinking", flag 64 is ephemeral — an audit report must not land in the
    // channel it was run from.
    const started = Date.now();
    const res = await post(command(name));
    const elapsed = Date.now() - started;

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { type: 5, data: { flags: 64 } });
    assert.ok(
      elapsed < 1000,
      `acknowledged after ${elapsed}ms, Discord allows 3000`,
    );
  });
}

for (const name of [
  "audit-scoutid",
  "scan-scoutid",
  "link-scoutid",
  "adoption-scoutid",
]) {
  test(`/${name} turns away a non-admin`, async () => {
    // The permission gate lives in the background handler, after the ACK, so the
    // rejection arrives as an edit to the deferred response rather than as a
    // status code. That is exactly why it is worth asserting: nothing about the
    // HTTP exchange reveals whether the gate ran.
    const token = `tok-denied-${name}`;
    await post(command(name, { admin: false, token }));
    const replies = await replyFor(token);

    assert.equal(
      replies.length,
      1,
      "expected one reply to the deferred response",
    );
    assert.match(replies[0].content, /admin/i);
  });
}

test("the interactions route reads the raw body, not a parsed one", async () => {
  // The signature covers the exact bytes Discord sent. If a JSON body parser
  // ever ran first, re-serialising would change them and every request would
  // start failing verification — with a 401 that looks like a key problem.
  const raw = '{"type":1,  "spacing":"preserved"}';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto
    .sign(null, Buffer.from(timestamp + raw), privateKey)
    .toString("hex");
  const res = await fetch(`${BASE}/interactions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-signature-ed25519": signature,
      "x-signature-timestamp": timestamp,
    },
    body: raw,
  });
  assert.equal(
    res.status,
    200,
    "unusual but valid JSON spacing must still verify",
  );
});
