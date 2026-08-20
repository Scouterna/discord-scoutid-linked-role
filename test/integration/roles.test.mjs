/**
 * `syncUserRoles` and `stripUnlinkedMember` — the code that decides what a member
 * can actually see, run against real Table Storage with a stubbed Discord API.
 *
 * Needs the emulator, because the Discord-to-ScoutID link lives in Table Storage
 * and the whole function branches on whether one exists:
 *
 *   docker compose up -d azurite
 *   npm run test:integration
 *
 * The case that matters most is the verification gate. The `Scout` role is a
 * managed Discord Linked Role, so its presence is the only proof the user is still
 * connected to ScoutID. When it goes, every bot-managed role has to go with it —
 * and Terraform cannot enforce that, only this function can.
 */
import test from "node:test";
import assert from "node:assert/strict";

// The dotenv banner is silenced by the azurite helper, at its own top level.
// Setting it here would read as if it ran first, but static imports are hoisted:
// the helper executes before any statement in this file.
import { useAzurite } from "../helpers/azurite.mjs";

await useAzurite("rolestest");
process.env.DISCORD_TOKEN = "fake";
process.env.SCOUTNET_EVENT_ID = "9999";
process.env.SCOUTNET_PARTICIPANTS_APIKEY = "fake";
process.env.SCOUTNET_SCOUT_ROLE = "scout";
process.env.SCOUTNET_EVENT_ROLE = "wsj-event";
process.env.SCOUTNET_FEE_ROLES = "25694:deltagare,33293:ledare,25697:cmt";
process.env.SCOUTNET_DIVISION_ROLES =
  "deltagare:88168:Deltagare-{div}:Deltagare-Väntande," +
  "ledare:107592:Ledare-{div}:Ledare-Väntande";
process.env.SCOUTNET_CATEGORY_ROLES = "ledare:Ledare";
process.env.SCOUTNET_NICKNAME_SUFFIXES =
  "deltagare:{div}:,ledare:AL{div}:AL,cmt::CMT";
process.env.LOG_CHANNEL_ID = "";

const GUILD = "G1";

/** The guild's roles. `managed: true` marks roles Discord owns, like Scout. */
const GUILD_ROLES = [
  { id: "r-scout", name: "scout", managed: true },
  { id: "r-event", name: "WSJ-event", managed: false },
  { id: "r-unver", name: "Overifierad", managed: false },
  { id: "r-cmt", name: "CMT", managed: false },
  { id: "r-ledare", name: "Ledare", managed: false },
  { id: "r-l12", name: "Ledare-12", managed: false },
  { id: "r-lpend", name: "Ledare-Väntande", managed: false },
  { id: "r-d05", name: "Deltagare-05", managed: false },
  { id: "r-d07", name: "Deltagare-07", managed: false },
  { id: "r-dpend", name: "Deltagare-Väntande", managed: false },
  { id: "r-other", name: "Något-Annat", managed: false },
];

let member = null;
let participants = {};
/** Set by the outage cases: makes the ScoutNet fetch fail like a real one. */
let scoutNetDown = false;
/** Role ids that reject a change, standing in for Discord's role hierarchy. */
let forbiddenRoleIds = new Set();

const calls = { added: [], removed: [], nicks: [] };

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const ok = (body) => ({ ok: true, status: 200, json: async () => body });

  if (u.includes("scoutnet.se")) {
    if (scoutNetDown) {
      return {
        ok: false,
        status: 500,
        statusText: "Server Error",
        text: async () => "boom",
      };
    }
    return ok({ participants });
  }
  if (u.endsWith("/roles")) return ok(GUILD_ROLES);

  const roleChange = u.match(/\/members\/([^/]+)\/roles\/([^/?]+)$/);
  if (roleChange) {
    const roleId = roleChange[2];
    if (forbiddenRoleIds.has(roleId)) {
      // What Discord returns for a role above the bot's own position.
      return {
        ok: false,
        status: 403,
        json: async () => ({}),
        text: async () => "{}",
      };
    }
    (opts.method === "PUT" ? calls.added : calls.removed).push(roleId);
    return ok({});
  }
  if (u.match(/\/members\/[^/?]+$/)) {
    if (opts.method === "PATCH") {
      calls.nicks.push(JSON.parse(opts.body).nick);
      return ok({});
    }
    return ok(member);
  }
  throw new Error(`unexpected fetch: ${opts.method ?? "GET"} ${u}`);
};

const storage = await import("../../src/storage.js");
const roles = await import("../../src/roles.js");

/** Reset the world. `roleIds` is what the member currently has in Discord. */
async function setup({ userId, roleIds, nick, scoutId, participant }) {
  calls.added.length = 0;
  calls.removed.length = 0;
  calls.nicks.length = 0;
  forbiddenRoleIds = new Set();
  scoutNetDown = false;
  member = {
    user: { id: userId, username: "u", global_name: nick },
    nick,
    roles: roleIds,
  };
  participants = participant ? { [scoutId]: participant } : {};
  await storage.clearScoutNetCache();
  if (scoutId) await storage.setLinkedScoutIDUserId(userId, scoutId);
}

const name = (id) => GUILD_ROLES.find((r) => r.id === id)?.name;
const namesOf = (ids) => ids.map(name).sort();

test("an unlinked user is reported, not silently skipped", async () => {
  const result = await roles.syncUserRoles(GUILD, "nolink");
  assert.match(result.error, /Inte länkad/);
  assert.equal(calls.added.length + calls.removed.length, 0);
});

test("a verified leader gets the division role, the flat marker and a nickname", async () => {
  await setup({
    userId: "u1",
    roleIds: ["r-scout"],
    nick: "gammalt namn",
    scoutId: "111",
    participant: {
      fee_id: 33293,
      cancelled_date: null,
      first_name: "Anna",
      last_name: "Andersson",
      questions: { 107592: "12" },
    },
  });

  const result = await roles.syncUserRoles(GUILD, "u1");
  assert.deepEqual(namesOf(calls.added), ["Ledare", "Ledare-12", "WSJ-event"]);
  assert.deepEqual(result.added.sort(), ["Ledare", "Ledare-12", "wsj-event"]);
  // The name comes from ScoutNet, not from whatever they set themselves.
  assert.deepEqual(calls.nicks, ["Anna Andersson (AL12)"]);
  assert.equal(result.nickname, "Anna Andersson (AL12)");
});

test("the managed Scout role is never re-added or removed", async () => {
  // Discord owns it. Attempting to change it is a guaranteed error, and removing
  // it would break the Linked Role connection the whole design rests on.
  await setup({
    userId: "u1",
    roleIds: ["r-scout"],
    nick: "Anna Andersson",
    scoutId: "111",
    participant: {
      fee_id: 25697,
      cancelled_date: null,
      first_name: "Anna",
      last_name: "Andersson",
      questions: {},
    },
  });
  await roles.syncUserRoles(GUILD, "u1");
  assert.ok(!calls.added.includes("r-scout"), "tried to add a managed role");
  assert.ok(
    !calls.removed.includes("r-scout"),
    "tried to remove a managed role",
  );
});

test("a stale division role is removed when the division changes", async () => {
  // Prefix matching is what catches this: `Deltagare-05` is not in the static
  // managed list, only the pattern is.
  await setup({
    userId: "u2",
    roleIds: ["r-scout", "r-event", "r-d05"],
    nick: "Erik Svensson (05)",
    scoutId: "222",
    participant: {
      fee_id: 25694,
      cancelled_date: null,
      first_name: "Erik",
      last_name: "Svensson",
      questions: { 88168: "7" },
    },
  });

  const result = await roles.syncUserRoles(GUILD, "u2");
  assert.deepEqual(namesOf(calls.added), ["Deltagare-07"]);
  assert.deepEqual(namesOf(calls.removed), ["Deltagare-05"]);
  assert.deepEqual(calls.nicks, ["Erik Svensson (07)"]);
  assert.ok(
    !result.removed.includes("Något-Annat"),
    "touched a role it does not manage",
  );
});

test("roles outside the bot's configuration are left alone", async () => {
  await setup({
    userId: "u2",
    roleIds: ["r-scout", "r-event", "r-d07", "r-other"],
    nick: "Erik Svensson (07)",
    scoutId: "222",
    participant: {
      fee_id: 25694,
      cancelled_date: null,
      first_name: "Erik",
      last_name: "Svensson",
      questions: { 88168: "7" },
    },
  });
  const result = await roles.syncUserRoles(GUILD, "u2");
  // Nothing to do — and in particular no attempt on a role the bot never granted.
  assert.deepEqual(calls.added, []);
  assert.deepEqual(calls.removed, []);
  assert.deepEqual(result, { added: [], removed: [], nickname: null });
});

test("losing the Scout role strips every managed role and sets Overifierad", async () => {
  // The verification gate. The link stays in storage so the user can re-verify
  // without an admin having to ask for their scoutid again.
  await setup({
    userId: "u3",
    roleIds: ["r-event", "r-ledare", "r-l12"], // no r-scout
    nick: "Kim Nilsson (AL12)",
    scoutId: "333",
    participant: {
      fee_id: 33293,
      cancelled_date: null,
      first_name: "Kim",
      last_name: "Nilsson",
      questions: { 107592: "12" },
    },
  });

  const result = await roles.syncUserRoles(GUILD, "u3");
  assert.deepEqual(namesOf(calls.added), ["Overifierad"]);
  assert.deepEqual(namesOf(calls.removed), [
    "Ledare",
    "Ledare-12",
    "WSJ-event",
  ]);
  assert.ok(result.added.includes("Overifierad"));

  assert.equal(
    await storage.getLinkedScoutIDUserId("u3"),
    "333",
    "the storage link must survive so the user can re-verify themselves",
  );
});

test("a stripped member keeps no category hint in their nickname", async () => {
  await setup({
    userId: "u3",
    roleIds: ["r-event", "r-l12"],
    nick: "Kim Nilsson (AL12)",
    scoutId: "333",
    participant: {
      fee_id: 33293,
      cancelled_date: null,
      first_name: "Kim",
      last_name: "Nilsson",
      questions: {},
    },
  });
  await roles.syncUserRoles(GUILD, "u3");
  // Unverified means we no longer assert anything about their category.
  assert.deepEqual(calls.nicks, ["Kim Nilsson"]);
});

test("a cancelled participant loses event access but keeps Scout", async () => {
  await setup({
    userId: "u4",
    roleIds: ["r-scout", "r-event", "r-d07"],
    nick: "Avbokad Person (07)",
    scoutId: "444",
    participant: {
      fee_id: 25694,
      cancelled_date: "2026-06-01",
      first_name: "Avbokad",
      last_name: "Person",
      questions: { 88168: "7" },
    },
  });
  const result = await roles.syncUserRoles(GUILD, "u4");
  assert.deepEqual(namesOf(calls.removed), ["Deltagare-07", "WSJ-event"]);
  assert.deepEqual(
    calls.added,
    [],
    "Overifierad is for unverified, not for cancelled",
  );
  assert.ok(!result.removed.includes("scout"));
});

test("a role above the bot in the hierarchy fails without aborting the rest", async () => {
  // 403 on an admin's roles is expected, and it must not stop the other changes.
  await setup({
    userId: "u5",
    roleIds: ["r-scout"],
    nick: "Chef Person",
    scoutId: "555",
    participant: {
      fee_id: 33293,
      cancelled_date: null,
      first_name: "Chef",
      last_name: "Person",
      questions: { 107592: "12" },
    },
  });
  forbiddenRoleIds = new Set(["r-l12"]);

  const result = await roles.syncUserRoles(GUILD, "u5");
  assert.ok(
    !result.added.includes("Ledare-12"),
    "a failed add must not be reported as done",
  );
  assert.deepEqual(
    result.added.sort(),
    ["Ledare", "wsj-event"],
    "the rest should still apply",
  );
});

test("a nickname longer than Discord allows is truncated, not rejected", async () => {
  await setup({
    userId: "u6",
    roleIds: ["r-scout"],
    nick: "kort",
    scoutId: "666",
    participant: {
      fee_id: 25697,
      cancelled_date: null,
      first_name: "Namn".repeat(8),
      last_name: "Efternamn".repeat(4),
      questions: {},
    },
  });
  await roles.syncUserRoles(GUILD, "u6");
  assert.equal(calls.nicks.length, 1);
  assert.equal(
    calls.nicks[0].length,
    32,
    "Discord's nickname limit is 32 characters",
  );
});

test("a ScoutNet outage changes nothing at all", async () => {
  // The bug this pins: getDesiredRoles used to swallow the error and answer
  // ["scout"], which is the same answer as "not registered in the event" — and
  // that answer *means* remove the event, category and division roles. So a
  // ScoutNet outage during `/refresh-scoutid alla:true` disarmed everyone the
  // run reached, one user at a time, and reported success while doing it.
  await setup({
    userId: "u8",
    roleIds: ["r-scout", "r-event", "r-ledare", "r-l12"],
    nick: "Anna Andersson (AL12)",
    scoutId: "888",
    participant: {
      fee_id: 33293,
      cancelled_date: null,
      first_name: "Anna",
      last_name: "Andersson",
      questions: { 107592: "12" },
    },
  });
  scoutNetDown = true;

  const result = await roles.syncUserRoles(GUILD, "u8");
  assert.match(result.error, /ScoutNet/);
  assert.deepEqual(calls.added, [], "added a role on incomplete data");
  assert.deepEqual(calls.removed, [], "removed a role it could not confirm");
  assert.deepEqual(calls.nicks, [], "renamed someone on incomplete data");
});

test("the verification gate still works while ScoutNet is down", async () => {
  // The other half, and why the bail-out sits *below* the gate rather than at
  // the top: stripping someone who lost the Scout role is the security
  // boundary, and it needs no ScoutNet to decide. An outage must not become a
  // window where a disconnected account keeps its access.
  await setup({
    userId: "u9",
    roleIds: ["r-event", "r-ledare", "r-l12"], // no r-scout
    nick: "Kim Nilsson (AL12)",
    scoutId: "999",
    participant: {
      fee_id: 33293,
      cancelled_date: null,
      first_name: "Kim",
      last_name: "Nilsson",
      questions: { 107592: "12" },
    },
  });
  scoutNetDown = true;

  const result = await roles.syncUserRoles(GUILD, "u9");
  assert.equal(result.error, undefined);
  assert.deepEqual(namesOf(calls.removed), [
    "Ledare",
    "Ledare-12",
    "WSJ-event",
  ]);
  assert.deepEqual(namesOf(calls.added), ["Overifierad"]);
});

test("syncAllUserRoles fails once instead of once per user", async () => {
  // One request at an API that just proved it is down, not one per linked user,
  // and one error to read instead of N identical ones.
  await setup({
    userId: "u8",
    roleIds: ["r-scout", "r-event"],
    nick: "Anna Andersson",
    scoutId: "888",
    participant: {
      fee_id: 33293,
      cancelled_date: null,
      first_name: "Anna",
      last_name: "Andersson",
      questions: {},
    },
  });
  scoutNetDown = true;

  await assert.rejects(() => roles.syncAllUserRoles(GUILD), /ScoutNet/);
  assert.deepEqual(calls.added, []);
  assert.deepEqual(calls.removed, []);
});

test("stripUnlinkedMember clears access for a Scout role with no link behind it", async () => {
  // What a storage loss leaves behind: the managed Scout role stays, so without
  // this the member would keep full access with nothing backing it.
  const roleMap = new Map(GUILD_ROLES.map((r) => [r.name.toLowerCase(), r]));
  calls.added.length = 0;
  calls.removed.length = 0;
  calls.nicks.length = 0;
  forbiddenRoleIds = new Set();

  const orphan = {
    user: { id: "u7", username: "u", global_name: "Orphan Person (AL12)" },
    nick: "Orphan Person (AL12)",
    roles: ["r-scout", "r-event", "r-ledare", "r-l12"],
  };
  const result = await roles.stripUnlinkedMember(GUILD, "u7", roleMap, orphan);

  assert.deepEqual(namesOf(calls.removed), [
    "Ledare",
    "Ledare-12",
    "WSJ-event",
  ]);
  assert.deepEqual(result.added, ["Overifierad"]);
  assert.deepEqual(calls.nicks, ["Orphan Person"]);
  assert.ok(
    !calls.removed.includes("r-scout"),
    "the managed Scout role cannot be removed",
  );
});

test("stripUnlinkedMember leaves an already-stripped member untouched", async () => {
  const roleMap = new Map(GUILD_ROLES.map((r) => [r.name.toLowerCase(), r]));
  calls.added.length = 0;
  calls.removed.length = 0;
  calls.nicks.length = 0;

  const already = {
    user: { id: "u8", username: "u", global_name: "Redan Strippad" },
    nick: "Redan Strippad",
    roles: ["r-scout", "r-unver"],
  };
  const result = await roles.stripUnlinkedMember(GUILD, "u8", roleMap, already);
  // syncAllUserRoles only reports members it changed; a no-op must stay silent.
  // `nickname` is reported the same way syncUserRoles reports it — null here,
  // which is exactly what keeps this member out of the report.
  assert.deepEqual(result, { added: [], removed: [], nickname: null });
  assert.deepEqual(calls.nicks, []);
});
