/**
 * Pure-logic tests: formatters, the scan summary, and audit-log pagination.
 *
 * No Azurite, no network, no setup — `npm test` runs these anywhere. The parts
 * that genuinely need durable storage live in `integration.test.mjs`.
 *
 * `storage.js` builds its TableClient at import time, and `memberscan.js` imports
 * it, so a syntactically valid connection string has to exist even though nothing
 * here ever contacts it.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.TABLE_CONNECTION_STRING =
  "DefaultEndpointsProtocol=https;AccountName=unittest;AccountKey=dGVzdA==;EndpointSuffix=core.windows.net";
process.env.TABLE_NAME = "unittest";
process.env.DISCORD_TOKEN = "fake";
process.env.DISCORD_GUILD_ID = "G1";

const eventlog = await import("../src/eventlog.js");
const discord = await import("../src/discord.js");
const scan = await import("../src/memberscan.js");

test("formatMemberJoined flags bots and shows account age", () => {
  const line = eventlog.formatMemberJoined({
    discordUserId: "1",
    name: "Anna",
    accountCreatedAt: Date.now() - 8 * 60000,
    isBot: false,
  });
  assert.match(line, /Anna/);
  assert.match(line, /<@1>/);
  // A throwaway account is invisible in the member list; the age is why this is here.
  assert.match(line, /konto skapat för 8 min sedan/);
  assert.doesNotMatch(line, /🤖/);

  assert.match(
    eventlog.formatMemberJoined({ discordUserId: "2", name: "Botty", isBot: true }),
    /🤖/,
  );
});

test("formatMemberGone distinguishes leave, kick and ban", () => {
  const plain = eventlog.formatMemberGone({
    discordUserId: "1",
    name: "Erik",
    removal: null,
  });
  // Without an audit entry the departure is genuinely unknown, so the wording
  // must not claim the person left of their own accord.
  assert.match(plain, /är inte längre medlem/);
  assert.doesNotMatch(plain, /kickad|bannad|lämnade/);

  const kicked = eventlog.formatMemberGone({
    discordUserId: "1",
    name: "Erik",
    removal: { kind: "kick", actorId: "99", reason: "spam" },
  });
  assert.match(kicked, /kickad/);
  assert.match(kicked, /<@99>/);
  assert.match(kicked, /anledning: spam/);

  const banned = eventlog.formatMemberGone({
    discordUserId: "1",
    name: "Erik",
    removal: { kind: "ban", actorId: "99", reason: null },
  });
  assert.match(banned, /bannad/);
  assert.doesNotMatch(banned, /anledning/);
});

test("formatMemberGone flags a link left behind", () => {
  const line = eventlog.formatMemberGone({
    discordUserId: "1",
    name: "Erik",
    stillLinked: true,
    removal: null,
  });
  assert.match(line, /länkningen kvarstår/);
});

test("formatManualRoleChange names the actor", () => {
  const line = eventlog.formatManualRoleChange({
    discordUserId: "1",
    actorId: "99",
    added: ["Ledare-12"],
    removed: ["Overifierad"],
    reason: null,
  });
  // The actor is the entire reason this category exists: the bot's own changes
  // are logged as they happen, so only someone else's are news.
  assert.match(line, /\(av <@99>\)/);
  assert.match(line, /Ledare-12/);
  assert.match(line, /Overifierad/);
});

test("the member formatters return strings and never write", () => {
  // Regression: these used to call logEvent internally, which made
  // `/scan-scoutid torrkor:true` post its lines a few seconds later via the
  // flush timer — a dry run that was not dry.
  for (const fn of [
    "formatMemberJoined",
    "formatMemberGone",
    "formatMemberRenamed",
    "formatManualRoleChange",
  ]) {
    assert.equal(typeof eventlog[fn], "function", `${fn} should be exported`);
  }
  assert.equal(
    typeof eventlog.formatMemberRenamed({ discordUserId: "1", from: "a", to: "b" }),
    "string",
  );
});

test("summary reports no count for a category that was switched off", () => {
  // Regression: a scheduled run started 82 seconds before the ConfigMap enabling
  // `roles` landed and still printed "0 rolländringar för hand", which reads as
  // "we looked and found none" — the opposite of the truth.
  const text = scan.formatScanSummary({
    counts: { joined: 1, gone: 0, removedByMod: 0, renamed: 0, roleChanges: 0 },
    total: 1,
    enabled: ["join", "leave", "nickname"],
  });
  assert.doesNotMatch(text, /rolländringar/);
  assert.match(text, /avstängt: roles/);
});

test("summary counts an enabled category and claims nothing is off", () => {
  const text = scan.formatScanSummary({
    counts: { joined: 0, gone: 0, removedByMod: 0, renamed: 0, roleChanges: 2 },
    total: 2,
    enabled: ["join", "leave", "nickname", "roles"],
  });
  assert.match(text, /2 rolländringar/);
  assert.doesNotMatch(text, /avstängt/);
});

test("summary separates moderator removals from plain departures", () => {
  const text = scan.formatScanSummary({
    counts: { joined: 0, gone: 3, removedByMod: 1, renamed: 0, roleChanges: 0 },
    total: 3,
    enabled: ["join", "leave", "nickname", "roles"],
  });
  // Hiding a kick inside a departure count loses the only part a moderator cares about.
  assert.match(text, /3 borta \(varav 1 kickad\/bannad\)/);
});

test("summary names the missing permission instead of reporting a zero", () => {
  const text = scan.formatScanSummary({
    counts: { joined: 0, gone: 0, removedByMod: 0, renamed: 0, roleChanges: 0 },
    total: 0,
    enabled: ["join", "roles"],
    auditUnavailable: true,
  });
  assert.doesNotMatch(text, /0 rolländringar/);
  assert.match(text, /View Audit Log/);
});

test("summary explains a seeded baseline", () => {
  const text = scan.formatScanSummary({ seeded: 27, enabled: ["join"] });
  assert.match(text, /27/);
  assert.match(text, /Baslinje/);
});

// --- Audit-log pagination ---
//
// Discord returns entries newest-first, and `after` does not change that:
// `?after=X&limit=100` yields the 100 *newest* entries above X. With 150 waiting,
// the 50 closest to X are absent, and advancing the cursor past them skips them
// forever. A `/refresh-scoutid alla:true` writes one entry per changed user, so
// filling a 100-entry window is ordinary here rather than a rare edge case.

/** Fake audit log holding `count` entries with ids 10001..10000+count. */
function fakeAuditLog(count) {
  const entries = [];
  for (let i = count; i >= 1; i--) entries.push({ id: String(10000 + i), user_id: "u" });
  const requests = [];
  globalThis.fetch = async (url) => {
    const p = new URL(String(url)).searchParams;
    requests.push({ before: p.get("before"), limit: p.get("limit") });
    const limit = Number(p.get("limit") ?? 50);
    const before = p.get("before");
    const list = before
      ? entries.filter((e) => BigInt(e.id) < BigInt(before))
      : entries;
    return { ok: true, status: 200, json: async () => ({ audit_log_entries: list.slice(0, limit) }) };
  };
  return { requests };
}

test("pagination walks back to the cursor instead of losing the oldest page", async () => {
  const { requests } = fakeAuditLog(150);
  const { entries, truncated } = await discord.getAuditLogEntries("G1", {
    actionType: 25,
    after: "10000",
  });
  assert.equal(entries.length, 150, "must not stop at the first 100-entry page");
  assert.equal(entries[0].id, "10001", "entries should come back oldest-first");
  assert.equal(entries.at(-1).id, "10150");
  assert.ok(requests.length >= 2, "should have made more than one request");
  assert.equal(truncated, false);
});

test("pagination returns only entries above the cursor", async () => {
  fakeAuditLog(150);
  const { entries } = await discord.getAuditLogEntries("G1", {
    actionType: 25,
    after: "10100",
  });
  assert.equal(entries.length, 50);
  assert.ok(entries.every((e) => BigInt(e.id) > 10100n));
});

test("pagination refuses to run without a cursor", async () => {
  fakeAuditLog(10);
  // Without one it would page through the guild's whole retained history.
  await assert.rejects(
    () => discord.getAuditLogEntries("G1", { actionType: 25 }),
    /requires an `after` cursor/,
  );
});

test("getNewestAuditLogId asks for a single entry", async () => {
  const { requests } = fakeAuditLog(150);
  const id = await discord.getNewestAuditLogId("G1", 25);
  assert.equal(id, "10150");
  assert.equal(requests.at(-1).limit, "1", "seeding should not fetch a full page");
});

test("a 403 from the audit log carries its status for the caller to branch on", async () => {
  globalThis.fetch = async () => ({
    ok: false,
    status: 403,
    json: async () => ({ message: "Missing Permissions" }),
    text: async () => "{}",
  });
  // memberscan distinguishes 403 (missing permission, degrade) from anything
  // else (real failure, stop) purely by this field.
  await assert.rejects(
    () => discord.getNewestAuditLogId("G1", 25),
    (e) => e.status === 403,
  );
});
