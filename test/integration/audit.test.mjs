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
process.env.SCOUTNET_EVENT_ROLE = "event";
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
  { id: "r-event", name: "Event", managed: false, position: 2 },
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
/**
 * What Discord answers when the audit reads back a user's role-connection — the
 * gate's second proof. Defaults to 401 so the cases below keep testing the role
 * signal on its own; a live grant would make most findings disappear, which is
 * the whole point of the change that introduced this.
 */
let connectionStatus = 401;
/**
 * Set to simulate the ScoutNet cache expiring into an outage mid-audit: the
 * read-back of a role-connection — which happens partway through, in the
 * gate's category — clears the cache, and every ScoutNet fetch after that fails.
 */
let scoutnetDiesMidAudit = false;
let scoutnetFetches = 0;

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = opts.method ?? "GET";
  const ok = (body) => ({ ok: true, status: 200, json: async () => body });

  if (u.includes("/role-connection")) {
    if (scoutnetDiesMidAudit) await storage.clearScoutNetCache();
    return {
      ok: connectionStatus === 200,
      status: connectionStatus,
      json: async () => ({}),
      text: async () => "{}",
    };
  }

  if (method !== "GET") {
    // The audit must never write. Recorded rather than thrown so the failure
    // names the call instead of surfacing as an unrelated error.
    mutations.push(`${method} ${u}`);
    return ok({});
  }
  if (u.includes("scoutnet.se")) {
    scoutnetFetches++;
    if (scoutnetDiesMidAudit && scoutnetFetches > 1) {
      return {
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        text: async () => "",
      };
    }
    return ok({ participants });
  }
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
const itemsOf = (result, id) =>
  result.categories.find((c) => c.id === id).items;

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
  // The probe runs read-only here: the full probe answers a 401 by spending the
  // refresh token, which rotates and re-stores the pair — a write the audit may
  // never make. This is the case where it would happen, so pin it where it bites.
  assert.deepEqual(mutations, [], "the probe must not refresh from the audit");
});

test("a missing Scout role with a live connection is not a finding", async () => {
  // The gate takes two proofs, so the missing role is half a question. Asking
  // only that half made this category list seventeen members who were in no
  // danger at all, with identical advice none of them needed — and an audit that
  // reports a non-problem as loudly as a problem is one nobody reads.
  //
  // They are still worth a line, so the count drops to zero and the category
  // carries a note instead.
  connectionStatus = 200;
  try {
    const result = await audit.runAudit(GUILD);
    assert.equal(counts(result).linked_no_scout_role, 0);
    const c = result.categories.find((x) => x.id === "linked_no_scout_role");
    assert.match(c.note, /verifierade via sin Discord-koppling/);
  } finally {
    connectionStatus = 401;
  }
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

test("a participant cancelled by flag alone is reported too", async () => {
  // The case that reading only `cancelled_date` missed: ScoutNet had 175 records
  // with `cancelled: true` and 168 with a date. Without this the audit would call
  // such a member perfectly consistent while ScoutNet considers them gone.
  //
  // Asserts on the item rather than the count, because the cases in this file
  // accumulate members deliberately and a total would pin the fixture order
  // instead of the behaviour.
  members = [
    ...members,
    M("u9", "Flaggad Person (07)", ["r-scout", "r-event", "r-d07"]),
  ];
  await link("u9", "999");
  participants["999"] = {
    fee_id: 25694,
    cancelled: true,
    cancelled_date: null,
    first_name: "Flaggad",
    last_name: "Person",
    questions: { 88168: "7" },
  };
  const result = await audit.runAudit(GUILD);
  const items = itemsOf(result, "cancelled");
  assert.ok(
    items.some((i) => i.userId === "u9" && i.text.includes("utan datum")),
    `flaggad-men-odaterad saknas i rapporten: ${items.map((i) => i.text).join(" | ")}`,
  );
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
  // They are genuinely drifted — missing Event and Deltagare-07 — so without
  // the skip they would show up here.
  assert.ok(
    !itemsOf(result, "role_drift").some((i) => i.userId === "u13"),
    "a member above the bot must not be reported as drifted",
  );
});

test("role drift reports what a sync would remove, Overifierad included", async () => {
  // The audit used to compute the drift itself and left `Overifierad` out of
  // "wrongly held", while the sync removes it from a verified member. Two code
  // paths answering "what would change", saying different things.
  const before = members;
  members = [
    ...members,
    M("u14", "Kvar Person (07)", ["r-scout", "r-event", "r-d07", "r-unver"]),
  ];
  await link("u14", "1414");
  participants["1414"] = {
    fee_id: 25694,
    cancelled_date: null,
    first_name: "Kvar",
    last_name: "Person",
    questions: { 88168: "7" },
  };
  await storage.clearScoutNetCache();

  try {
    const result = await audit.runAudit(GUILD);
    const item = itemsOf(result, "role_drift").find((i) => i.userId === "u14");
    assert.ok(item, "a verified member holding Overifierad is drift");
    assert.match(item.text, /har felaktigt: Overifierad/);
    assert.doesNotMatch(item.text, /saknar/);
  } finally {
    members = before;
    await storage.deleteLink("u14");
    delete participants["1414"];
    await storage.clearScoutNetCache();
  }
});

test("a bot role missing MANAGE_ROLES is reported", async () => {
  // Read from the role, not the member. A bot that cannot manage roles fails
  // every assignment silently from the user's point of view.
  const original = ROLES.find((r) => r.id === "r-bot").permissions;
  ROLES.find((r) => r.id === "r-bot").permissions = "0";
  try {
    const result = await audit.runAudit(GUILD);
    const perms = itemsOf(result, "bot_permissions");
    assert.ok(perms.some((i) => i.text.includes("MANAGE_ROLES")));
    assert.ok(perms.some((i) => i.text.includes("MANAGE_NICKNAMES")));
  } finally {
    ROLES.find((r) => r.id === "r-bot").permissions = original;
  }
});

test("a ScoutNet outage mid-audit is not reported as no drift", async () => {
  // The drift and suffix checks used to fetch each member's wish list on their
  // own, inside `catch { continue }`. Once the cache expired into an outage,
  // every member was skipped and the category read as "no drift" — the reading
  // this repository forbids everywhere else. They now read the participants the
  // audit gathered once, so there is no second fetch to fail.
  const before = members;
  members = [...members, M("u15", "Drift Person (07)", ["r-scout", "r-d07"])];
  await link("u15", "1515");
  participants["1515"] = {
    fee_id: 25694,
    cancelled_date: null,
    first_name: "Drift",
    last_name: "Person",
    questions: { 88168: "7" },
  };
  await storage.clearScoutNetCache();
  scoutnetDiesMidAudit = true;
  scoutnetFetches = 0;

  try {
    const result = await audit.runAudit(GUILD);
    assert.equal(scoutnetFetches, 1, "the audit fetched ScoutNet again");
    const item = itemsOf(result, "role_drift").find((i) => i.userId === "u15");
    assert.ok(item, "the drifted member vanished with the outage");
    assert.match(item.text, /saknar: event/i);
    assert.ok(
      itemsOf(result, "wrong_nickname_suffix").length > 0,
      "the suffix check vanished with the outage",
    );
  } finally {
    scoutnetDiesMidAudit = false;
    members = before;
    await storage.deleteLink("u15");
    delete participants["1515"];
    await storage.clearScoutNetCache();
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
  assert.match(audit.summarizeAudit(result), /fynd hos \d+ personer/);
  // One person can appear in four categories, so a finding count alone read as an
  // emergency when the truth was two members needing to act.
  assert.ok(
    result.totals.affectedUsers > 0 &&
      result.totals.affectedUsers <= result.totals.issues,
    `orimligt antal personer: ${result.totals.affectedUsers} av ${result.totals.issues} fynd`,
  );
});

test("the attachment is readable without Discord to render it", async () => {
  // The report becomes a .txt as soon as it passes 2000 characters, and an
  // attachment renders nothing — so the markdown version arrived as literal
  // `__…__` and raw numeric ids, unreadable exactly when it was long enough to
  // need reading.
  const result = await audit.runAudit(GUILD);
  const txt = audit.formatAuditText(result);
  assert.doesNotMatch(txt, /<@/, "a mention reached the attachment");
  assert.doesNotMatch(txt, /\*|__|`/, "Discord markup survived");

  // Every person a finding is about appears by name in both versions — and in
  // the attachment with the id beside it, for pasting into `personid:`.
  // Asserting on an arbitrary member instead would only prove that someone
  // consistent — who is not in the report at all — was absent.
  const md = audit.formatAuditMarkdown(result);
  assert.doesNotMatch(md, /<@/, "the message used a mention, not a name");
  const people = new Set(
    result.categories.flatMap((c) => c.items.map((i) => i.userId)),
  );
  people.delete(undefined);
  assert.ok(people.size > 0, "the fixture should produce findings");
  for (const id of people) {
    const name = result.names[id];
    if (!name) continue; // not in the guild: printed as the bare id
    assert.match(md, new RegExp(escape(`**${name}**`)), `${id} in the message`);
    assert.match(
      txt,
      new RegExp(escape(`${name} (${id})`)),
      `${id} in the file`,
    );
  }
});

test("people are counted from the findings, once each", async () => {
  // The count used to be pulled back out of the rendered text, by matching
  // `<@id>`. Now each item carries its id, so the count is the ids.
  const result = await audit.runAudit(GUILD);
  const people = new Set(
    result.categories.flatMap((c) =>
      c.items.filter((i) => i.userId).map((i) => i.userId),
    ),
  );
  assert.equal(result.totals.affectedUsers, people.size);
  // The point of counting people: someone in several categories is one person.
  const findings = result.categories.flatMap((c) =>
    c.items.filter((i) => i.userId),
  );
  assert.ok(
    findings.length > people.size,
    "the fixture should put someone in several categories",
  );
});

function escape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
