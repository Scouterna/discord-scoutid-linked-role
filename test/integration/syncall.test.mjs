/**
 * `syncAllUserRoles` — the whole-server sync, which is what the nightly CronJob
 * runs and what `/refresh-scoutid alla:true` runs.
 *
 *   docker compose up -d azurite
 *   npm run test:integration
 *
 * Its own Azurite table, and that is the point of a separate file: this function
 * reads *every* link in storage, so it cannot share a table with tests that seed
 * links of their own. Sharing one made the assertions depend on which tests had
 * run before.
 *
 * Two properties are pinned here, and both are about cost rather than
 * correctness — which is unusual, and is because they decide whether this can
 * run on a schedule at all:
 *
 *   - guild state is fetched once per run, not once per user
 *   - a dry run performs no writes whatsoever
 *
 * The first one was real: `syncUserRoles` fetched the full role list itself, so
 * a run over 2500 linked people asked for 151 roles 2500 times to discover that
 * nothing had changed.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { useAzurite } from "../helpers/azurite.mjs";

await useAzurite("syncalltest");
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

const GUILD_ROLES = [
  { id: "r-scout", name: "scout", managed: true },
  { id: "r-event", name: "WSJ-event", managed: false },
  { id: "r-unver", name: "Overifierad", managed: false },
  { id: "r-ledare", name: "Ledare", managed: false },
  { id: "r-l12", name: "Ledare-12", managed: false },
  { id: "r-l07", name: "Ledare-07", managed: false },
  { id: "r-lpend", name: "Ledare-Väntande", managed: false },
  { id: "r-d05", name: "Deltagare-05", managed: false },
  { id: "r-d07", name: "Deltagare-07", managed: false },
  { id: "r-dpend", name: "Deltagare-Väntande", managed: false },
];

let participants = {};
let guildMembers = [];
const calls = { added: [], removed: [], nicks: [] };
const fetches = { roles: 0, memberList: 0, singleMember: 0 };

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const ok = (body) => ({ ok: true, status: 200, json: async () => body });

  if (u.includes("scoutnet.se")) return ok({ participants });

  if (u.endsWith("/roles")) {
    fetches.roles++;
    return ok(GUILD_ROLES);
  }

  // The bulk member list. Note that discord.js sends `after=0` on the *first*
  // page, not only on follow-ups — keying off the presence of `after` returns
  // an empty list immediately, and then every member gets fetched individually,
  // which is precisely the behaviour this file exists to catch. A short page
  // ends the pagination loop, so one answer is enough.
  const memberList = u.match(/\/members\?.*after=([^&]*)/);
  if (memberList) {
    fetches.memberList++;
    return ok(memberList[1] === "0" ? guildMembers : []);
  }

  const roleChange = u.match(/\/members\/([^/]+)\/roles\/([^/?]+)$/);
  if (roleChange) {
    (opts.method === "PUT" ? calls.added : calls.removed).push(roleChange[2]);
    return ok({});
  }

  const single = u.match(/\/members\/([^/?]+)$/);
  if (single) {
    if (opts.method === "PATCH") {
      calls.nicks.push(JSON.parse(opts.body).nick);
      return ok({});
    }
    // Only reached for a link whose member has left the guild — the bulk list
    // covers everyone else, which is exactly what this file asserts.
    fetches.singleMember++;
    const found = guildMembers.find((m) => m.user.id === single[1]);
    if (found) return ok(found);
    return {
      ok: false,
      status: 404,
      json: async () => ({}),
      text: async () => "{}",
    };
  }

  throw new Error(`unexpected fetch: ${opts.method ?? "GET"} ${u}`);
};

const storage = await import("../../src/storage.js");
const roles = await import("../../src/roles.js");

const member = (id, roleIds, nick) => ({
  user: { id, username: id, global_name: nick },
  nick,
  roles: roleIds,
});

/** Three linked leaders, all already correct, plus one unrelated member. */
async function seedSteadyState() {
  calls.added.length = 0;
  calls.removed.length = 0;
  calls.nicks.length = 0;
  fetches.roles = 0;
  fetches.memberList = 0;
  fetches.singleMember = 0;
  await storage.clearScoutNetCache();

  participants = {};
  guildMembers = [];
  for (const [userId, scoutId] of [
    ["u1", "111"],
    ["u2", "222"],
    ["u3", "333"],
  ]) {
    await storage.setLinkedScoutIDUserId(userId, scoutId);
    participants[scoutId] = {
      fee_id: 33293,
      cancelled_date: null,
      first_name: "Ledare",
      last_name: userId.toUpperCase(),
      questions: { 107592: "12" },
    };
    guildMembers.push(
      member(
        userId,
        ["r-scout", "r-event", "r-ledare", "r-l12"],
        `Ledare ${userId.toUpperCase()} (AL12)`,
      ),
    );
  }
  // Not linked and no Scout role: the orphan strip must leave them alone.
  guildMembers.push(member("bystander", ["r-other"], "Förbipasserande"));
}

test("guild state is fetched once per run, not once per user", async () => {
  await seedSteadyState();

  const results = await roles.syncAllUserRoles(GUILD);

  assert.equal(results.length, 3, "one result per linked user");
  assert.equal(fetches.roles, 1, "the role list must be fetched exactly once");
  assert.equal(fetches.memberList, 1, "the member list too");
  assert.equal(
    fetches.singleMember,
    0,
    "nobody should be fetched individually — the bulk list already has them",
  );
});

test("a steady state writes nothing at all", async () => {
  // The nightly run's normal case. If this ever starts writing, the schedule
  // turns into a stream of no-op role changes and an event log nobody reads.
  await seedSteadyState();

  await roles.syncAllUserRoles(GUILD);

  assert.deepEqual(calls.added, []);
  assert.deepEqual(calls.removed, []);
  assert.deepEqual(calls.nicks, []);
});

test("a dry run reports the change and performs none of it", async () => {
  await seedSteadyState();
  // u2 moved from troop 12 to 07 in ScoutNet, and nobody has synced yet.
  participants["222"].questions = { 107592: "7" };

  const results = await roles.syncAllUserRoles(GUILD, { dryRun: true });

  const u2 = results.find((r) => r.discordUserId === "u2");
  assert.deepEqual(u2.added, ["Ledare-07"]);
  assert.deepEqual(u2.removed, ["Ledare-12"]);
  assert.equal(u2.nickname, "Ledare U2 (AL07)");

  assert.deepEqual(calls.added, [], "a dry run must not add a role");
  assert.deepEqual(calls.removed, [], "a dry run must not remove a role");
  assert.deepEqual(calls.nicks, [], "a dry run must not rename anyone");
});

test("the same change applied for real does write", async () => {
  // The other half of the previous case, and the reason it exists: a dry run
  // that reported nothing at all would satisfy the assertions above just as
  // well. This proves there was something to suppress.
  await seedSteadyState();
  participants["222"].questions = { 107592: "7" };

  await roles.syncAllUserRoles(GUILD);

  assert.deepEqual(calls.added, ["r-l07"]);
  assert.deepEqual(calls.removed, ["r-l12"]);
  assert.deepEqual(calls.nicks, ["Ledare U2 (AL07)"]);
});

test("an orphan with the Scout role but no link is stripped", async () => {
  await seedSteadyState();
  guildMembers.push(
    member("orphan", ["r-scout", "r-event", "r-l12"], "Orphan (AL12)"),
  );

  const results = await roles.syncAllUserRoles(GUILD);

  const stripped = results.find((r) => r.discordUserId === "orphan");
  assert.ok(stripped, "the orphan must appear in the report");
  assert.ok(stripped.added.includes("Overifierad"));
  assert.deepEqual(stripped.removed.sort(), ["Ledare-12", "wsj-event"]);
});

test("a link whose member has left the guild is reported, not skipped", async () => {
  await seedSteadyState();
  await storage.setLinkedScoutIDUserId("departed", "999");

  const results = await roles.syncAllUserRoles(GUILD);

  const gone = results.find((r) => r.discordUserId === "departed");
  assert.ok(gone?.error, "a 404 on the member must surface as an error");
  assert.equal(
    fetches.singleMember,
    1,
    "only the member missing from the bulk list is fetched individually",
  );
});
