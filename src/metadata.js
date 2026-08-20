import * as discord from "./discord.js";
import * as scoutid from "./scoutid.js";
import * as storage from "./storage.js";

/**
 * Linked Role metadata: what this app tells Discord about a user, and what the
 * `Scout` role's requirement reads.
 *
 * Lives in its own module rather than inside the OAuth callback in server.js for
 * two reasons. It has to be callable without a user present — the whole point of
 * storing Discord refresh tokens is that the push can be redone in the
 * background — and inside a route handler it was unreachable from the test
 * suites.
 */

/**
 * Push metadata for one linked user, using their stored Discord tokens.
 *
 * Needs no user interaction: the stored token carries `role_connections.write`,
 * and `discord.getAccessToken` refreshes it when it has expired.
 */
export async function updateMetadata(discordUserId) {
  const scoutId = await storage.getLinkedScoutIDUserId(discordUserId);
  if (!scoutId) throw new Error("ingen storage-länk");

  const discordTokens = await storage.getDiscordTokens(discordUserId);
  if (!discordTokens) {
    throw new Error("Discord OAuth-tokens saknas i storage");
  }

  // `verified` is the *only* key the registered schema declares (see
  // register.js), and it is what the `Scout` Linked Role's requirement reads.
  //
  // A constant `true` is the normal shape for a Linked Role criterion: the value
  // carries no information, the *absence* does. Discord clears this metadata when
  // the user disconnects the app, and that is precisely the revocation the Scout
  // role exists to represent.
  //
  // The other three keys are not in the schema and Discord ignores them. They are
  // kept because they cost nothing and document what the flow knows.
  let metadata = { verified: true, scoutid: scoutId };
  try {
    const scoutIDTokens = await storage.getScoutIDTokens(scoutId);
    if (scoutIDTokens) {
      const scoutIDData = await scoutid.getUserData(scoutIDTokens);
      metadata = {
        verified: true,
        scoutid: scoutIDData.scoutid,
        email: scoutIDData.email,
        name: scoutIDData.name,
      };
    }
  } catch (e) {
    // Display data only — the name and email are informational, and a stale
    // ScoutID token must not cost the user their `verified` flag.
    console.error(`Error fetching ScoutID data: ${e.message}`);
  }

  await discord.pushMetadata(discordUserId, discordTokens, metadata);
  return metadata;
}

/**
 * Re-push metadata for every linked user.
 *
 * **Why this exists.** Nothing pushed `verified` until 2026-08-20, so Discord
 * holds no value for it for anyone who linked before that. Switching the `Scout`
 * role's requirement on while that is true would evaluate it as unsatisfied for
 * every one of them, revoke the role, and let the nightly sync strip them by the
 * verification gate. This closes that gap without anyone having to do anything:
 * the stored Discord tokens are enough.
 *
 * Returns `{ pushed, noTokens, failed }`, each an array of ids. **`noTokens` is
 * the number that matters** — those users cannot be repaired from here at all
 * (it is `/audit-scoutid` category 3), and they are exactly who will lose the
 * role when the requirement goes on. Knowing that list *before* flipping the
 * switch is the point of running this first.
 */
export async function pushAllMetadata({ dryRun = false } = {}) {
  const linkedUsers = await storage.getAllLinkedUsers();
  const pushed = [];
  const noTokens = [];
  const failed = [];

  for (const { discordUserId } of linkedUsers) {
    // Checked separately from the push so a missing token is reported as its own
    // category rather than as a failure — the two need different remedies, and
    // only one of them has a remedy at all.
    const tokens = await storage.getDiscordTokens(discordUserId);
    if (!tokens) {
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
    // Courtesy pause; the 429 retry in discord.js is the real guard.
    await new Promise((r) => setTimeout(r, 200));
  }

  return { pushed, noTokens, failed, dryRun, total: linkedUsers.length };
}

export function formatPushSummary({ pushed, noTokens, failed, dryRun, total }) {
  const lines = [
    `${total} länkade: ${pushed.length} pushade, ${noTokens.length} utan Discord-token, ${failed.length} fel.`,
  ];
  if (noTokens.length > 0) {
    lines.push("");
    lines.push(
      "Utan sparade Discord-tokens — dessa kan INTE lagas härifrån och tappar",
    );
    lines.push(
      "Scout-rollen när kravet slås på. De måste själva köra /linked-role:",
    );
    for (const id of noTokens) lines.push(`  ${id}`);
  }
  if (failed.length > 0) {
    lines.push("");
    lines.push("Fel:");
    for (const f of failed) lines.push(`  ${f.discordUserId} — ${f.error}`);
  }
  if (dryRun) {
    lines.push("");
    lines.push("(dry-run: ingenting pushat — 'pushade' är vad som skulle gå)");
  }
  return lines.join("\n");
}

// --- CLI entrypoint ---
//
// Guarded so importing this module from server.js does not start a push.

const isCli = process.argv[1]?.endsWith("metadata.js");

if (isCli) {
  const dryRun = process.argv.includes("--dry-run");
  try {
    const result = await pushAllMetadata({ dryRun });
    console.log(formatPushSummary(result));
    if (result.failed.length > 0) process.exit(1);
  } catch (e) {
    console.error("Metadata push failed:", e);
    process.exit(1);
  }
}
