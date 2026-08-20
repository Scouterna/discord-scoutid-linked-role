import config from "./config.js";
import * as roles from "./roles.js";
import * as eventlog from "./eventlog.js";

/**
 * Whole-server role sync, for the scheduled run.
 *
 * **Why this exists as a scheduled job.** Nothing propagated ScoutNet changes on
 * its own. A participant who gets a troop assigned stays on
 * `Deltagare-Väntande` until an admin happens to type `/refresh-scoutid
 * alla:true` — and the closer the event gets, the more the assignments move. The
 * work was already written; what was missing was anything that ran it without
 * being asked.
 *
 * **A CronJob and not a timer in the server**, for the same reason the member
 * scan is one: the Deployment runs `replicas: 2`, so an interval inside it would
 * do every sync twice. That is also why the report goes through the event log
 * rather than a return value nobody reads.
 *
 * `runRefresh` is exported for tests; the CLI guard at the bottom is what the
 * CronJob invokes.
 */
export async function runRefresh({ dryRun = false } = {}) {
  const guildId = config.DISCORD_GUILD_ID;
  if (!guildId) throw new Error("DISCORD_GUILD_ID is not set");

  const results = await roles.syncAllUserRoles(guildId, { dryRun });

  const errors = results.filter((r) => r.error);
  const changed = results.filter(
    (r) =>
      !r.error &&
      ((r.added?.length ?? 0) > 0 ||
        (r.removed?.length ?? 0) > 0 ||
        Boolean(r.nickname)),
  );

  return { results, changed, errors, dryRun };
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

// --- CLI entrypoint ---
//
// Guarded so importing this module does not start a sync.

const isCli = process.argv[1]?.endsWith("refresh.js");

if (isCli) {
  const dryRun = process.argv.includes("--dry-run");
  try {
    const result = await runRefresh({ dryRun });
    console.log(formatRefreshSummary(result));

    // The event log is the durable record of what a run nobody watched actually
    // did — and a dry run must leave no trace in it, which is why the write is
    // on this side of the check rather than inside runRefresh.
    if (!dryRun) {
      eventlog.logScheduledSyncAll(result);
      await eventlog.flushEventLog();
    }
  } catch (e) {
    console.error("Role refresh failed:", e);
    process.exit(1);
  }
}
