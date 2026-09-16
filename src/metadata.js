import config from "./config.js";
import * as discord from "./discord.js";
import * as scoutnet from "./scoutnet.js";
import * as storage from "./storage.js";

/**
 * Linked Role metadata: what this app tells Discord about a user, and what the
 * Scout role's requirement reads. Its own module because it has to be callable
 * with no user present — that is what the stored refresh tokens are for.
 */

/**
 * What a member has to do to get the Scout role back, in words they can act on.
 * Not "run `/linked-role`" — that is an HTTP route, not a command — and not the
 * route alone either: Scout is connection-gated, so Discord grants it *only*
 * when the user clicks Link from inside Discord. The verification URL refreshes
 * the metadata and token (the gate's second proof) but never grants the role.
 */
export const RELINK_PATH = `Kanaler och roller → ${config.SCOUTNET_SCOUT_ROLE} → Länka`;

/** The same thing as a clause, for embedding mid-sentence. */
export const RELINK_INSTRUCTION = `länka om ${config.SCOUTNET_SCOUT_ROLE}-rollen i Discord: ${RELINK_PATH}`;

/**
 * Push metadata for one linked user, using their stored Discord tokens.
 *
 * `verified` is the *only* key the registered schema declares (see register.js)
 * and what the Scout requirement reads. A constant `true` is the normal shape for
 * a linked-role criterion: the value carries no information, the **absence** does
 * — Discord clears the metadata when the user disconnects the app, which is
 * precisely the revocation the Scout role represents.
 *
 * `scoutid` is outside the schema, so Discord stores it and no requirement reads
 * it. Kept because it makes the stored connection self-describing.
 */
export async function updateMetadata(discordUserId) {
  const scoutId = await storage.getLinkedScoutIDUserId(discordUserId);
  if (!scoutId) throw new Error("ingen storage-länk");

  const discordTokens = await storage.getDiscordTokens(discordUserId);
  if (!discordTokens) throw new Error("Discord OAuth-tokens saknas i storage");

  // The connection card's visible line. ScoutNet's name, because the bot already
  // writes it into the nickname, so it exposes nothing the guild cannot see —
  // deliberately not the scoutid, which is admin-facing while a connection card
  // can be seen wider. Wrapped, and the push happens either way: an outage must
  // not cost anyone their `verified` flag. The price is that a push made during
  // one clears the displayed name until the next, since PUT replaces the object.
  let platformUsername = "";
  try {
    platformUsername = scoutnet.fullName(
      await scoutnet.getParticipant(scoutId),
    );
  } catch (e) {
    console.error(
      `Kunde inte hämta ScoutNet-namn för ${scoutId}: ${e.message}`,
    );
  }

  const metadata = { verified: true, scoutid: scoutId };
  await discord.pushMetadata(
    discordUserId,
    discordTokens,
    metadata,
    platformUsername,
  );
  return metadata;
}

/**
 * Is the user's Discord OAuth grant still alive? The gate's second proof, and the
 * one that needs nothing from the user. **Three answers, not two**: `accepted`
 * (the grant is live), `rejected` (the user revoked the app — the revocation the
 * boundary exists to catch), `unknown` (Discord could not answer — **the caller
 * must not act on this**, or an outage strips the whole server).
 *
 * A **missing stored token is `rejected`**, the less generous reading on purpose:
 * no path leads from there to verified except the user re-linking, so `unknown`
 * would grant permanent access and make `/link-scoutid` a standing bypass.
 *
 * `readOnly` is the audit's mode: nothing may be refreshed, because a refresh
 * rotates and re-stores the token pair — a write. A 401 is then ambiguous (an
 * expired access token and a revoked grant answer alike, and only a refresh can
 * tell them apart), so it comes back `unknown` instead of `rejected`. The full
 * probe has already spent the refresh token on a 401 before judging it.
 */
export async function verifyConnection(
  discordUserId,
  { readOnly = false } = {},
) {
  const tokens = await storage.getDiscordTokens(discordUserId);
  if (!tokens) {
    return { status: "rejected", detail: "inget sparat Discord-token" };
  }

  try {
    const { ok, status } = await discord.getRoleConnection(
      discordUserId,
      tokens,
      { readOnly },
    );
    if (ok) return { status: "accepted", detail: `HTTP ${status}` };
    if (status === 401 && readOnly) {
      return {
        status: "unknown",
        detail:
          "HTTP 401 — kan vara ett utgånget access-token; bara den fulla proben kan avgöra",
      };
    }
    if (status === 401 || status === 403) {
      return { status: "rejected", detail: `HTTP ${status}` };
    }
    return { status: "unknown", detail: `HTTP ${status}` };
  } catch (e) {
    // A failed refresh lands here. `invalid_grant` is Discord saying the refresh
    // token is gone, which is a real no; a socket error is not.
    if (/invalid_grant/i.test(e.message)) {
      return { status: "rejected", detail: e.message };
    }
    return { status: "unknown", detail: e.message };
  }
}

/**
 * Re-push metadata for every linked user, from their stored Discord tokens.
 *
 * **`noTokens` is the number that matters**: those users cannot be repaired from
 * here, and they are exactly who loses the Scout role when its requirement is
 * switched on. Reading that list before flipping the switch is the point.
 */
export async function pushAllMetadata({ dryRun = false } = {}) {
  const linkedUsers = await storage.getAllLinkedUsers();
  const pushed = [];
  const noTokens = [];
  const failed = [];

  for (const { discordUserId } of linkedUsers) {
    // Its own category rather than a failure: the two need different remedies,
    // and only one of them has a remedy at all.
    if (!(await storage.getDiscordTokens(discordUserId))) {
      noTokens.push(discordUserId);
      continue;
    }
    if (dryRun) {
      pushed.push(discordUserId);
      continue;
    }
    try {
      await updateMetadata(discordUserId);
      pushed.push(discordUserId);
    } catch (e) {
      failed.push({ discordUserId, error: e.message });
    }
    // Courtesy pause; the 429 retry in http.js is the real guard.
    await new Promise((r) => setTimeout(r, 200));
  }

  return { pushed, noTokens, failed, dryRun, total: linkedUsers.length };
}

export function formatPushSummary({ pushed, noTokens, failed, dryRun, total }) {
  const lines = [
    `${total} länkade: ${pushed.length} pushade, ${noTokens.length} utan Discord-token, ${failed.length} fel.`,
  ];
  if (noTokens.length > 0) {
    lines.push(
      "",
      "Utan sparade Discord-tokens — kan inte lagas härifrån. De tappar",
      `${config.SCOUTNET_SCOUT_ROLE}-rollen om deras Discord-koppling också dör, och måste då`,
      "länka om den själva:",
      `  ${RELINK_PATH}`,
      "",
      ...noTokens.map((id) => `  ${id}`),
    );
  }
  if (failed.length > 0) {
    lines.push(
      "",
      "Fel:",
      ...failed.map((f) => `  ${f.discordUserId} — ${f.error}`),
    );
  }
  if (dryRun) {
    lines.push(
      "",
      "(dry-run: ingenting pushat — 'pushade' är vad som skulle gå)",
    );
  }
  return lines.join("\n");
}

// Guarded so importing this module from the server does not start a push.
if (process.argv[1]?.endsWith("metadata.js")) {
  try {
    const result = await pushAllMetadata({
      dryRun: process.argv.includes("--dry-run"),
    });
    console.log(formatPushSummary(result));
    if (result.failed.length > 0) process.exit(1);
  } catch (e) {
    console.error("Metadata push failed:", e);
    process.exit(1);
  }
}
