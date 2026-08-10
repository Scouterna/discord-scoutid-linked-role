import config from "./config.js";
import * as scoutnet from "./scoutnet.js";
import * as discord from "./discord.js";
import * as storage from "./storage.js";

const UNVERIFIED_ROLE = "Overifierad";

/**
 * Role management: determines and syncs Discord roles based on ScoutNet data.
 *
 * Role assignment:
 *   1. Scout role   - always (linked ScoutID)
 *   2. Event role   - if registered in the event
 *   3. Fee role     - based on fee_id → category, with optional division pattern
 *
 * Division roles use per-category question IDs:
 *   deltagare uses q88168, ledare uses q107592, etc.
 *   Categories without a division config use the category name as the role.
 *
 * Nickname suffix:
 *   Appended to the user's real name, e.g. "Petter Sandholdt (CMT)".
 *   Configured via SCOUTNET_NICKNAME_SUFFIXES.
 */

/**
 * Get participant's fee category and division from ScoutNet.
 * Returns { category, division } or null if not in event.
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
 */
export async function getDesiredRoles(scoutnetMemberId) {
  const roles = [config.SCOUTNET_SCOUT_ROLE];

  try {
    const info = await getParticipantInfo(scoutnetMemberId);
    if (!info) return roles;

    roles.push(config.SCOUTNET_EVENT_ROLE);

    if (info.category) {
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
    console.error(
      `Error fetching ScoutNet data for member ${scoutnetMemberId}:`,
      e.message
    );
  }

  return roles;
}

/**
 * Get the nickname suffix for a user based on their ScoutNet data.
 * E.g. " (CMT)", " (AL12)", " (IST-05)", " (03)".
 * Returns empty string if no suffix applies.
 */
export async function getNicknameSuffix(scoutnetMemberId) {
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
    console.error(
      `Error getting nickname suffix for member ${scoutnetMemberId}:`,
      e.message
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
        Object.values(config.SCOUTNET_FEE_ROLES)
      )) {
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

/**
 * Sync one user's Discord roles to match their ScoutNet data.
 * Returns { added: string[], removed: string[] } or { error: string }.
 */
export async function syncUserRoles(guildId, discordUserId) {
  const scoutId = await storage.getLinkedScoutIDUserId(discordUserId);
  if (!scoutId) return { error: "Inte länkad till ScoutID" };

  // Fetch guild + member state once and reuse below
  const guildRoles = await discord.getGuildRoles(guildId);
  const roleMap = new Map();
  for (const role of guildRoles) {
    roleMap.set(role.name.toLowerCase(), role);
  }
  const member = await discord.getGuildMember(guildId, discordUserId);
  const currentRoleIds = new Set(member.roles);

  // Verification gate: Scout role missing → treat as unverified, strip access
  const scoutRole = roleMap.get(config.SCOUTNET_SCOUT_ROLE.toLowerCase());
  const isVerified = scoutRole && currentRoleIds.has(scoutRole.id);

  // Compute desired roles + suffix based on verification state
  let desiredRoles;
  let nicknameSuffix;
  if (isVerified) {
    desiredRoles = await getDesiredRoles(scoutId);
    nicknameSuffix = await getNicknameSuffix(scoutId);
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

  // Update nickname from ScoutNet name + suffix
  try {
    const currentNick = member.nick || member.user?.global_name || "";
    const participant = isVerified ? await scoutnet.getParticipant(scoutId) : null;
    const scoutNetName = participant
      ? [participant.first_name, participant.last_name]
          .filter(Boolean)
          .join(" ")
          .trim()
      : "";
    const baseName =
      scoutNetName || currentNick.replace(/\s*\(.*\)\s*$/, "");

    if (baseName) {
      const newNick = (baseName + nicknameSuffix).substring(0, 32);
      if (newNick !== currentNick) {
        await discord.updateGuildMemberNickname(guildId, discordUserId, newNick);
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
        await discord.addRoleToUser(guildId, discordUserId, role.id);
        added.push(roleName);
      } catch (e) {
        console.error(
          `Failed to add role "${roleName}" (${role.id}) to user ${discordUserId}: ${e.message}`
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
        await discord.removeRoleFromUser(guildId, discordUserId, role.id);
        removed.push(managedName);
      } catch (e) {
        console.error(
          `Failed to remove role "${managedName}" (${role.id}) from user ${discordUserId}: ${e.message}`
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
          await discord.removeRoleFromUser(guildId, discordUserId, role.id);
          removed.push(role.name);
        } catch (e) {
          console.error(
            `Failed to remove role "${role.name}" (${role.id}) from user ${discordUserId}: ${e.message}`
          );
        }
      }
    }
  }

  return { added, removed };
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
export async function stripUnlinkedMember(guildId, discordUserId, roleMap, member) {
  const managedRoles = getManagedRoleNames();
  const divPrefixes = getDivisionPrefixes();
  const currentRoleIds = new Set(member.roles);
  const added = [];
  const removed = [];

  // Remove every managed role except the unverified marker itself.
  for (const managedName of managedRoles) {
    if (managedName.toLowerCase() === UNVERIFIED_ROLE.toLowerCase()) continue;
    const role = roleMap.get(managedName.toLowerCase());
    if (role && !role.managed && currentRoleIds.has(role.id)) {
      try {
        await discord.removeRoleFromUser(guildId, discordUserId, role.id);
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
          await discord.removeRoleFromUser(guildId, discordUserId, role.id);
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
      await discord.addRoleToUser(guildId, discordUserId, unverifiedRole.id);
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
      await discord.updateGuildMemberNickname(
        guildId,
        discordUserId,
        baseName.substring(0, 32),
      );
    }
  } catch (e) {
    console.error(`Error resetting nickname for ${discordUserId}: ${e.message}`);
  }

  return { added, removed };
}

/**
 * Sync roles for all linked users, then strip access from any member who has
 * the Scout role but no storage link (orphans). Clears ScoutNet cache first.
 * Returns array of { discordUserId, added, removed, error }.
 */
export async function syncAllUserRoles(guildId) {
  await storage.clearScoutNetCache();

  const linkedUsers = await storage.getAllLinkedUsers();
  const linkedSet = new Set(linkedUsers.map((u) => u.discordUserId));
  const results = [];

  for (const { discordUserId } of linkedUsers) {
    try {
      const result = await syncUserRoles(guildId, discordUserId);
      results.push({ discordUserId, ...result });
    } catch (e) {
      results.push({ discordUserId, error: e.message });
    }
    // Small delay to avoid rate limits
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  // Strip orphans: members with the Scout role but no storage link.
  try {
    const guildRoles = await discord.getGuildRoles(guildId);
    const roleMap = new Map();
    for (const role of guildRoles) roleMap.set(role.name.toLowerCase(), role);
    const scoutRole = roleMap.get(config.SCOUTNET_SCOUT_ROLE.toLowerCase());

    if (scoutRole) {
      const members = await discord.getGuildMembers(guildId);
      for (const member of members) {
        if (!member.roles.includes(scoutRole.id)) continue; // not verified
        if (linkedSet.has(member.user.id)) continue; // linked → already synced
        try {
          const result = await stripUnlinkedMember(
            guildId,
            member.user.id,
            roleMap,
            member,
          );
          if (result.removed.length > 0 || result.added.length > 0) {
            results.push({ discordUserId: member.user.id, ...result });
          }
        } catch (e) {
          results.push({ discordUserId: member.user.id, error: e.message });
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  } catch (e) {
    console.error(`Error stripping unlinked members: ${e.message}`);
  }

  return results;
}
