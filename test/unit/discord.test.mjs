/**
 * The Discord REST client: pagination, rate-limit retries, and the guarantees the
 * callers depend on.
 *
 * `getGuildMembers` is the one that matters most for correctness. It backs both
 * the audit and the member scan, and a page limit that silently truncates would
 * make the scan report everyone past member 1000 as having left the server.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.TABLE_CONNECTION_STRING =
  "DefaultEndpointsProtocol=https;AccountName=unittest;AccountKey=dGVzdA==;EndpointSuffix=core.windows.net";
process.env.TABLE_NAME = "unittest";
process.env.DISCORD_TOKEN = "test-token";
process.env.DISCORD_CLIENT_ID = "app-1";

const discord = await import("../../src/discord.js");

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const err = (status) => ({
  ok: false,
  status,
  json: async () => ({}),
  text: async () => "{}",
});

test("getGuildMembers follows pagination past the 1000-member page limit", async () => {
  // Discord caps a page at 1000 and gives no total. Stopping at the first page
  // would make the scan report member 1001 onwards as having left.
  const page = (start, n) =>
    Array.from({ length: n }, (_, i) => ({ user: { id: String(start + i) } }));
  const requests = [];
  globalThis.fetch = async (url) => {
    const after = new URL(String(url)).searchParams.get("after");
    requests.push(after);
    if (after === "0") return ok(page(1, 1000));
    if (after === "1000") return ok(page(1001, 1000));
    if (after === "2000") return ok(page(2001, 250));
    return ok([]);
  };

  const members = await discord.getGuildMembers("G1");
  assert.equal(members.length, 2250);
  assert.deepEqual(requests, ["0", "1000", "2000"], "cursor should be the last id of each page");
  assert.equal(members.at(-1).user.id, "2250");
});

test("getGuildMembers stops on a short page without an extra request", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return ok([{ user: { id: "1" } }, { user: { id: "2" } }]);
  };
  const members = await discord.getGuildMembers("G1");
  assert.equal(members.length, 2);
  assert.equal(calls, 1, "a page below the limit is the last page");
});

test("getGuildMembers handles an empty guild", async () => {
  globalThis.fetch = async () => ok([]);
  assert.deepEqual(await discord.getGuildMembers("G1"), []);
});

test("a 429 is retried and the call still succeeds", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return calls === 1 ? err(429) : ok([{ id: "r1", name: "scout" }]);
  };
  const roles = await discord.getGuildRoles("G1");
  assert.equal(calls, 2);
  assert.equal(roles[0].name, "scout");
});

test("a non-429 error is not retried", async () => {
  // Retrying a 403 or a 404 just delays the failure and multiplies the log noise.
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return err(403);
  };
  await assert.rejects(() => discord.getGuildRoles("G1"), /403/);
  assert.equal(calls, 1);
});

test("errors carry the HTTP status so callers can branch on it", async () => {
  // memberscan distinguishes 403 on the audit log (missing permission, degrade)
  // from anything else (real failure, stop) purely by this field.
  globalThis.fetch = async () => err(404);
  await assert.rejects(
    () => discord.getGuildMember("G1", "u1"),
    (e) => e.status === 404,
  );
});

test("postChannelMessage never lets a log line ping anyone", async () => {
  let body;
  globalThis.fetch = async (url, opts) => {
    body = JSON.parse(opts.body);
    return ok({});
  };
  await discord.postChannelMessage("C1", "<@1> <@&2> @everyone");
  // Not optional: log lines carry mentions so a moderator can click through, and
  // without this every entry would notify the person it is about.
  assert.deepEqual(body.allowed_mentions, { parse: [] });
  assert.equal(body.content, "<@1> <@&2> @everyone");
});

test("the bot token is sent as a Bot token, not a bearer token", async () => {
  let headers;
  globalThis.fetch = async (url, opts) => {
    headers = opts.headers;
    return ok([]);
  };
  await discord.getGuildRoles("G1");
  assert.equal(headers.Authorization, "Bot test-token");
});

test("removeRoleFromUser and addRoleToUser use the right verbs", async () => {
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    seen.push(`${opts.method} ${new URL(String(url)).pathname}`);
    return ok({});
  };
  await discord.addRoleToUser("G1", "u1", "r1");
  await discord.removeRoleFromUser("G1", "u1", "r1");
  assert.deepEqual(seen, [
    "PUT /api/v10/guilds/G1/members/u1/roles/r1",
    "DELETE /api/v10/guilds/G1/members/u1/roles/r1",
  ]);
});

test("verifyInteraction rejects a request that is not properly signed", () => {
  // This is the only thing standing between the interactions endpoint and anyone
  // on the internet posting a forged admin command.
  const result = discord.verifyInteraction(
    "0".repeat(64),
    "1".repeat(128),
    String(Math.floor(Date.now() / 1000)),
    '{"type":1}',
  );
  assert.equal(result, false);
});
