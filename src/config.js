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
 * Example: `"25694:deltagare,25697:cmt"`.
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
 * `"category:withDiv:withoutDiv,..."` → `{ category: { withDiv, withoutDiv } }`.
 * Example: `"deltagare:{div}:,ledare:AL{div}:AL,cmt::CMT"`.
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
 * `"01:Björnen,02:Bävern,..."` → `{ "01": "Björnen" }`.
 *
 * What `{divnamn}` in a nickname suffix resolves to. Numbers are zero-padded on
 * read, so `"1:Björnen"` and `"01:Björnen"` are the same row.
 *
 * **This is a second copy.** The names live in `discord/terraform.tfvars` in
 * Scouterna/wsj27-infra, which is where the channel topics read them from; a
 * division renamed there has to be renamed here too. Nothing detects the drift
 * — the suffix would simply keep the old name.
 *
 * The map is keyed by number alone, which holds only as long as one number means
 * one thing. `deltagare` and `ledare` both answer with an avdelning, so they
 * share these names correctly, but `ist` reads the same ScoutNet question for a
 * *patrol* number. IST patrols have no names today, so nothing collides; give
 * them names and this has to become per-category first.
 */
export function parseDivisionNames(str) {
  if (!str) return null;
  const map = {};
  for (const entry of str.split(",")) {
    const [num, name] = entry.split(":").map((s) => s.trim());
    if (num && name) map[num.padStart(2, "0")] = name;
  }
  return Object.keys(map).length > 0 ? map : null;
}

/**
 * `"category:questionId:withDiv:withoutDiv,..."` →
 * `{ category: { questionId, withDiv, withoutDiv } }`.
 * Example: `"deltagare:88168:Deltagare-{div}:Deltagare-Väntande"`.
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
 * `"category:roleName,..."` → `{ category: roleName }`.
 *
 * Granted *in addition to* the category's division role, so a leader in troop 12
 * ends up with both `Ledare-12` and `Ledare`. A category with no division config
 * already gets a flat role (`cmt` → `CMT`) and needs no entry.
 *
 * This exists for Discord AutoMod, which can only *exempt* roles and never
 * target them, with a hard cap of 20 exempt roles: "everyone except
 * participants" needs 151 per-division roles, or two flat markers.
 */
export function parseCategoryRoles(str) {
  if (!str) return null;
  const map = {};
  for (const entry of str.split(",")) {
    const [category, role] = entry.split(":").map((s) => s.trim());
    if (category && role) map[category] = role;
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

  // Channel the verification event log is written to (#server-logg, created by
  // Scouterna/wsj27-infra). Unset means the log is off, and everything else
  // behaves identically — see src/eventlog.js.
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
  SCOUTNET_FEE_ROLES: parseFeeRoles(process.env.SCOUTNET_FEE_ROLES),
  SCOUTNET_DIVISION_ROLES: parseDivisionRoles(
    process.env.SCOUTNET_DIVISION_ROLES,
  ),
  SCOUTNET_CATEGORY_ROLES: parseCategoryRoles(
    process.env.SCOUTNET_CATEGORY_ROLES,
  ),
  SCOUTNET_NICKNAME_SUFFIXES: parseNicknameSuffixes(
    process.env.SCOUTNET_NICKNAME_SUFFIXES,
  ),
  SCOUTNET_DIVISION_NAMES: parseDivisionNames(
    process.env.SCOUTNET_DIVISION_NAMES,
  ),

  // General
  COOKIE_SECRET: process.env.COOKIE_SECRET,

  // Storage (Azure Table Storage)
  TABLE_CONNECTION_STRING: process.env.TABLE_CONNECTION_STRING,
  TABLE_NAME: process.env.TABLE_NAME || "scoutidlinks",
};

export default config;
