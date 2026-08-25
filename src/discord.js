import crypto from "crypto";

import * as storage from "./storage.js";
import config from "./config.js";
import { request, retryDelayMs } from "./http.js";

/**
 * Discord API client: OAuth2, role management, audit log and interactions.
 *
 * Every call goes through `request` in http.js, which owns the rate-limit retry
 * and stamps `error.status` — callers branch on it.
 */

const API = "https://discord.com/api/v10";

const bot = () => ({ Authorization: `Bot ${config.DISCORD_TOKEN}` });
const bearer = (accessToken) => ({ Authorization: `Bearer ${accessToken}` });
const json = (headers) => ({ ...headers, "Content-Type": "application/json" });

export { retryDelayMs };

// --- OAuth2 ---

export function getOAuthUrl() {
  const state = crypto.randomUUID();
  const url = new URL("https://discord.com/api/oauth2/authorize");
  url.searchParams.set("client_id", config.DISCORD_CLIENT_ID);
  url.searchParams.set("redirect_uri", config.DISCORD_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  url.searchParams.set("scope", "role_connections.write identify");
  url.searchParams.set("prompt", "consent");
  return { state, url: url.toString() };
}

function tokenRequest(what, params) {
  return request(`${API}/oauth2/token`, {
    what,
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.DISCORD_CLIENT_ID,
      client_secret: config.DISCORD_CLIENT_SECRET,
      ...params,
    }),
  });
}

export function getOAuthTokens(code) {
  return tokenRequest("Error fetching OAuth tokens", {
    grant_type: "authorization_code",
    code,
    redirect_uri: config.DISCORD_REDIRECT_URI,
  });
}

/**
 * The user's access token, refreshed and re-stored if it has expired.
 *
 * The comparison is deliberately `>` on the expiry rather than `<=` on its
 * negation: a stored token with no `expires_at` compares false either way, and
 * this direction then uses the token instead of spending a refresh on it.
 */
export async function getAccessToken(userId, tokens) {
  if (Date.now() > tokens.expires_at) {
    const fresh = await tokenRequest("Error refreshing access token", {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    });
    fresh.expires_at = Date.now() + fresh.expires_in * 1000;
    await storage.storeDiscordTokens(userId, fresh);
    return fresh.access_token;
  }
  return tokens.access_token;
}

// --- User data ---

export function getUserData(tokens) {
  return request(`${API}/oauth2/@me`, {
    what: "Error fetching user data",
    headers: bearer(tokens.access_token),
  });
}

export function getUserGuilds(tokens) {
  return request(`${API}/users/@me/guilds`, {
    what: "Error fetching user guilds",
    headers: bearer(tokens.access_token),
  });
}

// --- Linked role metadata ---

const roleConnectionUrl = () =>
  `${API}/users/@me/applications/${config.DISCORD_CLIENT_ID}/role-connection`;

/**
 * `platformUsername` is the only part of this Discord ever *shows*: it is the
 * line under "ScoutID" on the user's connection card. The metadata keys are read
 * by role requirements and are otherwise invisible.
 */
export async function pushMetadata(userId, tokens, metadata, platformUsername) {
  const accessToken = await getAccessToken(userId, tokens);
  await request(roleConnectionUrl(), {
    what: "Error pushing metadata",
    parse: "none",
    withBody: true,
    method: "PUT",
    headers: json(bearer(accessToken)),
    body: JSON.stringify({
      platform_name: "ScoutID",
      platform_username: platformUsername ?? "",
      metadata,
    }),
  });
}

/**
 * Read back the role-connection Discord holds for a user, with *their* token —
 * the liveness probe for their OAuth grant, so it must be a read. The status
 * comes back unjudged: 200 is a live grant, 401 a revoked one, and anything
 * else is *not* a no.
 */
export async function getRoleConnection(userId, tokens) {
  const accessToken = await getAccessToken(userId, tokens);
  const response = await request(roleConnectionUrl(), {
    parse: "raw",
    headers: bearer(accessToken),
  });
  return { status: response.status, ok: response.ok };
}

// --- Guild member management ---

/** Returns false instead of throwing: a rename is never worth failing a sync over. */
export async function updateGuildMemberNickname(guildId, userId, nickname) {
  try {
    await request(`${API}/guilds/${guildId}/members/${userId}`, {
      what: `Error updating nickname in guild ${guildId}`,
      parse: "none",
      method: "PATCH",
      headers: json(bot()),
      body: JSON.stringify({ nick: nickname }),
    });
    console.log(
      `Updated nickname for ${userId} in guild ${guildId} to "${nickname}"`,
    );
    return true;
  } catch {
    return false;
  }
}

export function getGuildRoles(guildId) {
  return request(`${API}/guilds/${guildId}/roles`, {
    what: "Error fetching guild roles",
    headers: bot(),
  });
}

/**
 * Every member, following the pagination past Discord's 1000-per-page cap.
 * Stopping at the first page would make the member scan report everyone past
 * member 1000 as having left the server.
 */
export async function getGuildMembers(guildId) {
  const members = [];
  let after = "0";
  for (;;) {
    const page = await request(
      `${API}/guilds/${guildId}/members?limit=1000&after=${after}`,
      { what: "Error fetching guild members", headers: bot() },
    );
    if (!page.length) break;
    members.push(...page);
    if (page.length < 1000) break;
    after = page[page.length - 1].user.id;
  }
  return members;
}

export function getGuildMember(guildId, userId) {
  return request(`${API}/guilds/${guildId}/members/${userId}`, {
    what: "Error fetching guild member",
    headers: bot(),
  });
}

let cachedBotUserId = null;

export async function getCurrentBotUserId() {
  cachedBotUserId ??= (
    await request(`${API}/users/@me`, {
      what: "Error fetching bot user",
      headers: bot(),
    })
  ).id;
  return cachedBotUserId;
}

export async function getBotMember(guildId) {
  return getGuildMember(guildId, await getCurrentBotUserId());
}

const roleUrl = (guildId, userId, roleId) =>
  `${API}/guilds/${guildId}/members/${userId}/roles/${roleId}`;

export function addRoleToUser(guildId, userId, roleId) {
  return request(roleUrl(guildId, userId, roleId), {
    what: `Error adding role ${roleId}`,
    parse: "none",
    method: "PUT",
    headers: bot(),
  });
}

export function removeRoleFromUser(guildId, userId, roleId) {
  return request(roleUrl(guildId, userId, roleId), {
    what: `Error removing role ${roleId}`,
    parse: "none",
    method: "DELETE",
    headers: bot(),
  });
}

// --- Channel messages ---

/**
 * Post a plain message to a channel as the bot.
 *
 * `allowed_mentions: { parse: [] }` is not optional. Log lines carry `<@id>` so
 * a moderator can click through, and without this every entry would ping the
 * person it is about — an audit trail turned into a notification storm.
 *
 * The bot's role grants only Manage Roles and Manage Nicknames, so it can write
 * here purely on a channel overwrite granted in wsj27-infra. A 403 therefore
 * means the overwrite is missing, not that the token is wrong.
 */
export function postChannelMessage(channelId, content) {
  return request(`${API}/channels/${channelId}/messages`, {
    what: `Error posting to channel ${channelId}`,
    parse: "none",
    method: "POST",
    headers: json(bot()),
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
  });
}

// --- Audit log ---

/** Discord audit-log action types this bot reads. */
export const AUDIT_MEMBER_ROLE_UPDATE = 25;
export const AUDIT_MEMBER_KICK = 20;
export const AUDIT_MEMBER_BAN_ADD = 22;

function auditLogPage(guildId, params) {
  return request(`${API}/guilds/${guildId}/audit-logs?${params}`, {
    what: `Error fetching audit log for guild ${guildId}`,
    headers: bot(),
  });
}

/**
 * The id of the newest audit-log entry, or null if the log is empty. Used to
 * seed the cursor on a first run — the point is to start reporting from now on,
 * not to replay however much history Discord still holds.
 */
export async function getNewestAuditLogId(guildId, actionType) {
  const params = new URLSearchParams({ limit: "1" });
  if (actionType != null) params.set("action_type", String(actionType));
  const body = await auditLogPage(guildId, params);
  return body.audit_log_entries?.[0]?.id ?? null;
}

/**
 * Audit-log entries newer than `after`, oldest first, as `{ entries, truncated }`.
 * Throws with `status = 403` when the bot's role lacks View Audit Log.
 *
 * **Pagination runs backwards on purpose.** Discord returns newest-first and
 * `after` does not change that: `?after=X&limit=100` yields the 100 *newest*
 * entries above X, so with 150 waiting the 50 closest to X are absent, and
 * advancing the cursor past them skips them forever. Paging down with `before`
 * until an entry at or below the cursor appears covers the gap — and one
 * `/refresh-scoutid alla:true` fills a 100-entry window routinely.
 */
export async function getAuditLogEntries(
  guildId,
  { actionType, after, cap = 500 },
) {
  if (after == null) {
    throw new Error("getAuditLogEntries requires an `after` cursor");
  }
  const entries = [];
  const afterId = BigInt(after);
  let before = null;
  let truncated = false;

  for (;;) {
    const params = new URLSearchParams({ limit: "100" });
    if (actionType != null) params.set("action_type", String(actionType));
    if (before) params.set("before", before);

    const batch = (await auditLogPage(guildId, params)).audit_log_entries ?? [];
    if (batch.length === 0) break;

    let reachedCursor = false;
    for (const entry of batch) {
      if (BigInt(entry.id) <= afterId) {
        reachedCursor = true;
        break;
      }
      entries.push(entry);
    }
    if (reachedCursor || batch.length < 100) break;
    if (entries.length >= cap) {
      truncated = true;
      break;
    }
    before = batch[batch.length - 1].id;
  }

  entries.reverse(); // oldest first, so the log reads in the order things happened
  return { entries, truncated };
}

// --- Slash commands ---

const USER = 6;
const STRING = 3;
const BOOLEAN = 5;
const ADMIN_ONLY = "8"; // default_member_permissions: ADMINISTRATOR

/**
 * Every command this bot answers. `dryrun` and not `torrkor` throughout: the
 * option name is an interface admins type, and it is the same word in every CLI
 * they have used. Descriptions stay Swedish — those are prose.
 */
export const COMMANDS = [
  {
    name: "refresh-scoutid",
    description: "Uppdatera ScoutID-roller",
    options: [
      {
        name: "person",
        description: "Person att uppdatera (admin krävs för andra)",
        type: USER,
      },
      {
        name: "alla",
        description: "Uppdatera alla länkade användare (admin krävs)",
        type: BOOLEAN,
      },
      {
        name: "dryrun",
        description: "Visa vad som skulle ändras utan att ändra något",
        type: BOOLEAN,
      },
    ],
  },
  {
    name: "status-scoutid",
    description: "Visa allt boten vet om en person (admin)",
    default_member_permissions: ADMIN_ONLY,
    options: [
      {
        // Required, so this command answers only "what about this person".
        // The server-wide picture is `/audit-scoutid` and `/adoption-scoutid`.
        name: "person",
        description: "Person att visa status för",
        type: USER,
        required: true,
      },
    ],
  },
  {
    name: "audit-scoutid",
    description:
      "Lista avvikelser mellan Discord, ScoutID-länkar och ScoutNet (admin)",
    default_member_permissions: ADMIN_ONLY,
  },
  {
    name: "scan-scoutid",
    description:
      "Kör medlemsscannern nu i stället för att vänta på schemat (admin)",
    default_member_permissions: ADMIN_ONLY,
    options: [
      {
        name: "dryrun",
        description:
          "Visa vad som skulle rapporteras utan att posta eller spara",
        type: BOOLEAN,
      },
    ],
  },
  {
    name: "adoption-scoutid",
    description:
      "Hur många av de anmälda som har länkat sig, per grupp (admin)",
    default_member_permissions: ADMIN_ONLY,
    options: [
      {
        // Off by default: naming everyone who has not linked is thousands of
        // lines, and the counts are what most questions need.
        name: "saknas",
        description: "Lista namnen på dem som inte länkat sig",
        type: BOOLEAN,
      },
    ],
  },
  {
    name: "link-scoutid",
    description:
      "Länka manuellt en Discord-användare till ett ScoutNet member_no (admin)",
    default_member_permissions: ADMIN_ONLY,
    options: [
      {
        name: "person",
        description: "Discord-användare att länka",
        type: USER,
        required: true,
      },
      {
        name: "scoutid",
        description: "ScoutNet member_no",
        type: STRING,
        required: true,
      },
    ],
  },
];

/** Register one command definition against a guild. */
export function registerCommand(guildId, command) {
  return request(
    `${API}/applications/${config.DISCORD_CLIENT_ID}/guilds/${guildId}/commands`,
    {
      what: `Error registering /${command.name}`,
      withBody: true,
      method: "POST",
      headers: json(bot()),
      body: JSON.stringify(command),
    },
  );
}

// --- Interaction verification ---

export function verifyInteraction(publicKey, signature, timestamp, body) {
  const ed25519DerPrefix = "302a300506032b6570032100";
  try {
    return crypto.verify(
      null,
      Buffer.from(timestamp + body),
      {
        key: Buffer.from(ed25519DerPrefix + publicKey, "hex"),
        format: "der",
        type: "spki",
      },
      Buffer.from(signature, "hex"),
    );
  } catch {
    return false;
  }
}

// --- Interaction responses ---

const interactionUrl = (token) =>
  `${API}/webhooks/${config.DISCORD_CLIENT_ID}/${token}/messages/@original`;

export function editInteractionResponse(interactionToken, content) {
  return request(interactionUrl(interactionToken), {
    what: "Error editing interaction response",
    parse: "none",
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
}

export function editInteractionResponseWithFile(
  interactionToken,
  content,
  filename,
  fileContent,
) {
  const form = new FormData();
  form.append(
    "payload_json",
    JSON.stringify({ content, attachments: [{ id: 0, filename }] }),
  );
  form.append(
    "files[0]",
    new Blob([fileContent], { type: "text/plain" }),
    filename,
  );

  return request(interactionUrl(interactionToken), {
    what: "Error editing interaction response with file",
    parse: "none",
    method: "PATCH",
    body: form,
  });
}
