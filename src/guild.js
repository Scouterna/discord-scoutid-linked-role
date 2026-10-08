import config, { normalizeDivision } from "./config.js";

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

/**
 * How a member is named in a report, for a Discord message.
 *
 * **Never a mention.** `<@id>` renders as @okänd-användare for any client that
 * has not cached the member — in a guild this size, most of them, most of the
 * time — because silencing mentions (`allowed_mentions: { parse: [] }`) also
 * leaves the user objects out of the posted message, so the client has only the
 * bare id. The mention costs the line its name and gives nothing back.
 *
 * A missing name falls back to the raw id in code style rather than a
 * placeholder: it can be pasted into `/status-scoutid personid:`, which is
 * exactly what an admin wants from a line about someone they cannot identify.
 */
export const reportName = (id, name) => (name ? `**${name}**` : `\`${id}\``);

/**
 * The same for an attachment. No markup — Discord renders nothing inside a
 * file, so a backtick arrives as a backtick — and the id is kept beside the
 * name, because the file is the long list an admin reads through and the place
 * they go looking for an id to paste.
 */
export const reportNamePlain = (id, name) => (name ? `${name} (${id})` : id);

/** The name the bot renames *from* — no username fallback, that is not a nickname. */
export const guildNick = (member) =>
  member?.nick || member?.user?.global_name || "";

/** Drop a trailing "(AL12)" so a fresh suffix can be appended. */
export const stripNickSuffix = (name) =>
  (name || "").replace(/\s*\(.*\)\s*$/, "");

/** A division value as roles and lookups use it — see `normalizeDivision`. */
export const padDiv = normalizeDivision;

/**
 * A division's name from `SCOUTNET_DIVISION_NAMES`: the category's own row
 * (`ledare/12`) first, then the shared one (`12`), else `null`.
 */
export function divisionName(
  category,
  division,
  names = config.SCOUTNET_DIVISION_NAMES,
) {
  const div = padDiv(division);
  return names?.[`${category}/${div}`] ?? names?.[div] ?? null;
}

/**
 * Fill `{div}` and `{divnamn}` in a configured pattern — "Deltagare-{div}",
 * "AL{div}-{divnamn}", "Patrull-{divnamn}".
 *
 * A division with no name drops the placeholder *and* the separator in front of
 * it, so "AL{div}-{divnamn}" degrades to "AL12" rather than leaving a dangling
 * dash or printing "{divnamn}" at people — **unless the pattern has no `{div}`**.
 * Then the name is all that tells one group from another, and dropping it would
 * give every group the same role; the value itself stands in instead.
 */
export const withDivision = (pattern, division, category) => {
  const div = padDiv(division);
  const name = divisionName(category, div);
  const named = name
    ? pattern.replace("{divnamn}", name)
    : pattern.includes("{div}")
      ? pattern.replace(/[\s-]*\{divnamn\}/, "")
      : pattern.replace("{divnamn}", div);
  return named.replace("{div}", div);
};

/**
 * A word reduced to its initial — unless it is three characters or fewer, which
 * is left whole. Shortening "af", "van", "der", "Gao" or "Dos" buys one or two
 * characters and spends a whole element of someone's name to do it. Among the
 * event's people that is nine names, and in one of them "Gao" is the surname
 * entire.
 */
const shortenWord = (word) => ([...word].length > 3 ? [...word][0] : word);

/**
 * The ways to shorten a name, longest first: the last word to an initial, then
 * the one before it, and so on. The first word is never abbreviated — a person
 * shortening their own name gives up the surname, not the name they are called.
 *
 * Forms that shorten nothing are dropped, so a name built of short words yields
 * fewer steps than it has words rather than the same string several times over.
 *
 * Shared with the audit so the two agree on what the sync's own work looks like.
 */
export function abbreviatedNames(base) {
  const words = (base || "").trim().split(/\s+/).filter(Boolean);
  const full = words.join(" ");
  const forms = [];
  for (let keep = words.length - 1; keep >= 1; keep--) {
    const form = [
      ...words.slice(0, keep),
      ...words.slice(keep).map(shortenWord),
    ].join(" ");
    if (form !== full && !forms.includes(form)) forms.push(form);
  }
  return forms;
}

/**
 * `base` and `suffix` joined inside Discord's 32 characters.
 *
 * **The suffix never gives way.** It carries the division, which is the one part
 * of the nickname a reader cannot look up anywhere else, and a clipped suffix is
 * worse than no suffix: `stripNickSuffix` needs the closing paren to find it
 * again, so a truncated one can never be replaced. Someone who changed troop
 * would keep the old number forever while every later sync compared the mangled
 * string against itself and reported no change.
 *
 * The name gives way instead, the way a person gives it way: the surname to an
 * initial, then the name before it, and only when nothing else is left does the
 * remainder get cut.
 */
export function fitNickname(base, suffix = "") {
  const full = (base || "").trim();
  if (!full) return "";

  const budget = NICK_MAX - suffix.length;
  if (full.length <= budget) return full + suffix;

  for (const form of abbreviatedNames(full)) {
    if (form.length <= budget) return form + suffix;
  }
  return (full.slice(0, Math.max(budget, 0)).trim() + suffix).slice(
    0,
    NICK_MAX,
  );
}

/** The division role for an answer, or the pending role when there is no answer. */
export const divisionRoleName = (divConfig, division, category) =>
  division
    ? withDivision(divConfig.withDiv, division, category)
    : divConfig.withoutDiv;

/**
 * Static role names the bot hands out and takes away, excluding the per-division
 * ones (those are matched by pattern instead — see `divisionPatterns`).
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
      // The flat marker is managed too, so an ex-leader does not keep
      // `Avdelningsledare` and the AutoMod exemption that comes with it.
      for (const flatRole of config.SCOUTNET_CATEGORY_ROLES?.[category] ?? []) {
        names.add(flatRole);
      }

      const divConfig = config.SCOUTNET_DIVISION_ROLES?.[category];
      names.add(divConfig ? divConfig.withoutDiv : category);
    }
  }
  return [...names];
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A division role pattern as a matcher for the roles it can produce:
 * "Deltagare-{div}" matches `Deltagare-07` and `Deltagare-Väntande`, and nothing
 * else — not `Deltagare` and not `Deltagarstöd`. Anchored at both ends and
 * case-insensitive, like every other role lookup here.
 *
 * `null` for a pattern with no fixed letter or digit in it. "{div}" alone would
 * match every role in the guild, and the sync would take away everything the
 * member holds that it did not ask for — moderator roles included, wherever the
 * bot ranks above them. Such a pattern still *grants* its roles; it just never
 * removes one, and the caller says so.
 */
export function divisionPattern(withDiv) {
  const literal = withDiv.replace(/\{divnamn\}|\{div\}/g, "");
  if (!/[\p{L}\p{N}]/u.test(literal)) return null;
  const hasDiv = withDiv.includes("{div}");
  const source = withDiv
    .split(/([\s-]*\{divnamn\}|\{div\})/)
    .map((part) => {
      if (part === "{div}") return ".+";
      const named = part.match(/^([\s-]*)\{divnamn\}$/);
      if (named)
        return hasDiv
          ? `(?:${escapeRegExp(named[1])}.+)?`
          : `${escapeRegExp(named[1])}.+`;
      return escapeRegExp(part);
    })
    .join("");
  return new RegExp(`^${source}$`, "iu");
}

const warnedPatterns = new Set();

/**
 * `[{ category, pattern }]` for removing stale division roles — the roles a
 * category's pattern produces that the member is no longer meant to have.
 *
 * One entry per pattern: two categories may share one (e.g. both use
 * `Patrull-{div}`), and a second entry would make the sync remove each stale
 * role twice.
 */
export function divisionPatterns(
  divisionRoles = config.SCOUTNET_DIVISION_ROLES,
) {
  const patterns = [];
  for (const [category, { withDiv }] of Object.entries(divisionRoles ?? {})) {
    const pattern = divisionPattern(withDiv);
    if (!pattern) {
      if (!warnedPatterns.has(withDiv)) {
        warnedPatterns.add(withDiv);
        console.warn(
          `Division pattern "${withDiv}" (${category}) has no fixed text, so stale roles from it are never removed`,
        );
      }
      continue;
    }
    if (!patterns.some((p) => p.pattern.source === pattern.source)) {
      patterns.push({ category, pattern });
    }
  }
  return patterns;
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
