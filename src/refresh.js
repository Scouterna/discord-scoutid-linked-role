import config from "./config.js";
import * as roles from "./roles.js";
import * as eventlog from "./eventlog.js";
import { partitionResults } from "./guild.js";

/**
 * Whole-server role sync, for the nightly CronJob.
 *
 * Nothing else propagates ScoutNet changes: a participant who gets a troop
 * assigned stays on `Deltagare-Väntande` until someone types `/refresh-scoutid
 * alla:true`, and the closer the event gets the more the assignments move.
 *
 * **A CronJob and not a timer in the server**, for the same reason the member
 * scan is one: the Deployment runs `replicas: 2`, so an interval inside it would
 * do every sync twice. That is also why the report goes through the event log
 * rather than a return value nobody reads.
 */
export async function runRefresh({ dryRun = false } = {}) {
  const guildId = config.DISCORD_GUILD_ID;
  if (!guildId) throw new Error("DISCORD_GUILD_ID is not set");

  const results = await roles.syncAllUserRoles(guildId, { dryRun });
  return { results, ...partitionResults(results), dryRun };
}

/** One line per changed user, for a dry run's stdout. */
export function formatRefreshSummary({ results, changed, errors, dryRun }) {
  const lines = [
    `${results.length} användare, ${changed.length} ändrade, ${errors.length} fel.`,
  ];
  for (const r of changed) {
    const parts = [];
    if (r.added?.length) parts.push(`+ ${r.added.join(", ")}`);
    if (r.removed?.length) parts.push(`- ${r.removed.join(", ")}`);
    if (r.nickname) parts.push(`smeknamn: ${r.nickname}`);
    lines.push(`  ${r.discordUserId} — ${parts.join(" · ")}`);
  }
  for (const r of errors) lines.push(`  ⚠️ ${r.discordUserId} — ${r.error}`);
  if (dryRun) lines.push("(dry-run: inget skrivet, ingenting loggat)");
  return lines.join("\n");
}

// Guarded so importing this module does not start a sync.
if (process.argv[1]?.endsWith("refresh.js")) {
  const dryRun = process.argv.includes("--dry-run");
  try {
    const result = await runRefresh({ dryRun });
    console.log(formatRefreshSummary(result));

    // The event log is the durable record of what an unwatched run did — and a
    // dry run must leave no trace in it, which is why the write is on this side
    // of the check rather than inside runRefresh.
    if (!dryRun) {
      eventlog.logScheduledSyncAll(result);
      await eventlog.flushEventLog();
    }
  } catch (e) {
    console.error("Role refresh failed:", e);
    process.exit(1);
  }
}
