import { TableClient } from "@azure/data-tables";
import config from "./config.js";

/**
 * Durable storage backed by Azure Table Storage.
 *
 * Data model — a single table, partitioned by record type:
 *   PartitionKey   RowKey          value (+ expiresAt for state)
 *   link           discordUserId   scoutId
 *   discord-token  userId          JSON
 *   scoutid-token  userId          JSON
 *   state          state           JSON   + expiresAt   (OAuth, 10 min)
 *   membersnapshot current         chunk0..chunkN + chunks + auditCursors
 *
 * Table Storage has no native TTL, so state rows carry an `expiresAt`
 * (epoch ms) and are treated as absent past that time (lazy expiry).
 *
 * The ScoutNet participant cache is NOT stored here — the full list exceeds
 * Table Storage's 64 KB/property limit, and it's a throwaway cache, so it
 * lives in process memory (see below).
 */

const STATE_TTL_MS = 10 * 60 * 1000;
const SCOUTNET_TTL_MS = 10 * 60 * 1000;

// `allowInsecureConnection` defaults to false, and the SDK then refuses a plain
// http endpoint before it even opens a socket — which is every Azurite setup,
// including the docker-compose one this project documents for local dev. It
// failed with "Cannot connect to http://azurite:10002/... while
// allowInsecureConnection is false".
//
// Gated on the connection string actually being http, so it cannot loosen
// anything in production: the real account is https, the flag stays false there,
// and a misconfiguration that downgraded prod to http would still be refused —
// it would have to say so in the connection string to get here.
const insecureEndpoint = /(^|;)\s*(TableEndpoint\s*=\s*http:\/\/|DefaultEndpointsProtocol\s*=\s*http\s*(;|$))/i.test(
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
    // 409 = table already exists, which is the normal steady state.
    if (err?.statusCode !== 409) throw err;
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

// --- ScoutID tokens ---

export async function storeScoutIDTokens(userId, tokens) {
  await ensureTable();
  await setValue("scoutid-token", userId, JSON.stringify(tokens));
}

export async function getScoutIDTokens(userId) {
  await ensureTable();
  const e = await getEntity("scoutid-token", userId);
  return e ? JSON.parse(e.value) : null;
}

// --- OAuth state (short-lived) ---

export async function storeStateData(state, data) {
  await ensureTable();
  await setValue("state", state, JSON.stringify(data), Date.now() + STATE_TTL_MS);
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

// --- Discord <-> ScoutID link (durable) ---

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
 * Discord user ids that still have stored OAuth tokens, as a Set.
 *
 * One paginated listing per partition rather than a point read per user: the
 * audit needs this for every linked user at once, and the SDK follows the
 * continuation token here where a per-user loop would cost one request each.
 *
 * `type` is "discord-token" or "scoutid-token". Only row keys are needed, so
 * the token values are never deserialised — nothing sensitive is returned.
 */
export async function getUserIdsWithTokens(type) {
  await ensureTable();
  const ids = new Set();
  const entities = client.listEntities({
    queryOptions: { filter: `PartitionKey eq '${type}'`, select: ["RowKey"] },
  });
  for await (const e of entities) {
    ids.add(e.rowKey);
  }
  return ids;
}

// --- Guild member snapshot (durable) ---
//
// The previous state of the guild's member list, so a scheduled scan can tell
// what changed since last time. It has to be durable and it has to be shared:
// the web deployment runs two replicas and the scan runs as a CronJob, so
// process memory would be both duplicated and lost between runs.
//
// **Why it is chunked.** A single Table Storage string property holds at most
// **32K UTF-16 characters** — that is what the documented "64 KB" means, since
// the service counts two bytes per character. Measured against the live guild a
// member costs ~60 characters here (id, nick, username), so one property would
// hold roughly 500 members and then start failing — the sort of ceiling that is
// invisible until a big intake pushes past it. Splitting across properties of
// one entity moves the limit to the 1 MB per-entity cap, well beyond any
// contingent this will ever hold.
//
// The chunk size is in characters, not bytes, and deliberately far below the
// maximum. Two things were measured, not assumed. A chunk of exactly 32768
// characters is rejected outright with `PropertyValueTooLarge`. Worse, at 16384
// characters Azurite returned the data *silently corrupted* — a multi-byte `ä`
// came back as two replacement characters, mid-property — while 8192 round-tripped
// 2500 members byte-identically. Whether the real service shares that behaviour
// was not established; the margin costs nothing but property count, and the 1 MB
// entity cap binds long before the 252-property one.
//
// Because that corruption was silent, `chars` records the expected length and
// the read side checks it. A snapshot that fails the check is treated as absent,
// so the scan reseeds a baseline instead of reporting a diff full of members who
// never joined and never left.
//
// Written and read as one entity, so the snapshot can never be torn: a partial
// write would produce a diff full of bogus joins and leaves. `chunks` records
// how many properties to read back, and stale chunks from a previously larger
// snapshot are harmless because "Replace" drops properties not written.
//
// `auditCursors` rides along in the same entity for the same reason: they are the
// Discord audit-log cursors, and they have to advance in the same atomic write as
// the member list. Two entities could disagree after a partial failure, and the
// disagreement would either duplicate or lose entries.
//
// One cursor **per action type**, as a JSON map of `actionType -> entry id`, not
// one shared cursor over the whole log. A shared cursor would let a burst of one
// type crowd out another: `/refresh-scoutid alla:true` writes an entry per changed
// user, and a kick that happened in the same window would sit below the cap and
// be skipped forever once the cursor moved past it. Per-type cursors also mean
// each fetch can filter server-side, so a noisy type costs nothing to a quiet one.

const SNAPSHOT_CHUNK_CHARS = 8 * 1024;

/**
 * Store the member snapshot. `members` is `{ [discordUserId]: [nick, username] }`
 * — arrays rather than objects because the key names would otherwise be repeated
 * once per member and roughly double the size.
 *
 * `auditCursors` maps audit-log action type to the newest entry already reported.
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
  // Stored as a JSON string, so the snowflake ids stay exact: they exceed the
  // range a double represents precisely and would come back rounded if written
  // as numbers.
  entity.auditCursors = JSON.stringify(auditCursors ?? {});
  await client.upsertEntity(entity, "Replace");
}

/**
 * Read the snapshot back as `{ members, auditCursors }`, or null if there has
 * never been one. A null return is the signal to seed a baseline rather than
 * report every current member as a new arrival.
 *
 * Reads the pre-existing single `lastAuditId` as the role-update cursor when
 * `auditCursors` is absent, so the snapshot written before per-type cursors
 * existed does not cause the whole role history to be replayed once.
 */
export async function getMemberSnapshot() {
  await ensureTable();
  const e = await getEntity("membersnapshot", "current");
  if (!e) return null;

  // An entity that exists but carries no chunk count is corrupt, not absent, and
  // the two must not look alike: absent means "first run, seed a baseline",
  // corrupt means something ate the data. Returning null for both silently is
  // how a storage problem gets mistaken for a fresh install.
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

// --- ScoutNet cache (short-lived, in-memory) ---
//
// The full event participant list can be several MB, which exceeds Azure
// Table Storage's 64 KB per-property / 1 MB per-entity limit. Since this is a
// purely ephemeral performance cache (10-minute TTL, only avoids re-hitting
// the ScoutNet API), it lives in process memory instead. A cache miss after a
// restart or on a fresh replica just triggers one extra ScoutNet fetch.

const scoutNetCache = new Map(); // type -> { value, expiresAt }

export async function storeScoutNetData(type, data) {
  scoutNetCache.set(type, { value: data, expiresAt: Date.now() + SCOUTNET_TTL_MS });
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
