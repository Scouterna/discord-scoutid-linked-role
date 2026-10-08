import config from "./config.js";
import * as discord from "./discord.js";
import * as storage from "./storage.js";
import * as eventlog from "./eventlog.js";

/**
 * Removes links for Discord accounts that are not in the server: second accounts
 * a member linked from by mistake, and members who have left. Such a link can
 * give nothing, and every sync reports its 404.
 *
 * Run by hand, not on a schedule. Someone who leaves and rejoins has to link
 * again once their link is gone, so removing it is a decision, not upkeep.
 *
 * Two proofs, because a missing member must never be read into a list that
 * merely came back short — the same mistake as reading a truncated snapshot as
 * absence:
 *
 *   1. The member list must look whole. A list smaller than half the links
 *      stops the run before anything is removed.
 *   2. Each candidate is asked about once more and is removed only on Discord's
 *      own 404. An error or no answer keeps the link.
 */
export async function runPrune({ dryRun = false } = {}) {
  const guildId = config.DISCORD_GUILD_ID;
  if (!guildId) throw new Error("DISCORD_GUILD_ID is not set");

  const [members, links] = await Promise.all([
    discord.getGuildMembers(guildId),
    storage.getAllLinkedUsers(),
  ]);
  if (members.length < links.length / 2) {
    throw new Error(
      `the member list has ${members.length} members against ${links.length} links — refusing to read that as absence`,
    );
  }

  const memberIds = new Set(members.map((m) => m.user.id));
  const removed = [];
  const kept = [];
  for (const link of links) {
    if (memberIds.has(link.discordUserId)) continue;
    const isMember = await discord.isGuildMember(guildId, link.discordUserId);
    if (isMember !== false) {
      kept.push(link);
      continue;
    }
    if (!dryRun) await storage.deleteLink(link.discordUserId);
    removed.push(link);
  }
  return { links: links.length, removed, kept, dryRun };
}

export function formatPruneSummary({ links, removed, kept, dryRun }) {
  const lines = [
    `${links} länkar, ${removed.length} ${dryRun ? "skulle tas bort" : "borttagna"}.`,
  ];
  for (const l of removed) lines.push(`  ${l.discordUserId}`);
  for (const l of kept) {
    lines.push(
      `  ⚠️ ${l.discordUserId} — saknas i listan men bekräftades inte, behålls`,
    );
  }
  if (dryRun) lines.push("(dry-run: inget borttaget, ingenting loggat)");
  return lines.join("\n");
}

// Guarded so importing this module does not start a run.
if (process.argv[1]?.endsWith("prune.js")) {
  const dryRun = process.argv.includes("--dry-run");
  try {
    const result = await runPrune({ dryRun });
    console.log(formatPruneSummary(result));
    if (!dryRun && result.removed.length > 0) {
      eventlog.logLinksPruned(result);
      await eventlog.flushEventLog();
    }
  } catch (e) {
    console.error("Prune failed:", e);
    process.exit(1);
  }
}
