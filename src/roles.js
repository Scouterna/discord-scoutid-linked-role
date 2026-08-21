import config from "./config.js";
import * as scoutnet from "./scoutnet.js";
import * as discord from "./discord.js";
import * as storage from "./storage.js";
import * as metadata from "./metadata.js";

const UNVERIFIED_ROLE = "Overifierad";

/**
 * Role management: determines and syncs Discord roles based on ScoutNet data.
 *
 * Role assignment:
 *   1. Scout role   - always (linked ScoutID)
 *   2. Event role   - if registered in the event
 *   3. Fee role     - based on fee_id → category, with optional division pattern
 *   4. Flat role    - optional per-category marker, alongside the division role
 *
 * Division roles use per-category question IDs:
 *   deltagare uses q88168, ledare uses q107592, etc.
 *   Categories without a division config use the category name as the role.
 *
 * Flat category roles (SCOUTNET_CATEGORY_ROLES) are additive: a leader in troop
 * 12 gets `Ledare-12` *and* `Ledare`. They exist so Discord AutoMod can address
 * a whole category — its exempt list holds 20 roles, and there are 151 division
 * roles. See the parser in config.js.
 *
 * Nickname suffix:
 *   Appended to the user's real name, e.g. "Petter Sandholdt (CMT)".
 *   Configured via SCOUTNET_NICKNAME_SUFFIXES.
 */

/**
 * Get participant's fee category and division from ScoutNet.
 *
 * Returns { category, division }, or null when the member is genuinely not a
 * live participant. Throws when ScoutNet could not be asked at all — the two
 * are different answers and callers must be able to tell them apart. See
 * getDesiredRoles.
 */
async function getParticipantInfo(scoutnetMemberId) {
  if (!config.SCOUTNET_EVENT_ID) return null;

  const participant = await scoutnet.getParticipant(scoutnetMemberId);
  if (!participant || participant.cancelled_date != null) return null;

  const category =
    config.SCOUTNET_FEE_ROLES && participant.fee_id
      ? config.SCOUTNET_FEE_ROLES[String(participant.fee_id)]
      : null;

  const divConfig = category
    ? config.SCOUTNET_DIVISION_ROLES?.[category]
    : null;
  const division = divConfig
    ? participant.questions?.[divConfig.questionId] || null
    : null;

  return { category, division };
}

/**
 * Determine which roles a user should have.
 *
 * **Throws when ScoutNet cannot be reached**, and that is load-bearing rather
 * than incidental. "Not registered in the event" and "could not ask whether
 * they are registered" both used to come back as `[scoutRole]`, and every
 * removal in `syncUserRoles` keys off exactly that difference: an answer with
 * no event role in it *means* take the event, category and division roles away.
 * So a ScoutNet outage during `/refresh-scoutid alla:true` disarmed every user
 * the run reached. Same mistake as a truncated member snapshot read as an
 * absent one — an unknown must not be allowed to look like a known negative.
 *
 * `allowIncomplete: true` opts back into the lenient answer, and is only for
 * callers that exclusively *add* roles. The linking flow is the one such
 * caller: there, failing means failing a verification that otherwise
 * succeeded, and the missing roles arrive with the next sync anyway.
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
      if (divConfig) {
        if (info.division) {
          const padded = String(info.division).padStart(2, "0");
          roles.push(divConfig.withDiv.replace("{div}", padded));
        } else {
          roles.push(divConfig.withoutDiv);
        }
      } else {
        roles.push(info.category);
      }
    }
  } catch (e) {
    if (!allowIncomplete) throw e;
    console.error(
      `Error fetching ScoutNet data for member ${scoutnetMemberId}:`,
      e.message,
    );
    // Discard anything gathered before the failure: a half-filled answer is
    // indistinguishable from a complete one to the caller.
    return [config.SCOUTNET_SCOUT_ROLE];
  }

  return roles;
}

/**
 * Get the nickname suffix for a user based on their ScoutNet data.
 * E.g. " (CMT)", " (AL12)", " (IST-05)", " (03)".
 * Returns empty string if no suffix applies.
 *
 * Throws on a ScoutNet failure, for the same reason as getDesiredRoles: an
 * empty suffix is a real instruction to rename someone, not a shrug. Same
 * `allowIncomplete` escape hatch, same single caller for it.
 */
export async function getNicknameSuffix(
  scoutnetMemberId,
  { allowIncomplete = false } = {},
) {
  if (!config.SCOUTNET_NICKNAME_SUFFIXES) return "";

  try {
    const info = await getParticipantInfo(scoutnetMemberId);
    if (!info?.category) return "";

    const suffixConfig = config.SCOUTNET_NICKNAME_SUFFIXES[info.category];
    if (!suffixConfig) return "";

    if (info.division && suffixConfig.withDiv) {
      const padded = String(info.division).padStart(2, "0");
      return ` (${suffixConfig.withDiv.replace("{div}", padded)})`;
    }

    if (suffixConfig.withoutDiv) {
      return ` (${suffixConfig.withoutDiv})`;
    }

    return "";
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
 * All statically known managed role names (for removal logic).
 * Division roles are handled separately via prefix matching.
 * UNVERIFIED_ROLE is always included so that it's added when needed and
 * removed when the user is verified.
 */
function getManagedRoleNames() {
  const roles = new Set();
  roles.add(UNVERIFIED_ROLE);
  roles.add(config.SCOUTNET_SCOUT_ROLE);
  if (config.SCOUTNET_EVENT_ID) {
    roles.add(config.SCOUTNET_EVENT_ROLE);
    if (config.SCOUTNET_FEE_ROLES) {
      for (const category of new Set(
        Object.values(config.SCOUTNET_FEE_ROLES),
      )) {
        // Managed, so it is taken away again when someone changes category —
        // an ex-leader must not keep `Ledare` and its AutoMod exemption.
        const flatRole = config.SCOUTNET_CATEGORY_ROLES?.[category];
        if (flatRole) roles.add(flatRole);

        const divConfig = config.SCOUTNET_DIVISION_ROLES?.[category];
        if (divConfig) {
          roles.add(divConfig.withoutDiv);
        } else {
          roles.add(category);
        }
      }
    }
  }
  return [...roles];
}

/**
 * Get prefixes for dynamic division roles, for pattern-based removal.
 * E.g. "Deltagare-{div}" → prefix "deltagare-"
 */
function getDivisionPrefixes() {
  if (!config.SCOUTNET_DIVISION_ROLES) return [];
  const prefixes = [];
  for (const { withDiv } of Object.values(config.SCOUTNET_DIVISION_ROLES)) {
    const idx = withDiv.indexOf("{div}");
    if (idx >= 0) prefixes.push(withDiv.substring(0, idx).toLowerCase());
  }
  return prefixes;
}

/** Every role in the guild, keyed by lowercased name. */
async function fetchRoleMap(guildId) {
  const guildRoles = await discord.getGuildRoles(guildId);
  const roleMap = new Map();
  for (const role of guildRoles) roleMap.set(role.name.toLowerCase(), role);
  return roleMap;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Courtesy pause after a user whose roles or nickname actually changed.
 *
 * It used to run after *every* user, which at 2500 linked people is eight
 * minutes of sleeping to report that nothing moved. Paying it only when writes
 * happened is safe because the real rate-limit protection is the 429 retry in
 * discord.js — this only spreads out a burst. A write that failed with 403 from
 * the role hierarchy is not counted, which is fine: that is not a rate limit,
 * and a retry would not help it either.
 */
const WRITE_DELAY_MS = 200;

const changedAnything = (result) =>
  (result?.added?.length ?? 0) > 0 ||
  (result?.removed?.length ?? 0) > 0 ||
  Boolean(result?.nickname);

/**
 * Sync one user's Discord roles to match their ScoutNet data.
 * Returns { added: string[], removed: string[], nickname } or { error: string }.
 *
 * `options.roleMap` and `options.member` let a caller that already holds guild
 * state avoid refetching it — see the comment inside.
 *
 * `options.dryRun` computes everything and calls nothing, so the return value
 * describes what *would* change. It is a parameter and deliberately not a module
 * flag: the server handles requests concurrently, so a process-global dry run
 * would also silence a real linking that happened to run at the same moment.
 * Same lesson the member scan's dry run already learned. One thing a dry run
 * cannot predict is a 403 from the role hierarchy, so it reports what it would
 * attempt, not what would succeed.
 */
export async function syncUserRoles(guildId, discordUserId, options = {}) {
  const { dryRun = false } = options;
  const scoutId = await storage.getLinkedScoutIDUserId(discordUserId);
  if (!scoutId) return { error: "Inte länkad till ScoutID" };

  // Guild roles and the member object are passed in by callers that already
  // hold them, and that is not a micro-optimisation: fetching them here meant
  // the entire role list — 151 division roles and growing — was refetched once
  // per linked user, so a nightly sync over 2500 people spent 5000 requests
  // discovering that nothing had changed.
  const roleMap = options.roleMap ?? (await fetchRoleMap(guildId));
  const member =
    options.member ?? (await discord.getGuildMember(guildId, discordUserId));
  const currentRoleIds = new Set(member.roles);

  // Verification gate — two independent proofs, either of which is enough.
  //
  // The role is Discord's answer: a connection-gated role it grants through its
  // own Link flow and revokes when the user disconnects the app. Strongest, and
  // not something the bot can forge.
  //
  // The OAuth grant is the same fact seen from the other side: if Discord still
  // answers for this user's token, the app is still authorised. It exists as a
  // second proof because the first one **cannot be backfilled** — Discord grants
  // a connection role only when the user clicks Link, so rebuilding the role
  // would otherwise have required all 18 members to re-verify by hand.
  //
  // OR rather than AND, deliberately. During the migration most members have a
  // live grant and no role yet; AND would have stripped every one of them. In
  // steady state the two agree, and either alone is genuine evidence.
  //
  // The role is checked first because it costs nothing — the member object is
  // already in hand — so the network probe only runs for people who lack it.
  const scoutRole = roleMap.get(config.SCOUTNET_SCOUT_ROLE.toLowerCase());
  let isVerified = Boolean(scoutRole && currentRoleIds.has(scoutRole.id));

  if (!isVerified) {
    const connection = await metadata.verifyConnection(discordUserId);
    if (connection.status === "accepted") {
      isVerified = true;
    } else if (connection.status === "unknown") {
      // Never act on "could not ask". A Discord outage would otherwise strip
      // everyone at once, which is the same failure a swallowed ScoutNet error
      // used to cause one user at a time.
      return {
        error: `Kunde inte avgöra verifiering, inget ändrades: ${connection.detail}`,
      };
    }
  }

  // Compute desired roles + suffix based on verification state.
  //
  // Note what the gate above did *not* need: ScoutNet. Stripping someone who
  // lost the Scout role is the security boundary, so it has to keep working
  // while ScoutNet is down. Everything below genuinely needs ScoutNet, and
  // cannot be guessed — so bail out here, before the first write, rather than
  // remove roles we merely failed to confirm.
  let desiredRoles;
  let nicknameSuffix;
  if (isVerified) {
    try {
      desiredRoles = await getDesiredRoles(scoutId);
      nicknameSuffix = await getNicknameSuffix(scoutId);
    } catch (e) {
      return {
        error: `Kunde inte hämta ScoutNet-data, inget ändrades: ${e.message}`,
      };
    }
  } else {
    console.log(
      `User ${discordUserId} is linked (scoutid=${scoutId}) but lacks Scout role — stripping access`,
    );
    desiredRoles = [UNVERIFIED_ROLE];
    nicknameSuffix = "";
  }
  const managedRoles = getManagedRoleNames();
  const divPrefixes = getDivisionPrefixes();
  const desiredSet = new Set(desiredRoles.map((r) => r.toLowerCase()));

  // Update nickname from ScoutNet name + suffix.
  // `nicknameSet` is returned so callers can log it: the rename is the change
  // users notice first, and until now it was visible only in the pod log.
  let nicknameSet = null;
  try {
    const currentNick = member.nick || member.user?.global_name || "";
    const participant = isVerified
      ? await scoutnet.getParticipant(scoutId)
      : null;
    const scoutNetName = participant
      ? [participant.first_name, participant.last_name]
          .filter(Boolean)
          .join(" ")
          .trim()
      : "";
    const baseName = scoutNetName || currentNick.replace(/\s*\(.*\)\s*$/, "");

    if (baseName) {
      const newNick = (baseName + nicknameSuffix).substring(0, 32);
      if (newNick !== currentNick) {
        if (!dryRun) {
          await discord.updateGuildMemberNickname(
            guildId,
            discordUserId,
            newNick,
          );
        }
        nicknameSet = newNick;
      }
    }
  } catch (e) {
    console.error(`Error updating nickname for ${discordUserId}:`, e.message);
  }

  const added = [];
  const removed = [];

  // Add roles the user should have
  for (const roleName of desiredRoles) {
    const role = roleMap.get(roleName.toLowerCase());
    if (role && !role.managed && !currentRoleIds.has(role.id)) {
      try {
        if (!dryRun) {
          await discord.addRoleToUser(guildId, discordUserId, role.id);
        }
        added.push(roleName);
      } catch (e) {
        console.error(
          `Failed to add role "${roleName}" (${role.id}) to user ${discordUserId}: ${e.message}`,
        );
      }
    }
  }

  // Remove static managed roles the user should no longer have
  for (const managedName of managedRoles) {
    const role = roleMap.get(managedName.toLowerCase());
    if (
      role &&
      !role.managed &&
      currentRoleIds.has(role.id) &&
      !desiredSet.has(managedName.toLowerCase())
    ) {
      try {
        if (!dryRun) {
          await discord.removeRoleFromUser(guildId, discordUserId, role.id);
        }
        removed.push(managedName);
      } catch (e) {
        console.error(
          `Failed to remove role "${managedName}" (${role.id}) from user ${discordUserId}: ${e.message}`,
        );
      }
    }
  }

  // Remove old division roles (prefix-matched) that don't match current
  for (const prefix of divPrefixes) {
    for (const [name, role] of roleMap) {
      if (
        name.startsWith(prefix) &&
        currentRoleIds.has(role.id) &&
        !desiredSet.has(name)
      ) {
        try {
          if (!dryRun) {
            await discord.removeRoleFromUser(guildId, discordUserId, role.id);
          }
          removed.push(role.name);
        } catch (e) {
          console.error(
            `Failed to remove role "${role.name}" (${role.id}) from user ${discordUserId}: ${e.message}`,
          );
        }
      }
    }
  }

  return { added, removed, nickname: nicknameSet };
}

/**
 * Strip a member who has the Scout role but no storage link.
 *
 * The Scout role is a managed Discord Linked Role we cannot remove, but a
 * member with no ScoutID mapping (e.g. after a storage loss) must not keep any
 * access. Removes every bot-managed role (event, fee, division) and adds
 * `Overifierad`, forcing the user to re-link before they regain access.
 *
 * Caller passes the shared `roleMap` and the member object to avoid refetching.
 * Returns { added, removed }.
 */
export async function stripUnlinkedMember(
  guildId,
  discordUserId,
  roleMap,
  member,
  { dryRun = false } = {},
) {
  const managedRoles = getManagedRoleNames();
  const divPrefixes = getDivisionPrefixes();
  const currentRoleIds = new Set(member.roles);
  const added = [];
  const removed = [];
  let nicknameSet = null;

  // Remove every managed role except the unverified marker itself.
  for (const managedName of managedRoles) {
    if (managedName.toLowerCase() === UNVERIFIED_ROLE.toLowerCase()) continue;
    const role = roleMap.get(managedName.toLowerCase());
    if (role && !role.managed && currentRoleIds.has(role.id)) {
      try {
        if (!dryRun) {
          await discord.removeRoleFromUser(guildId, discordUserId, role.id);
        }
        removed.push(managedName);
      } catch (e) {
        console.error(
          `Failed to remove role "${managedName}" (${role.id}) from unlinked ${discordUserId}: ${e.message}`,
        );
      }
    }
  }

  // Remove dynamic division roles by prefix.
  for (const prefix of divPrefixes) {
    for (const [name, role] of roleMap) {
      if (name.startsWith(prefix) && currentRoleIds.has(role.id)) {
        try {
          if (!dryRun) {
            await discord.removeRoleFromUser(guildId, discordUserId, role.id);
          }
          removed.push(role.name);
        } catch (e) {
          console.error(
            `Failed to remove role "${role.name}" (${role.id}) from unlinked ${discordUserId}: ${e.message}`,
          );
        }
      }
    }
  }

  // Add the Overifierad marker.
  const unverifiedRole = roleMap.get(UNVERIFIED_ROLE.toLowerCase());
  if (
    unverifiedRole &&
    !unverifiedRole.managed &&
    !currentRoleIds.has(unverifiedRole.id)
  ) {
    try {
      if (!dryRun) {
        await discord.addRoleToUser(guildId, discordUserId, unverifiedRole.id);
      }
      added.push(UNVERIFIED_ROLE);
    } catch (e) {
      console.error(
        `Failed to add ${UNVERIFIED_ROLE} to unlinked ${discordUserId}: ${e.message}`,
      );
    }
  }

  // Strip any "(suffix)" from the nickname — we no longer know their category.
  try {
    const currentNick = member.nick || member.user?.global_name || "";
    const baseName = currentNick.replace(/\s*\(.*\)\s*$/, "");
    if (baseName && baseName !== currentNick) {
      if (!dryRun) {
        await discord.updateGuildMemberNickname(
          guildId,
          discordUserId,
          baseName.substring(0, 32),
        );
      }
      nicknameSet = baseName.substring(0, 32);
    }
  } catch (e) {
    console.error(
      `Error resetting nickname for ${discordUserId}: ${e.message}`,
    );
  }

  return { added, removed, nickname: nicknameSet };
}

/**
 * Sync roles for all linked users, then strip access from any member who has
 * the Scout role but no storage link (orphans). Clears ScoutNet cache first.
 * Returns array of { discordUserId, added, removed, nickname, error }.
 *
 * `options.dryRun` reports what would change without writing anything — see
 * syncUserRoles for why it is a parameter and not a module flag.
 */
export async function syncAllUserRoles(guildId, { dryRun = false } = {}) {
  await storage.clearScoutNetCache();

  // Fetch the participant list once, up front, and let a failure abort the run
  // before anything is written. Each user below would otherwise fail
  // individually and harmlessly — but that is one request per user at an API
  // that just proved it is down, and a report of N identical errors. Failing
  // once says the same thing usefully.
  //
  // The orphan strip at the end needs no ScoutNet and is skipped along with the
  // rest. It runs on every refresh, so an outage delays it rather than dropping
  // it, and the members it would strip are already stripped of their link.
  if (config.SCOUTNET_EVENT_ID) await scoutnet.getParticipants();

  const linkedUsers = await storage.getAllLinkedUsers();
  const linkedSet = new Set(linkedUsers.map((u) => u.discordUserId));
  const results = [];

  // Guild state, fetched once for the whole run rather than per user. The
  // member list was already needed for the orphan strip below; hoisting it here
  // means the sync loop needs no requests at all for a user with nothing to
  // change, which is what makes this cheap enough to run on a schedule.
  //
  // It is a snapshot, and that is fine: this run is the only writer, so reading
  // it once is if anything more consistent than refetching per user.
  const roleMap = await fetchRoleMap(guildId);
  const memberMap = new Map();
  for (const m of await discord.getGuildMembers(guildId)) {
    memberMap.set(m.user.id, m);
  }

  for (const { discordUserId } of linkedUsers) {
    try {
      const result = await syncUserRoles(guildId, discordUserId, {
        roleMap,
        // Absent for a link whose user has left the guild. syncUserRoles then
        // fetches and gets a 404, which lands in `results` as an error — the
        // same report as before, and `/audit-scoutid` category 4 lists them.
        member: memberMap.get(discordUserId),
        dryRun,
      });
      results.push({ discordUserId, ...result });
      if (changedAnything(result)) await sleep(WRITE_DELAY_MS);
    } catch (e) {
      results.push({ discordUserId, error: e.message });
    }
  }

  // Strip orphans: members with the Scout role but no storage link.
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
