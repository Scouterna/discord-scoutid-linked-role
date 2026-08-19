import * as dotenv from "dotenv";

dotenv.config();

// The parsers below are exported alongside the assembled config so they can be
// tested directly. They are pure string-to-object functions, and testing them
// through repeated re-imports of this module meant dotenv printing its banner to
// stdout once per case — which corrupted the test runner's own output stream.

/**
 * Parse fee roles from env var format "feeId:category,feeId:category"
 * Example: "25694:deltagare,27561:deltagare,25696:ist,25702:IST-Direktresa,33293:ledare,34850:ledare,25697:cmt,25693:cmt"
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
 * Parse nickname suffix patterns from env var.
 * Format: "category:withDiv:withoutDiv,..."
 * Example: "deltagare:{div}:,ledare:AL{div}:AL,ist:IST-{div}:IST,IST-Direktresa::IST,cmt::CMT"
 *
 * {div} is replaced with the zero-padded division number.
 * Empty string means no suffix for that case.
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
 * Parse division role patterns from env var.
 * Format: "category:questionId:withDivPattern:withoutDivRole,..."
 * Example: "deltagare:88168:Deltagare-{div}:Deltagare-Väntande,ledare:107592:Ledare-{div}:Ledare-Väntande"
 *
 * Each category has its own question ID for the division number.
 * {div} is replaced with the zero-padded (2-digit min) division number.
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
 * Parse flat per-category roles from env var.
 * Format: "category:roleName,..."
 * Example: "ledare:Ledare,ist:IST"
 *
 * Granted *in addition to* the category's division role, so a leader in troop
 * 12 ends up with both `Ledare-12` and `Ledare`. Categories that already get a
 * flat role because they have no division config (`cmt` → `CMT`) need no entry.
 *
 * This exists for Discord AutoMod, which can only *exempt* roles and never
 * target them, with a hard cap of 20 exempt roles. Expressing "everyone except
 * participants" through the per-division roles would need 151 of them; through
 * flat markers it needs two.
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
 * Parse the member-event switch.
 * Format: comma-separated event names, e.g. "join,leave,nickname".
 *
 * Accepted: join, leave, nickname, roles. Empty, "off" or "none" disables the
 * scheduled member scan entirely.
 *
 * `roles` reports only role changes made by *someone other than this bot*, read
 * from the Discord audit log — the bot already logs its own as it makes them, and
 * a `/refresh-scoutid alla:true` would otherwise echo as one line per user. What
 * is left is a moderator editing roles by hand, named.
 *
 * It is off by default because it needs a permission the others do not: **View
 * Audit Log** on the bot's role. With it missing the scan logs a warning and
 * skips role changes; everything else is unaffected.
 */
export function parseMemberEvents(str) {
  const raw = (str ?? "join,leave,nickname").trim().toLowerCase();
  if (raw === "" || raw === "off" || raw === "none") return new Set();
  const known = ["join", "leave", "nickname", "roles"];
  const wanted = new Set();
  for (const name of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
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
    process.env.SCOUTNET_DIVISION_ROLES
  ),
  SCOUTNET_CATEGORY_ROLES: parseCategoryRoles(
    process.env.SCOUTNET_CATEGORY_ROLES
  ),
  SCOUTNET_NICKNAME_SUFFIXES: parseNicknameSuffixes(
    process.env.SCOUTNET_NICKNAME_SUFFIXES
  ),

  // General
  COOKIE_SECRET: process.env.COOKIE_SECRET,

  // Storage (Azure Table Storage)
  TABLE_CONNECTION_STRING: process.env.TABLE_CONNECTION_STRING,
  TABLE_NAME: process.env.TABLE_NAME || "scoutidlinks",
};

export default config;
