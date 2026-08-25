import config from "./config.js";

/**
 * Everything the role sync, the audit and the adoption report need to derive
 * from the config: which role names the bot owns, how a division number becomes
 * a role name, and how a member is addressed in a report.
 *
 * One home for these keeps the sync and the audit answering the same question
 * the same way — they compare their results against each other.
 */

/** Set on a member who has no valid proof of verification. */
export const UNVERIFIED_ROLE = "Overifierad";

/** Discord's hard limit on a nickname. */
export const NICK_MAX = 32;

/** Every role in the guild, keyed by lowercased name. Lookups are case-insensitive. */
export function roleMapOf(guildRoles) {
  const map = new Map();
  for (const role of guildRoles) map.set(role.name.toLowerCase(), role);
  return map;
}

/** What to call a member in a report. */
export const displayName = (member) =>
  member?.nick || member?.user?.global_name || member?.user?.username || "";

/** The name the bot renames *from* — no username fallback, that is not a nickname. */
export const guildNick = (member) =>
  member?.nick || member?.user?.global_name || "";

/** Drop a trailing "(AL12)" so a fresh suffix can be appended. */
export const stripNickSuffix = (name) =>
  (name || "").replace(/\s*\(.*\)\s*$/, "");

/** Division numbers are zero-padded to two digits, or the role names would not match. */
export const padDiv = (division) => String(division).padStart(2, "0");

/** Fill `{div}` in a configured pattern — "Deltagare-{div}", "AL{div}". */
export const withDivision = (pattern, division) =>
  pattern.replace("{div}", padDiv(division));

/** The division role for an answer, or the pending role when there is no answer. */
export const divisionRoleName = (divConfig, division) =>
  division ? withDivision(divConfig.withDiv, division) : divConfig.withoutDiv;

/**
 * Static role names the bot hands out and takes away, excluding the per-division
 * ones (those are matched by prefix instead — see `divisionPrefixes`).
 *
 * `includeUnverified` is what separates the sync's view from the audit's: the
 * sync manages `Overifierad` and so must be able to remove it again, while the
 * audit would report it as a missing configured role in a guild that has none.
 */
export function managedRoleNames({ includeUnverified = false } = {}) {
  const names = new Set();
  if (includeUnverified) names.add(UNVERIFIED_ROLE);
  names.add(config.SCOUTNET_SCOUT_ROLE);

  if (config.SCOUTNET_EVENT_ID) {
    names.add(config.SCOUTNET_EVENT_ROLE);
    for (const category of new Set(
      Object.values(config.SCOUTNET_FEE_ROLES ?? {}),
    )) {
      // The flat marker is managed too, so an ex-leader does not keep `Ledare`
      // and the AutoMod exemption that comes with it.
      const flatRole = config.SCOUTNET_CATEGORY_ROLES?.[category];
      if (flatRole) names.add(flatRole);

      const divConfig = config.SCOUTNET_DIVISION_ROLES?.[category];
      names.add(divConfig ? divConfig.withoutDiv : category);
    }
  }
  return [...names];
}

/**
 * `[{ category, prefix }]` for pattern-based removal of division roles:
 * "Deltagare-{div}" yields the prefix "deltagare-".
 */
export function divisionPrefixes() {
  const prefixes = [];
  for (const [category, { withDiv }] of Object.entries(
    config.SCOUTNET_DIVISION_ROLES ?? {},
  )) {
    const idx = withDiv.indexOf("{div}");
    if (idx >= 0) {
      prefixes.push({
        category,
        prefix: withDiv.substring(0, idx).toLowerCase(),
      });
    }
  }
  return prefixes;
}

/** Did a sync result actually move anything? A rename counts — users notice it first. */
export const changedAnything = (result) =>
  (result?.added?.length ?? 0) > 0 ||
  (result?.removed?.length ?? 0) > 0 ||
  Boolean(result?.nickname);

/** Split sync results into the ones worth reporting and the ones that failed. */
export function partitionResults(results) {
  return {
    errors: results.filter((r) => r.error),
    changed: results.filter((r) => !r.error && changedAnything(r)),
  };
}
