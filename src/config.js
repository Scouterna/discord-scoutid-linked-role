import * as dotenv from "dotenv";

dotenv.config();

// The parsers are exported alongside the assembled config so they can be tested
// directly: they are pure string-to-object functions, and driving them through
// repeated re-imports of this module makes dotenv print its banner to stdout once
// per case, which corrupts the test runner's own output stream.
//
// Every parser returns null for an empty or unusable value, so a caller can tell
// "not configured" from "configured as nothing".

/**
 * `"feeId:category,feeId:category"` → `{ feeId: category }`.
 * Example: `"1001:deltagare,1003:funktionar"`.
 */
export function parseFeeRoles(str) {
  if (!str) return null;
  const map = {};
  for (const pair of str.split(",")) {
    const [feeId, role] = pair.split(":").map((s) => s.trim());
    if (feeId && role) map[feeId] = role;
  }
  return Object.keys(map).length > 0 ? map : null;
}

/**
 * A division value in the form roles and lookups use. A numeric answer is
 * zero-padded to two digits, so `"7"` and `"07"` name the same role; anything
 * else is a label — a patrol name, an option text — and is kept as given, since
 * padding `"A"` to `"0A"` would name a role nobody created.
 */
export function normalizeDivision(value) {
  const s = String(value ?? "").trim();
  return /^\d+$/.test(s) ? s.padStart(2, "0") : s;
}

/**
 * The slash-command option that names a division, derived from the label so a
 * deployment that says "patrull" gets `patrull:`. Discord accepts lowercase
 * letters, digits, `-` and `_`, at most 32; anything else falls back to
 * `avdelning` rather than failing registration.
 */
export function divisionOptionName(label) {
  const name = String(label ?? "")
    .trim()
    .toLowerCase();
  return /^[-_\p{L}\p{N}]{1,32}$/u.test(name) ? name : "avdelning";
}

/** The scope that sees everything, as an admin does. */
export const ALL_SCOPE = "*";

/**
 * What a category's division is called — `SCOUTNET_DIVISION_LABELS` for that
 * category, else `SCOUTNET_DIVISION_LABEL`. A troop is an `avdelning` and an
 * IST patrol an `ist-patrull`, and each label is its own slash-command option.
 */
export function divisionLabel(category, cfg = config) {
  return (
    cfg.SCOUTNET_DIVISION_LABELS?.[category]?.[0] ??
    cfg.SCOUTNET_DIVISION_LABEL ??
    "avdelning"
  );
}

/**
 * The distinct category sets `SCOUTNET_ADOPTION_SCOPE` names — each one a view:
 * `ledare:deltagare+ledare,ist-a:ist-a+ist-b,ist-b:ist-a+ist-b` gives two,
 * troops and IST patrols. Order follows the config.
 */
export function scopeGroups(cfg = config) {
  const seen = new Map();
  for (const cats of Object.values(cfg.SCOUTNET_ADOPTION_SCOPE ?? {})) {
    if (cats.includes(ALL_SCOPE)) continue;
    const key = [...cats].sort().join("+");
    if (!seen.has(key)) seen.set(key, cats);
  }
  return [...seen.values()];
}

/**
 * The scope groups by what their division is called, one per slash-command
 * option: `{ label, option, groups }`. A group is labelled by its first
 * category. **Kinds never mix** — troops and patrols are both numbered from
 * 01, and one option over both made `avdelning:07` a report of two unrelated
 * groups of people, and let a troop leader read a patrol. With no scope there
 * is still one kind, so the command keeps its option.
 */
export function divisionKinds(cfg = config) {
  const kinds = new Map();
  for (const categories of scopeGroups(cfg)) {
    const label = divisionLabel(categories[0], cfg);
    const option = divisionOptionName(label);
    if (!kinds.has(option)) kinds.set(option, { label, option, groups: [] });
    kinds.get(option).groups.push(categories);
  }
  if (kinds.size === 0) {
    const label = cfg.SCOUTNET_DIVISION_LABEL ?? "avdelning";
    return [{ label, option: divisionOptionName(label), groups: [] }];
  }
  return [...kinds.values()];
}

/**
 * `"category:withDiv:withoutDiv,..."` → `{ category: { withDiv, withoutDiv } }`.
 * Example: `"deltagare:{div}:,ledare:AL{div}:AL,funktionar::F"`.
 *
 * `{div}` is replaced with the zero-padded division number; an empty half means
 * no suffix in that case.
 */
export function parseNicknameSuffixes(str) {
  if (!str) return null;
  const map = {};
  for (const entry of str.split(",")) {
    const parts = entry.split(":").map((s) => s.trim());
    if (parts.length === 3) {
      map[parts[0]] = { withDiv: parts[1], withoutDiv: parts[2] };
    }
  }
  return Object.keys(map).length > 0 ? map : null;
}

/**
 * `"01:Björnen,02:Bävern,ledare/12:Musen,..."` →
 * `{ "01": "Björnen", "02": "Bävern", "ledare/12": "Musen" }`.
 *
 * What `{divnamn}` resolves to, in a nickname suffix or a role pattern. Values
 * go through `normalizeDivision`, so `"1:Björnen"` and `"01:Björnen"` are the
 * same row. A `category/value` key names the value for that category only and
 * wins over a bare one — which is what lets two categories read the same
 * question for different things, and what turns an opaque option id from a
 * multiple-choice question into a name.
 *
 * **This is usually a second copy.** Whatever owns the Discord server — in
 * practice an infrastructure repo — names the divisions too, for channel
 * topics; a division renamed there has to be renamed here. Nothing detects
 * the drift: the suffix would simply keep the old name.
 *
 *  * A bare key holds only as long as one value means one thing across the
 * categories that share it; where it does not, give each category its own row.
 */
export function parseDivisionNames(str) {
  if (!str) return null;
  const map = {};
  for (const entry of str.split(",")) {
    const [key, name] = entry.split(":").map((s) => s.trim());
    if (!key || !name) continue;
    const slash = key.indexOf("/");
    const normalized =
      slash >= 0
        ? `${key.slice(0, slash).trim()}/${normalizeDivision(key.slice(slash + 1))}`
        : normalizeDivision(key);
    const [category, value] =
      slash >= 0 ? normalized.split("/") : [null, normalized];
    if (value && category !== "") map[normalized] = name;
  }
  return Object.keys(map).length > 0 ? map : null;
}

/**
 * `"category:questionId:withDiv:withoutDiv,..."` →
 * `{ category: { questionId, withDiv, withoutDiv } }`.
 * Example: `"deltagare:5001:Deltagare-{div}:Deltagare-Väntande"`.
 *
 * Each category reads its own ScoutNet question for the division number.
 */
export function parseDivisionRoles(str) {
  if (!str) return null;
  const map = {};
  for (const entry of str.split(",")) {
    const parts = entry.split(":").map((s) => s.trim());
    if (parts.length === 4) {
      map[parts[0]] = {
        questionId: parts[1],
        withDiv: parts[2],
        withoutDiv: parts[3],
      };
    }
  }
  return Object.keys(map).length > 0 ? map : null;
}

/**
 * `"category:roleName+roleName,..."` → `{ category: [roleName, ...] }`.
 *
 * Granted *in addition to* the category's division role, so a leader in troop 12
 * ends up with both `Ledare-12` and `Avdelningsledare`. A category with no
 * division config already gets a flat role named after itself (`funktionar`)
 * and needs no entry.
 *
 * `+` gives a category several, e.g. a category split into sub-groups can carry
 * both a shared `Grupp` role and a sub-group's own `Grupp-A`.
 *
 * This exists for Discord AutoMod, which can only *exempt* roles and never
 * target them, with a hard cap of 20 exempt roles: "everyone except
 * participants" would otherwise need one exempt role per division.
 */
export function parseCategoryRoles(str) {
  if (!str) return null;
  const map = {};
  for (const entry of str.split(",")) {
    const [category, roles] = entry.split(":").map((s) => s.trim());
    const names = (roles ?? "")
      .split("+")
      .map((s) => s.trim())
      .filter(Boolean);
    if (category && names.length > 0) map[category] = names;
  }
  return Object.keys(map).length > 0 ? map : null;
}

/**
 * The member-event switch: a comma-separated list of `join`, `leave`, `nickname`
 * and `roles`. Empty, `"off"` or `"none"` disables the scheduled scan entirely.
 *
 * `roles` is off by default because it needs a permission the others do not —
 * **View Audit Log** on the bot's role, since only the audit log knows who made
 * a change. Without it the scan warns and skips the category.
 */
export function parseMemberEvents(str) {
  const raw = (str ?? "join,leave,nickname").trim().toLowerCase();
  if (raw === "" || raw === "off" || raw === "none") return new Set();
  const known = ["join", "leave", "nickname", "roles"];
  const wanted = new Set();
  for (const name of raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    if (known.includes(name)) wanted.add(name);
    else console.warn(`Unknown LOG_MEMBER_EVENTS value "${name}", ignoring`);
  }
  return wanted;
}

const config = {
  // Discord
  DISCORD_TOKEN: process.env.DISCORD_TOKEN,
  DISCORD_CLIENT_ID: process.env.DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET: process.env.DISCORD_CLIENT_SECRET,
  DISCORD_PUBLIC_KEY: process.env.DISCORD_PUBLIC_KEY,
  DISCORD_REDIRECT_URI: process.env.DISCORD_REDIRECT_URI,
  DISCORD_VALIDATION_URL: process.env.DISCORD_VALIDATION_URL,
  DISCORD_GUILD_ID: process.env.DISCORD_GUILD_ID,

  // Channel the verification event log is written to. Unset means the log is
  // off, and everything else behaves identically — see src/eventlog.js.
  LOG_CHANNEL_ID: process.env.LOG_CHANNEL_ID,

  // Which member events the scheduled scan reports. Empty Set = no scan.
  LOG_MEMBER_EVENTS: parseMemberEvents(process.env.LOG_MEMBER_EVENTS),

  // ScoutID (OIDC)
  SCOUTID_CLIENT_ID: process.env.SCOUTID_CLIENT_ID,
  SCOUTID_CLIENT_SECRET: process.env.SCOUTID_CLIENT_SECRET,
  SCOUTID_REDIRECT_URI: process.env.SCOUTID_REDIRECT_URI,
  SCOUTID_SCOPES: process.env.SCOUTID_SCOPES,

  // ScoutNet
  SCOUTNET_EVENT_ID: process.env.SCOUTNET_EVENT_ID,
  SCOUTNET_PARTICIPANTS_APIKEY: process.env.SCOUTNET_PARTICIPANTS_APIKEY,

  // Role configuration
  SCOUTNET_SCOUT_ROLE: process.env.SCOUTNET_SCOUT_ROLE || "scout",
  SCOUTNET_EVENT_ROLE: process.env.SCOUTNET_EVENT_ROLE || "participant",
  // How the member-facing pages name the server and the event. Plain Swedish
  // defaults, so an unset value still reads as a sentence.
  DISCORD_SERVER_NAME: process.env.DISCORD_SERVER_NAME || "servern",
  SCOUTNET_EVENT_NAME: process.env.SCOUTNET_EVENT_NAME || "eventet",
  SCOUTNET_FEE_ROLES: parseFeeRoles(process.env.SCOUTNET_FEE_ROLES),
  SCOUTNET_DIVISION_ROLES: parseDivisionRoles(
    process.env.SCOUTNET_DIVISION_ROLES,
  ),
  SCOUTNET_CATEGORY_ROLES: parseCategoryRoles(
    process.env.SCOUTNET_CATEGORY_ROLES,
  ),
  // `category:category+category` — which categories a member of the first sees in
  // `/adoption-scoutid`, at their own division. Same shape as
  // SCOUTNET_CATEGORY_ROLES, so the same parser. Unset = admins only.
  SCOUTNET_ADOPTION_SCOPE: parseCategoryRoles(
    process.env.SCOUTNET_ADOPTION_SCOPE,
  ),
  SCOUTNET_NICKNAME_SUFFIXES: parseNicknameSuffixes(
    process.env.SCOUTNET_NICKNAME_SUFFIXES,
  ),
  SCOUTNET_DIVISION_NAMES: parseDivisionNames(
    process.env.SCOUTNET_DIVISION_NAMES,
  ),
  // What a division is called in replies and reports — "avdelning", "patrull",
  // "grupp". An en-word in the indefinite form: the texts say "ingen
  // ${label}" and "din egen ${label}". Also names the slash-command option
  // (see divisionOptionName), so changing it means registering the commands
  // again.
  SCOUTNET_DIVISION_LABEL: process.env.SCOUTNET_DIVISION_LABEL || "avdelning",
  // `category:label,…` — a category whose division is called something else,
  // such as `ist-a:ist-patrull`. Each distinct label is its own
  // `/adoption-scoutid` option, so changing it means registering again.
  SCOUTNET_DIVISION_LABELS: parseCategoryRoles(
    process.env.SCOUTNET_DIVISION_LABELS,
  ),

  // General
  COOKIE_SECRET: process.env.COOKIE_SECRET,

  // Storage (Azure Table Storage)
  TABLE_CONNECTION_STRING: process.env.TABLE_CONNECTION_STRING,
  TABLE_NAME: process.env.TABLE_NAME || "scoutidlinks",
};

export default config;
