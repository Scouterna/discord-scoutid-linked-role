import * as dotenv from "dotenv";

dotenv.config();

/**
 * Parse fee roles from env var format "feeId:category,feeId:category"
 * Example: "25694:deltagare,27561:deltagare,25696:ist,25702:IST-Direktresa,33293:ledare,34850:ledare,25697:cmt,25693:cmt"
 */
function parseFeeRoles(str) {
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
function parseNicknameSuffixes(str) {
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
function parseDivisionRoles(str) {
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

const config = {
  // Discord
  DISCORD_TOKEN: process.env.DISCORD_TOKEN,
  DISCORD_CLIENT_ID: process.env.DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET: process.env.DISCORD_CLIENT_SECRET,
  DISCORD_PUBLIC_KEY: process.env.DISCORD_PUBLIC_KEY,
  DISCORD_REDIRECT_URI: process.env.DISCORD_REDIRECT_URI,
  DISCORD_VALIDATION_URL: process.env.DISCORD_VALIDATION_URL,
  DISCORD_GUILD_ID: process.env.DISCORD_GUILD_ID,

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
