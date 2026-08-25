import config from "./config.js";
import * as scoutnet from "./scoutnet.js";
import * as discord from "./discord.js";
import * as storage from "./storage.js";
import * as metadata from "./metadata.js";
import {
  UNVERIFIED_ROLE,
  NICK_MAX,
  roleMapOf,
  guildNick,
  stripNickSuffix,
  divisionRoleName,
  withDivision,
  managedRoleNames,
  divisionPrefixes,
  changedAnything,
} from "./guild.js";

/**
 * What roles a member should have, and the writes that get them there. In layers:
 * the Scout marker, the event role, a flat category marker, a division role —
 * plus a nickname of the ScoutNet name and a per-category suffix, so "Anna
 * Andersson" becomes "Anna Andersson (AL12)".
 */

/**
 * The member's fee category and division. `null` means not a live participant;
 * a **throw** means ScoutNet could not be asked — see `getDesiredRoles`.
 */
async function getParticipantInfo(scoutnetMemberId) {
  if (!config.SCOUTNET_EVENT_ID) return null;

  const participant = await scoutnet.getParticipant(scoutnetMemberId);
  if (!participant || scoutnet.isCancelled(participant)) return null;

  const category =
    participant.fee_id != null
      ? config.SCOUTNET_FEE_ROLES?.[String(participant.fee_id)]
      : null;
  const divConfig = category
    ? config.SCOUTNET_DIVISION_ROLES?.[category]
    : null;

  return {
    category,
    division: divConfig
      ? participant.questions?.[divConfig.questionId] || null
      : null,
  };
}

/**
 * Which roles this member should hold. **Throws when ScoutNet cannot be
 * reached**: an answer without the event role *means* "take the event, category
 * and division roles away", so a lenient answer during an outage disarms
 * everyone. `allowIncomplete: true` opts back into leniency and is only for the
 * linking flow, which exclusively *adds* roles.
 */
export async function getDesiredRoles(
  scoutnetMemberId,
  { allowIncomplete = false } = {},
) {
  const roles = [config.SCOUTNET_SCOUT_ROLE];

  try {
    const info = await getParticipantInfo(scoutnetMemberId);
    if (!info) return roles;

    roles.push(config.SCOUTNET_EVENT_ROLE);
    if (info.category) {
      const flatRole = config.SCOUTNET_CATEGORY_ROLES?.[info.category];
      if (flatRole) roles.push(flatRole);

      const divConfig = config.SCOUTNET_DIVISION_ROLES?.[info.category];
      roles.push(
        divConfig ? divisionRoleName(divConfig, info.division) : info.category,
      );
    }
  } catch (e) {
    if (!allowIncomplete) throw e;
    console.error(
      `Error fetching ScoutNet data for member ${scoutnetMemberId}:`,
      e.message,
    );
    // Discard the partial answer: half a wish list is indistinguishable from a
    // complete one to the caller.
    return [config.SCOUTNET_SCOUT_ROLE];
  }

  return roles;
}

/**
 * The nickname suffix for this member — " (CMT)", " (AL12)", " (03)" — or "".
 *
 * Throws on a ScoutNet failure for the same reason as `getDesiredRoles`: an
 * empty suffix is a real instruction to rename someone, not a shrug.
 */
export async function getNicknameSuffix(
  scoutnetMemberId,
  { allowIncomplete = false } = {},
) {
  if (!config.SCOUTNET_NICKNAME_SUFFIXES) return "";

  try {
    const info = await getParticipantInfo(scoutnetMemberId);
    if (!info?.category) return "";

    const suffix = config.SCOUTNET_NICKNAME_SUFFIXES[info.category];
    if (!suffix) return "";
    if (info.division && suffix.withDiv) {
      return ` (${withDivision(suffix.withDiv, info.division)})`;
    }
    return suffix.withoutDiv ? ` (${suffix.withoutDiv})` : "";
  } catch (e) {
    if (!allowIncomplete) throw e;
    console.error(
      `Error getting nickname suffix for member ${scoutnetMemberId}:`,
      e.message,
    );
    return "";
  }
}

/**
 * Why is there nothing to give this member? A short clause, or **null** when
 * there is nothing to explain. **Never throws** — it explains a linking and must
 * not be able to fail one — and an outage is reported *as an outage*: the
 * linking path asks with `allowIncomplete`, so this is the only place that can
 * still tell "not registered" from "could not ask".
 */
export async function explainMissingRoles(scoutnetMemberId) {
  if (!config.SCOUTNET_EVENT_ID) return "eventroller är avstängda";

  let participant;
  try {
    participant = await scoutnet.getParticipant(scoutnetMemberId);
  } catch (e) {
    console.error(
      `Could not explain the empty role set for member ${scoutnetMemberId}:`,
      e.message,
    );
    // Without `e.message`: this string goes to a Discord channel, and ScoutNet's
    // API key travels in the query string of the call that just failed.
    return "kunde inte nå ScoutNet — rollerna kommer vid nästa synk";
  }

  if (!participant) return "inte anmäld i eventet";
  if (scoutnet.isCancelled(participant)) {
    return `avbokad anmälan (${scoutnet.cancelledLabel(participant)})`;
  }
  if (participant.fee_id == null) {
    return "anmäld utan avgiftskategori — obekräftad anmälan?";
  }
  if (!config.SCOUTNET_FEE_ROLES?.[String(participant.fee_id)]) {
    return `fee_id ${participant.fee_id} saknar mappning i SCOUTNET_FEE_ROLES`;
  }
  return null;
}

/**
 * Bring the member's roles in line with `desired`. Returns what moved.
 *
 * Removal has two halves: static managed names match exactly, division roles
 * match by **prefix**, since the guild holds one role per division and the config
 * names only the pattern. Managed roles are skipped on both sides — Discord owns
 * the Scout linked role. A failed single write is logged, not thrown: a 403 from
 * the role hierarchy on one role must not abandon the rest.
 */
async function applyRoles(
  guildId,
  userId,
  { roleMap, currentRoleIds, desired, dryRun },
) {
  const desiredSet = new Set(desired.map((r) => r.toLowerCase()));
  const added = [];
  const removed = [];

  const write = async (verb, role, name, into) => {
    const call =
      verb === "add" ? discord.addRoleToUser : discord.removeRoleFromUser;
    try {
      if (!dryRun) await call(guildId, userId, role.id);
      into.push(name);
    } catch (e) {
      console.error(
        `Failed to ${verb} role "${name}" (${role.id}) for user ${userId}: ${e.message}`,
      );
    }
  };

  for (const name of desired) {
    const role = roleMap.get(name.toLowerCase());
    if (role && !role.managed && !currentRoleIds.has(role.id)) {
      await write("add", role, name, added);
    }
  }

  for (const name of managedRoleNames({ includeUnverified: true })) {
    const role = roleMap.get(name.toLowerCase());
    if (
      role &&
      !role.managed &&
      currentRoleIds.has(role.id) &&
      !desiredSet.has(name.toLowerCase())
    ) {
      await write("remove", role, name, removed);
    }
  }

  for (const { prefix } of divisionPrefixes()) {
    for (const [name, role] of roleMap) {
      if (
        name.startsWith(prefix) &&
        currentRoleIds.has(role.id) &&
        !desiredSet.has(name)
      ) {
        await write("remove", role, role.name, removed);
      }
    }
  }

  return { added, removed };
}

/**
 * Rename to `baseName + suffix`, truncated to Discord's limit. Returns the new
 * nickname, or null when it already matches. With no `baseName` the current
 * nickname minus its "(…)" suffix is the base, so a member being stripped keeps
 * their name and loses only the category hint.
 */
async function applyNickname(
  guildId,
  userId,
  member,
  baseName,
  suffix,
  dryRun,
) {
  const currentNick = guildNick(member);
  const base = baseName || stripNickSuffix(currentNick);
  if (!base) return null;

  const newNick = (base + suffix).substring(0, NICK_MAX);
  if (newNick === currentNick) return null;
  if (!dryRun) {
    await discord.updateGuildMemberNickname(guildId, userId, newNick);
  }
  return newNick;
}

/**
 * Is this member verified? **Two independent proofs, either one enough**: the
 * Scout role (Discord's own connection-gated answer, checked first because it is
 * free) or a live OAuth grant (the same fact from the other side, covering
 * members Discord will not re-grant the role to without another click on Link).
 * `{ error }` on `unknown` — acting on "could not ask" would let a Discord
 * outage strip the whole server.
 */
async function checkVerified(discordUserId, roleMap, currentRoleIds) {
  const scoutRole = roleMap.get(config.SCOUTNET_SCOUT_ROLE.toLowerCase());
  if (scoutRole && currentRoleIds.has(scoutRole.id)) return { ok: true };

  const connection = await metadata.verifyConnection(discordUserId);
  if (connection.status === "accepted") return { ok: true };
  if (connection.status === "unknown") {
    return {
      error: `Kunde inte avgöra verifiering, inget ändrades: ${connection.detail}`,
    };
  }
  return { ok: false };
}

/**
 * Sync one member. Returns `{ added, removed, nickname, note }`, or `{ error }`.
 *
 * `options.roleMap` / `options.member` let a caller pass guild state it already
 * holds. `options.dryRun` computes everything and calls nothing — a parameter,
 * never a module flag, because the server handles requests concurrently and a
 * process-global switch would also silence a real linking running at that moment.
 */
export async function syncUserRoles(guildId, discordUserId, options = {}) {
  const { dryRun = false } = options;
  const scoutId = await storage.getLinkedScoutIDUserId(discordUserId);
  if (!scoutId) return { error: "Inte länkad till ScoutID" };

  const roleMap =
    options.roleMap ?? roleMapOf(await discord.getGuildRoles(guildId));
  const member =
    options.member ?? (await discord.getGuildMember(guildId, discordUserId));
  const currentRoleIds = new Set(member.roles);

  const verified = await checkVerified(discordUserId, roleMap, currentRoleIds);
  if (verified.error) return { error: verified.error };

  // The gate above needs no ScoutNet, deliberately: stripping someone who lost
  // the Scout role is the security boundary and has to keep working during an
  // outage. Everything below genuinely needs ScoutNet — so bail out here, before
  // the first write, rather than remove roles we merely failed to confirm.
  let desired;
  let suffix;
  if (verified.ok) {
    try {
      desired = await getDesiredRoles(scoutId);
      suffix = await getNicknameSuffix(scoutId);
    } catch (e) {
      return {
        error: `Kunde inte hämta ScoutNet-data, inget ändrades: ${e.message}`,
      };
    }
  } else {
    desired = [UNVERIFIED_ROLE];
    suffix = "";
  }

  let nickname = null;
  try {
    const participant = verified.ok
      ? await scoutnet.getParticipant(scoutId)
      : null;
    nickname = await applyNickname(
      guildId,
      discordUserId,
      member,
      participant ? scoutnet.fullName(participant) : "",
      suffix,
      dryRun,
    );
  } catch (e) {
    console.error(`Error updating nickname for ${discordUserId}:`, e.message);
  }

  const { added, removed } = await applyRoles(guildId, discordUserId, {
    roleMap,
    currentRoleIds,
    desired,
    dryRun,
  });

  // Only when something moved: for an already-stripped member this is a state,
  // not an event, and logging it every night describes an action not taken.
  if (!verified.ok && changedAnything({ added, removed, nickname })) {
    console.log(
      `User ${discordUserId} (scoutid=${scoutId}) has neither proof — access stripped`,
    );
  }

  // Why nothing was there to give, when that is the whole answer. "Inga
  // ändringar" is equally true for a member who has every role and one who is
  // verified but not in the event, and only the sync knows which. Asked only
  // when the wish list is the bare marker, and free — the participant list is
  // already in the process cache.
  const note =
    verified.ok && desired.length === 1
      ? await explainMissingRoles(scoutId)
      : null;

  return { added, removed, nickname, note };
}

/**
 * Strip a member who has the Scout role but no storage link. The bot cannot take
 * that managed role back, so this removes everything it *can* and sets
 * `Overifierad` — the same state the verification gate produces.
 */
export async function stripUnlinkedMember(
  guildId,
  discordUserId,
  roleMap,
  member,
  { dryRun = false } = {},
) {
  const { added, removed } = await applyRoles(guildId, discordUserId, {
    roleMap,
    currentRoleIds: new Set(member.roles),
    desired: [UNVERIFIED_ROLE],
    dryRun,
  });

  let nickname = null;
  try {
    nickname = await applyNickname(
      guildId,
      discordUserId,
      member,
      "",
      "",
      dryRun,
    );
  } catch (e) {
    console.error(`Error resetting nickname for ${discordUserId}:`, e.message);
  }

  return { added, removed, nickname };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Courtesy pause, paid only when something was written — at 2500 members,
 * pausing regardless is eight minutes of sleeping to report that nothing moved.
 * The real rate-limit protection is the 429 retry in http.js.
 */
const WRITE_DELAY_MS = 200;

/**
 * Sync every linked member, then strip any member holding the Scout role with no
 * link behind it. Returns one `{ discordUserId, ... }` per member touched.
 */
export async function syncAllUserRoles(guildId, { dryRun = false } = {}) {
  await storage.clearScoutNetCache();

  // Fetched once, up front, so a ScoutNet outage aborts the run before anything
  // is written. Each member below would otherwise fail individually — one
  // request per user against an API that just proved it is down, and a report of
  // N identical errors. The orphan strip needs no ScoutNet but is skipped along
  // with the rest; it runs on every refresh, so an outage delays it.
  if (config.SCOUTNET_EVENT_ID) await scoutnet.getParticipants();

  const linkedUsers = await storage.getAllLinkedUsers();
  const linkedSet = new Set(linkedUsers.map((u) => u.discordUserId));
  const results = [];

  // Guild state, fetched once for the whole run. Per user it meant refetching
  // the entire role list — 151 division roles and growing — for every one of
  // 2500 members. Reading it once is also more consistent: this run is the only
  // writer.
  const roleMap = roleMapOf(await discord.getGuildRoles(guildId));
  const memberMap = new Map();
  for (const m of await discord.getGuildMembers(guildId)) {
    memberMap.set(m.user.id, m);
  }

  for (const { discordUserId } of linkedUsers) {
    try {
      const result = await syncUserRoles(guildId, discordUserId, {
        roleMap,
        // Absent for a link whose user has left the guild. syncUserRoles then
        // fetches, gets a 404, and it lands in `results` as an error —
        // `/audit-scoutid` category 4 lists them.
        member: memberMap.get(discordUserId),
        dryRun,
      });
      results.push({ discordUserId, ...result });
      if (changedAnything(result)) await sleep(WRITE_DELAY_MS);
    } catch (e) {
      results.push({ discordUserId, error: e.message });
    }
  }

  try {
    const scoutRole = roleMap.get(config.SCOUTNET_SCOUT_ROLE.toLowerCase());
    if (scoutRole) {
      for (const member of memberMap.values()) {
        if (!member.roles.includes(scoutRole.id)) continue; // not verified
        if (linkedSet.has(member.user.id)) continue; // linked → already synced
        try {
          const result = await stripUnlinkedMember(
            guildId,
            member.user.id,
            roleMap,
            member,
            { dryRun },
          );
          if (changedAnything(result)) {
            results.push({ discordUserId: member.user.id, ...result });
            await sleep(WRITE_DELAY_MS);
          }
        } catch (e) {
          results.push({ discordUserId: member.user.id, error: e.message });
        }
      }
    }
  } catch (e) {
    console.error(`Error stripping unlinked members: ${e.message}`);
  }

  return results;
}

/**
 * Grant roles on the linking path; returns the names actually granted.
 *
 * Only ever *adds*: it runs before Discord has finished its half of the flow, so
 * it takes nothing away and cannot apply the verification gate. Managed roles are
 * skipped and reported as not granted — the absence of `scout` from the result is
 * the signal that Discord's half has not completed.
 */
export async function grantRoles(userId, roleNames) {
  const granted = [];
  const guildId = config.DISCORD_GUILD_ID;
  if (!guildId) return granted;

  try {
    const roleMap = roleMapOf(await discord.getGuildRoles(guildId));
    console.log(`Assigning roles [${roleNames.join(", ")}] to user ${userId}`);

    for (const roleName of roleNames) {
      const role = roleMap.get(roleName.toLowerCase());
      if (!role) {
        console.warn(
          `Role "${roleName}" not found in guild — create it in Discord`,
        );
      } else if (role.managed) {
        console.log(
          `Skipping managed role "${roleName}" — Discord grants it, not the bot`,
        );
      } else {
        try {
          await discord.addRoleToUser(guildId, userId, role.id);
          granted.push(roleName);
        } catch (e) {
          console.error(
            `Failed to add role "${roleName}" (${role.id}) to user ${userId}: ${e.message} (bot role may be too low in hierarchy)`,
          );
        }
      }
    }
  } catch (e) {
    console.error(`Error adding roles for ${userId}:`, e.message);
  }
  return granted;
}

/**
 * Set a nickname on the linking path. Swallows its own errors — a rename must not
 * turn a completed linking into a failure. With no configured guild it falls back
 * to every guild the user's own token can see.
 */
export async function setNickname(userId, nickname) {
  try {
    const nick = nickname.substring(0, NICK_MAX);
    const guildId = config.DISCORD_GUILD_ID;
    if (guildId) {
      await discord.updateGuildMemberNickname(guildId, userId, nick);
      return;
    }
    const tokens = await storage.getDiscordTokens(userId);
    if (!tokens) return;
    for (const guild of await discord.getUserGuilds(tokens)) {
      await discord.updateGuildMemberNickname(guild.id, userId, nick);
    }
  } catch (e) {
    console.error(`Error updating nickname for ${userId}:`, e.message);
  }
}
