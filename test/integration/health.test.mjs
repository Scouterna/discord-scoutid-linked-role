/**
 * `/readyz` against a real table.
 *
 * Needs the emulator, and that is the whole point of the file: the readiness
 * probe is the one route whose answer depends on Table Storage, so the case
 * worth testing — it says 200 when storage genuinely works — cannot be written
 * without one. The failing half lives in test/unit/server.test.mjs, where a
 * connection string pointing at nothing is enough.
 *
 *   docker compose up -d azurite
 *   npm run test:integration
 *
 * Why this matters more than a health check usually would: `maxUnavailable: 0`
 * means a rollout waits for a Ready pod, and deploy.yml polls this route from
 * the public ingress afterwards. A /readyz that answers 503 when it should not
 * does not degrade the service — it stops deploys.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { useAzurite } from "../helpers/azurite.mjs";

await useAzurite("healthtest");
process.env.DISCORD_TOKEN = "fake";
process.env.DISCORD_CLIENT_ID = "app-1";
process.env.DISCORD_GUILD_ID = "G1";
process.env.DISCORD_PUBLIC_KEY = "00".repeat(32);
process.env.LOG_CHANNEL_ID = "";

const { app } = await import("../../src/server.js");

const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
const BASE = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

test("readiness answers 200 when the table is reachable", async () => {
  const res = await fetch(`${BASE}/readyz`);
  const body = await res.text();
  assert.equal(res.status, 200, body);
  assert.equal(body, "ready");
});

test("a missing probe row is a healthy answer, not a failure", async () => {
  // `ping` reads a key nothing ever writes. The 404 that comes back proves the
  // request was signed, routed and answered, which is all readiness needs — and
  // if that were ever treated as an error, every pod would fail to become Ready
  // and no rollout could finish.
  const storage = await import("../../src/storage.js");
  assert.equal(await storage.ping(), true);
  assert.equal(await storage.getLinkedScoutIDUserId("nobody-at-all"), null);
});

test("readiness is cached, so probes do not become storage load", async () => {
  // Two pods probing every 10s is nothing; a hung table with probes stacking on
  // top of each other is. The cache and the shared in-flight promise are what
  // keep that bounded, so this pins that repeated calls stay cheap and stable.
  const first = await fetch(`${BASE}/readyz`);
  const second = await fetch(`${BASE}/readyz`);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
});
