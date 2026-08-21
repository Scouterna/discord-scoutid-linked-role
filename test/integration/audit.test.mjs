/**
 * `runAudit` — the report `/audit-scoutid` prints, across all 13 categories.
 *
 * Needs the emulator, because the audit reads links and stored tokens from Table
 * Storage:
 *
 *   docker compose up -d azurite
 *   npm run test:integration
 *
 * The audit is read-only by design — no addRole, no removeRole, no nickname call —
 * which is what makes it safe to run against production credentials. The stubbed
 * Discord API here refuses any mutating request, so that property is enforced
 * rather than assumed.
 *
 * Two shapes of test. A **clean guild must report zero issues**: any false
 * positive in any category shows up at once, and a noisy audit is one nobody
 * reads. Then a deliberately broken guild, asserting per-category counts, so a
 * category that stops detecting its own fault is caught.
 */
import test from "node:test";
import assert from "node:assert/strict";

// The dotenv banner is silenced by the azurite helper, at its own top level.
// Setting it here would read as if it ran first, but static imports are hoisted:
// the helper executes before any statement in this file.
import { useAzurite } from "../helpers/azurite.mjs";

await useAzurite("audittest");
process.env.DISCORD_TOKEN = "fake";
process.env.SCOUTNET_EVENT_ID = "9999";
process.env.SCOUTNET_PARTICIPANTS_APIKEY = "fake";
process.env.SCOUTNET_SCOUT_ROLE = "scout";
process.env.SCOUTNET_EVENT_ROLE = "wsj-event";
process.env.SCOUTNET_FEE_ROLES = "25694:deltagare,33293:ledare";
process.env.SCOUTNET_DIVISION_ROLES =
  "deltagare:88168:Deltagare-{div}:Deltagare-Väntande," +
  "ledare:107592:Ledare-{div}:Ledare-Väntande";
process.env.SCOUTNET_CATEGORY_ROLES = "ledare:Ledare";
process.env.SCOUTNET_NICKNAME_SUFFIXES = "deltagare:{div}:,ledare:AL{div}:AL";
process.env.LOG_CHANNEL_ID = "";

const GUILD = "G1";
const BOT_USER = "bot-1";

/** MANAGE_ROLES | MANAGE_NICKNAMES — what the bot's role actually carries. */
const BOT_PERMS = String((1 << 28) | (1 << 27));

// Positions matter: the bot can only modify members whose highest role sits below
// its own. `r-admin` is above it on purpose.
const ROLES = [
  { id: "r-everyone", name: "@everyone", managed: false, position: 0 },
  { id: "r-scout", name: "scout", managed: true, position: 1 },
  { id: "r-event", name: "WSJ-event", managed: false, position: 2 },
  { id: "r-unver", name: "Overifierad", managed: false, position: 3 },
  { id: "r-dpend", name: "Deltagare-Väntande", managed: false, position: 4 },
  { id: "r-lpend", name: "Ledare-Väntande", managed: false, position: 5 },
  { id: "r-ledare", name: "Ledare", managed: false, position: 6 },
  { id: "r-d05", name: "Deltagare-05", managed: false, position: 7 },
  { id: "r-d07", name: "Deltagare-07", managed: false, position: 8 },
  { id: "r-l12", name: "Ledare-12", managed: false, position: 9 },
  // The permission bits are read from the *role*, not from the member object.
  {
    id: "r-bot",
    name: "ScoutID bot",
    managed: true,
    position: 20,
    permissions: BOT_PERMS,
  },
  { id: "r-admin", name: "Discord Admin", managed: false, position: 30 },
];

let members = [];
let participants = {};
const mutations = [];

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = opts.method ?? "GET";
  const ok = (body) => ({ ok: true, status: 200, json: async () => body });

  if (method !== "GET") {
    // The audit must never write. Recorded rather than thrown so the failure
    // names the call instead of surfacing as an unrelated error.
    mutations.push(`${method} ${u}`);
    return ok({});
  }
  if (u.includes("scoutnet.se")) return ok({ participants });
  if (u.endsWith("/roles")) return ok(ROLES);
  if (u.includes(`/members/${BOT_USER}`)) {
    return ok({ user: { id: BOT_USER }, roles: ["r-bot"] });
  }
  if (u.includes("/users/@me")) return ok({ id: BOT_USER });
  if (u.includes("/members?")) {
    const after = new URL(u).searchParams.get("after");
    return ok(after === "0" ? members : []);
  }
  const one = u.match(/\/members\/([^/?]+)$/);
  if (one) return ok(members.find((m) => m.user.id === one[1]) ?? null);
  throw new Error(`unexpected fetch: ${method} ${u}`);
};

const storage = await import("../../src/storage.js");
const audit = await import("../../src/audit.js");

const M = (id, nick, roleIds) => ({
  user: { id, username: id, global_name: nick },
  nick,
  roles: roleIds,
});

/** Link a user and give them stored tokens, the way a real /linked-role run does. */
async function link(userId, scoutId, { withTokens = true } = {}) {
  await storage.setLinkedScoutIDUserId(userId, scoutId);
  if (withTokens) {
    // Only the Discord token matters. ScoutID's is no longer stored at all — see
    // the note in storage.js — and the audit never read it.
    await storage.storeDiscordTokens(userId, {
      access_token: "a",
      refresh_token: "r",
    });
  }
}

const counts = (result) => result.totals.byCategory;

test("a consistent guild reports zero issues", async () => {
  members = [
    M("u1", "Anna Andersson (AL12)", [
      "r-scout",
      "r-event",
      "r-ledare",
      "r-l12",
    ]),
    M("u2", "Erik Svensson (07)", ["r-scout", "r-event", "r-d07"]),
    M(BOT_USER, "ScoutID", ["r-bot"]),
  ];
  participants = {
    111: {
      fee_id: 33293,
      cancelled_date: null,
      first_name: "Anna",
      last_name: "Andersson",
      questions: { 107592: "12" },
    },
    222: {
      fee_id: 25694,
      cancelled_date: null,
      first_name: "Erik",
      last_name: "Svensson",
      questions: { 88168: "7" },
    },
  };
  await storage.clearScoutNetCache();
  await link("u1", "111");
  await link("u2", "222");
  mutations.length = 0;

  const result = await audit.runAudit(GUILD);
  assert.deepEqual(
    Object.entries(counts(result)).filter(([, n]) => n > 0),
    [],
    "a clean guild must produce no findings at all",
  );
  assert.equal(result.totals.issues, 0);
  assert.equal(result.meta.guildMembers, 3);
  assert.equal(result.meta.linkedUsers, 2);
  assert.equal(result.meta.participants, 2);
});

test("the audit performs no writes", async () => {
  // This is what makes it safe to run locally against production credentials.
  assert.deepEqual(mutations, []);
});

test("a Scout role with no link behind it is reported", async () => {
  // What a storage loss looks like from the Discord side.
  members = [...members, M("u3", "Oklar Person", ["r-scout"])];
  const result = await audit.runAudit(GUILD);
  assert.equal(counts(result).scout_role_no_link, 1);
});

test("a link whose Scout role fell off is reported", async () => {
  members = [...members, M("u4", "Tappad Person", ["r-event"])];
  await link("u4", "444");
  participants["444"] = {
    fee_id: 25694,
    cancelled_date: null,
    first_name: "Tappad",
    last_name: "Person",
    questions: { 88168: "7" },
  };
  await storage.clearScoutNetCache();

  const result = await audit.runAudit(GUILD);
  assert.equal(counts(result).linked_no_scout_role, 1);
});

test("a link with no stored Discord tokens is reported", async () => {
  // The quiet failure: roles and nicknames keep working, but the bot cannot push
  // Linked Role metadata, and only the user can repair it. `/link-scoutid` cannot.
  members = [
    ...members,
    M("u5", "Utan Token (07)", ["r-scout", "r-event", "r-d07"]),
  ];
  await link("u5", "555", { withTokens: false });
  participants["555"] = {
    fee_id: 25694,
    cancelled_date: null,
    first_name: "Utan",
    last_name: "Token",
    questions: { 88168: "7" },
  };
  await storage.clearScoutNetCache();

  const result = await audit.runAudit(GUILD);
  assert.equal(counts(result).linked_no_tokens, 1);
});

test("a link for someone who left the guild is reported", async () => {
  await link("gone-user", "666");
  const result = await audit.runAudit(GUILD);
  assert.equal(counts(result).stale_link, 1);
});

test("a cancelled participant is reported", async () => {
  members = [
    ...members,
    M("u7", "Avbokad Person (07)", ["r-scout", "r-event", "r-d07"]),
  ];
  await link("u7", "777");
  participants["777"] = {
    fee_id: 25694,
    cancelled_date: "2026-06-01",
    first_name: "Avbokad",
    last_name: "Person",
    questions: { 88168: "7" },
  };
  await storage.clearScoutNetCache();

  const result = await audit.runAudit(GUILD);
  assert.equal(counts(result).cancelled, 1);
});

test("a Discord name unrelated to the ScoutNet name is reported", async () => {
  // The signal for a mislink: someone linked to the wrong scoutid.
  members = [
    ...members,
    M("u8", "HeltAnnatNamn (07)", ["r-scout", "r-event", "r-d07"]),
  ];
  await link("u8", "888");
  participants["888"] = {
    fee_id: 25694,
    cancelled_date: null,
    first_name: "Karin",
    last_name: "Larsson",
    questions: { 88168: "7" },
  };
  await storage.clearScoutNetCache();

  const result = await audit.runAudit(GUILD);
  assert.equal(counts(result).name_mismatch, 1);
});

test("two division roles at once are reported", async () => {
  members = [
    ...members,
    M("u9", "Dubbel Person (07)", ["r-scout", "r-event", "r-d05", "r-d07"]),
  ];
  await link("u9", "999");
  participants["999"] = {
    fee_id: 25694,
    cancelled_date: null,
    first_name: "Dubbel",
    last_name: "Person",
    questions: { 88168: "7" },
  };
  await storage.clearScoutNetCache();

  const result = await audit.runAudit(GUILD);
  assert.equal(counts(result).multiple_division_roles, 1);
});

test("a wrong nickname suffix is reported", async () => {
  members = [
    ...members,
    M("u10", "Fel Suffix (99)", ["r-scout", "r-event", "r-d07"]),
  ];
  await link("u10", "1010");
  participants["1010"] = {
    fee_id: 25694,
    cancelled_date: null,
    first_name: "Fel",
    last_name: "Suffix",
    questions: { 88168: "7" },
  };
  await storage.clearScoutNetCache();

  const result = await audit.runAudit(GUILD);
  assert.ok(counts(result).wrong_nickname_suffix >= 1);
});

test("a division role ScoutNet references but Discord lacks is reported", async () => {
  // The infra repo's `troops` must cover every value ScoutNet can return. This is
  // how a missing one surfaces before a member notices they see nothing.
  participants["1111"] = {
    fee_id: 25694,
    cancelled_date: null,
    first_name: "Saknad",
    last_name: "Roll",
    questions: { 88168: "31" },
  };
  await storage.clearScoutNetCache();

  const result = await audit.runAudit(GUILD);
  assert.ok(
    counts(result).missing_division_roles >= 1,
    "Deltagare-31 does not exist in the guild",
  );
});

test("an unmapped fee id is reported", async () => {
  participants["1212"] = {
    fee_id: 654321,
    cancelled_date: null,
    first_name: "Okänd",
    last_name: "Avgift",
    questions: {},
  };
  await storage.clearScoutNetCache();

  const result = await audit.runAudit(GUILD);
  assert.ok(counts(result).unknown_fee_ids >= 1);
});

test("a member the bot cannot modify is left out of role drift", async () => {
  // `Discord Admin` sits above the bot, so a 403 on this member is expected
  // rather than broken. Listing their drift would fill the report with findings
  // nobody can act on, so the category skips them on purpose — and an audit
  // people stop reading is worse than a shorter one.
  members = [...members, M("u13", "Chef Person", ["r-scout", "r-admin"])];
  await link("u13", "1313");
  participants["1313"] = {
    fee_id: 25694,
    cancelled_date: null,
    first_name: "Chef",
    last_name: "Person",
    questions: { 88168: "7" },
  };
  await storage.clearScoutNetCache();

  const result = await audit.runAudit(GUILD);
  const drift = result.categories.find((c) => c.id === "role_drift");
  // They are genuinely drifted — missing WSJ-event and Deltagare-07 — so without
  // the skip they would show up here.
  assert.ok(
    !drift.items.some((i) => i.includes("u13")),
    "a member above the bot must not be reported as drifted",
  );
});

test("a bot role missing MANAGE_ROLES is reported", async () => {
  // Read from the role, not the member. A bot that cannot manage roles fails
  // every assignment silently from the user's point of view.
  const original = ROLES.find((r) => r.id === "r-bot").permissions;
  ROLES.find((r) => r.id === "r-bot").permissions = "0";
  try {
    const result = await audit.runAudit(GUILD);
    const perms = result.categories.find((c) => c.id === "bot_permissions");
    assert.ok(perms.items.some((i) => i.includes("MANAGE_ROLES")));
    assert.ok(perms.items.some((i) => i.includes("MANAGE_NICKNAMES")));
  } finally {
    ROLES.find((r) => r.id === "r-bot").permissions = original;
  }
});

test("still no writes after every failure case", async () => {
  assert.deepEqual(
    mutations,
    [],
    `the audit issued writes: ${mutations.join(", ")}`,
  );
});

test("the report renders and summarises what it found", async () => {
  const result = await audit.runAudit(GUILD);
  const md = audit.formatAuditMarkdown(result);
  assert.match(md, new RegExp(`${result.totals.issues}`));
  // Categories with no findings must not clutter a report meant to be read.
  for (const c of result.categories) {
    if (c.count === 0) assert.doesNotMatch(md, new RegExp(escape(c.title)));
  }
  assert.match(audit.summarizeAudit(result), /avvikelser/);
});

function escape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
