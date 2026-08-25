import { TableClient } from "@azure/data-tables";
import config from "./config.js";

/**
 * Durable storage backed by Azure Table Storage. One table, partitioned by type:
 *
 *   PartitionKey    RowKey          value
 *   link            discordUserId   scoutId
 *   discord-token   userId          JSON
 *   state           state           JSON + expiresAt   (OAuth, 10 min)
 *   membersnapshot  current         chunk0..chunkN + chunks + auditCursors
 *
 * There is no native TTL, so state rows carry an `expiresAt` and are treated as
 * absent past it. The ScoutNet participant cache is **not** here — it exceeds the
 * per-property limit and is throwaway, so it lives in process memory below.
 */

const STATE_TTL_MS = 10 * 60 * 1000;
const SCOUTNET_TTL_MS = 10 * 60 * 1000;

// `allowInsecureConnection` defaults to false and the SDK then refuses a plain
// http endpoint before opening a socket — which is every Azurite setup. Gated on
// the connection string actually saying http, so it cannot loosen anything in
// production: the real account is https and the flag stays false there.
const insecureEndpoint =
  /(^|;)\s*(TableEndpoint\s*=\s*http:\/\/|DefaultEndpointsProtocol\s*=\s*http\s*(;|$))/i.test(
    config.TABLE_CONNECTION_STRING ?? "",
  );

const client = TableClient.fromConnectionString(
  config.TABLE_CONNECTION_STRING,
  config.TABLE_NAME,
  { allowInsecureConnection: insecureEndpoint },
);

let tableReady = false;
async function ensureTable() {
  if (tableReady) return;
  try {
    await client.createTable();
  } catch (err) {
    if (err?.statusCode !== 409) throw err; // 409 = exists, the steady state
  }
  tableReady = true;
}

async function getEntity(partitionKey, rowKey) {
  try {
    return await client.getEntity(partitionKey, rowKey);
  } catch (err) {
    if (err?.statusCode === 404) return null;
    throw err;
  }
}

async function setValue(partitionKey, rowKey, value, expiresAt) {
  const entity = { partitionKey, rowKey, value };
  if (expiresAt != null) entity.expiresAt = expiresAt;
  await client.upsertEntity(entity, "Replace");
}

/**
 * A cheap round trip, for the readiness probe. A 404 counts as healthy: what is
 * proved is that the request was signed, routed and answered. A wrong key answers
 * 403 and an unreachable endpoint not at all, and `getEntity` throws on both.
 */
export async function ping() {
  await ensureTable();
  await getEntity("health", "probe");
  return true;
}

// --- Discord tokens ---

export async function storeDiscordTokens(userId, tokens) {
  await ensureTable();
  await setValue("discord-token", userId, JSON.stringify(tokens));
}

export async function getDiscordTokens(userId) {
  await ensureTable();
  const e = await getEntity("discord-token", userId);
  return e ? JSON.parse(e.value) : null;
}

// --- OAuth state (short-lived) ---

export async function storeStateData(state, data) {
  await ensureTable();
  await setValue(
    "state",
    state,
    JSON.stringify(data),
    Date.now() + STATE_TTL_MS,
  );
}

export async function getStateData(state) {
  await ensureTable();
  const e = await getEntity("state", state);
  if (!e) return null;
  if (e.expiresAt != null && Date.now() > e.expiresAt) {
    client.deleteEntity("state", state).catch(() => {});
    return null;
  }
  return JSON.parse(e.value);
}

// --- Discord ↔ ScoutID link (durable) ---

export async function setLinkedScoutIDUserId(discordUserId, scoutUserId) {
  await ensureTable();
  await setValue("link", discordUserId, scoutUserId);
}

export async function getLinkedScoutIDUserId(discordUserId) {
  await ensureTable();
  const e = await getEntity("link", discordUserId);
  return e ? e.value : null;
}

export async function getAllLinkedUsers() {
  await ensureTable();
  const users = [];
  const entities = client.listEntities({
    queryOptions: { filter: "PartitionKey eq 'link'" },
  });
  for await (const e of entities) {
    users.push({ discordUserId: e.rowKey, scoutId: e.value });
  }
  return users;
}

/**
 * Discord user ids that still have stored OAuth tokens. One paginated listing
 * rather than a point read per user, since the audit needs all of them at once.
 * Only row keys are selected, so no token value is ever deserialised.
 */
export async function getUserIdsWithTokens(type) {
  await ensureTable();
  const ids = new Set();
  const entities = client.listEntities({
    queryOptions: { filter: `PartitionKey eq '${type}'`, select: ["RowKey"] },
  });
  for await (const e of entities) ids.add(e.rowKey);
  return ids;
}

// --- Guild member snapshot (durable) ---
//
// The previous state of the member list, so a scheduled scan can tell what
// changed. Durable and shared, because the web deployment runs two replicas and
// the scan runs as a CronJob.
//
// **Chunked**, because one string property holds at most 32K UTF-16 *characters* —
// that is what the documented "64 KB" means, the service counting two bytes per
// character. A member costs ~60 characters, so one property caps out around 500
// members; spreading across properties of one entity moves the ceiling to the
// 1 MB per-entity cap.
//
// 8192 rather than the maximum, because the failure modes above it are not all
// loud: exactly 32768 is rejected with `PropertyValueTooLarge`, but at 16384
// Azurite returns the data *silently corrupted* — a multi-byte `ä` comes back as
// two replacement characters mid-property — while 8192 round-trips 2500 members
// byte-identically. `chars` records the expected length so the read side can
// catch a corruption that announces itself no other way.
//
// Written and read as **one entity**, so the snapshot can never be torn: a partial
// write would diff into bogus joins and leaves. `chunks` says how many properties
// to read, and stale chunks from a larger snapshot are dropped by "Replace".
//
// `auditCursors` rides along in the same entity because it has to advance in the
// same atomic write, or the two could disagree after a partial failure and either
// duplicate or lose entries. One cursor **per action type**, so a burst of one
// type cannot crowd out another and each fetch can filter server-side.

const SNAPSHOT_CHUNK_CHARS = 8 * 1024;

/**
 * Store the snapshot. `members` is `{ [discordUserId]: [nick, username] }` —
 * arrays, or the key names would repeat per member and roughly double the size.
 * `auditCursors` maps action type to the newest entry already reported.
 */
export async function storeMemberSnapshot(members, auditCursors = null) {
  await ensureTable();
  const json = JSON.stringify(members);
  const entity = { partitionKey: "membersnapshot", rowKey: "current" };

  let chunks = 0;
  for (let i = 0; i < json.length; i += SNAPSHOT_CHUNK_CHARS) {
    entity[`chunk${chunks++}`] = json.slice(i, i + SNAPSHOT_CHUNK_CHARS);
  }
  entity.chunks = chunks;
  entity.chars = json.length;
  entity.savedAt = Date.now();
  // A JSON string, so the snowflake ids stay exact: they exceed the range a
  // double represents precisely and would come back rounded as numbers.
  entity.auditCursors = JSON.stringify(auditCursors ?? {});
  await client.upsertEntity(entity, "Replace");
}

/**
 * Read the snapshot back as `{ members, auditCursors }`, or **null** when there
 * has never been a usable one — the signal to seed a baseline rather than report
 * every current member as a new arrival. A pre-existing single `lastAuditId` is
 * honoured as the role-update cursor so no history gets replayed.
 */
export async function getMemberSnapshot() {
  await ensureTable();
  const e = await getEntity("membersnapshot", "current");
  if (!e) return null;

  // Corrupt, not absent — the two return the same null, so the distinction has
  // to live in the log.
  if (!e.chunks) {
    console.error(
      "Member snapshot exists but has no chunk count — treating it as absent. " +
        "The write that produced it did not land completely.",
    );
    return null;
  }

  let json = "";
  for (let i = 0; i < e.chunks; i++) json += e[`chunk${i}`] ?? "";
  if (!json) {
    console.error(
      `Member snapshot claims ${e.chunks} chunk(s) but none of them are readable.`,
    );
    return null;
  }
  if (e.chars != null && json.length !== e.chars) {
    console.error(
      `Member snapshot is truncated or corrupt: expected ${e.chars} characters, ` +
        `read ${json.length}. Treating it as absent so the next scan reseeds.`,
    );
    return null;
  }

  try {
    let auditCursors = {};
    if (e.auditCursors) auditCursors = JSON.parse(e.auditCursors);
    else if (e.lastAuditId) auditCursors = { 25: e.lastAuditId };
    return { members: JSON.parse(json), auditCursors };
  } catch (err) {
    // A snapshot we cannot parse is worse than none: it would diff into
    // nonsense. Treat it as absent and let the next run reseed.
    console.error(`Member snapshot is corrupt, ignoring it: ${err.message}`);
    return null;
  }
}

// --- ScoutNet cache (short-lived, in process memory) ---
//
// The participant list is several MB, past both the per-property and per-entity
// limits, and it is a pure performance cache: a miss costs one extra fetch.

const scoutNetCache = new Map(); // type -> { value, expiresAt }

export async function storeScoutNetData(type, data) {
  scoutNetCache.set(type, {
    value: data,
    expiresAt: Date.now() + SCOUTNET_TTL_MS,
  });
}

export async function getScoutNetData(type) {
  const entry = scoutNetCache.get(type);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    scoutNetCache.delete(type);
    return null;
  }
  return entry.value;
}

export async function clearScoutNetCache() {
  scoutNetCache.clear();
}
