import config from "./config.js";
import * as discord from "./discord.js";
import * as scoutnet from "./scoutnet.js";
import * as storage from "./storage.js";
import * as roles from "./roles.js";
import { RELINK_INSTRUCTION, verifyConnection } from "./metadata.js";
import {
  roleMapOf,
  displayName,
  stripNickSuffix,
  abbreviatedNames,
  withDivision,
  managedRoleNames,
  divisionPrefixes,
} from "./guild.js";

/**
 * Server consistency audit: everything that disagrees between Discord, the
 * ScoutID links in storage, and ScoutNet. All data is collected once, then each
 * check reads it. **The audit never writes**, which is what makes it safe to run
 * locally against production credentials — and a clean guild must produce zero
 * findings, because an audit that cries wolf is one nobody reads.
 */

const SKIPPED_NO_EVENT = "(SCOUTNET_EVENT_ID inte satt — hoppar över.)";

/** Findings are counted; parenthesised lines are "this check was skipped" notes. */
const isSkipNote = (item) => item.startsWith("(");

function normalizeName(s) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

/** The "(suffix)" token from a display name, or null. */
function extractSuffix(name) {
  return (name || "").match(/\s*\(([^()]*)\)\s*$/)?.[1] ?? null;
}

/**
 * Division role names that current ScoutNet data actually calls for, per
 * category — so a missing role is only reported when someone needs it.
 */
function expectedDivisionRoleNames(participants) {
  const expected = new Map();
  if (!participants || !config.SCOUTNET_DIVISION_ROLES) return expected;

  for (const category of Object.keys(config.SCOUTNET_DIVISION_ROLES)) {
    expected.set(category, new Set());
  }
  for (const p of Object.values(participants)) {
    if (scoutnet.isCancelled(p)) continue;
    const category = config.SCOUTNET_FEE_ROLES?.[String(p.fee_id)];
    const divConfig = category
      ? config.SCOUTNET_DIVISION_ROLES?.[category]
      : null;
    const division = divConfig ? p.questions?.[divConfig.questionId] : null;
    if (!division) continue;
    expected.get(category).add(withDivision(divConfig.withDiv, division));
  }
  return expected;
}

/** Everything the checks read, fetched once. */
async function gatherContext(guildId) {
  const [guildMembers, guildRoles, linkedUsers, participants, botMember] =
    await Promise.all([
      discord.getGuildMembers(guildId),
      discord.getGuildRoles(guildId),
      storage.getAllLinkedUsers(),
      config.SCOUTNET_EVENT_ID ? scoutnet.getParticipants() : null,
      discord.getBotMember(guildId).catch(() => null),
    ]);

  const roleMap = roleMapOf(guildRoles);
  const roleById = new Map(guildRoles.map((r) => [r.id, r]));
  const scoutRoleName = config.SCOUTNET_SCOUT_ROLE || "scout";

  const botRoles = (botMember?.roles ?? [])
    .map((id) => roleById.get(id))
    .filter(Boolean);
  const botHighestPosition = botRoles.reduce(
    (max, r) => Math.max(max, r.position),
    0,
  );

  return {
    guildMembers,
    linkedUsers,
    participants,
    botMember,
    botRoles,
    botHighestPosition,
    roleMap,
    roleById,
    scoutRoleName,
    scoutRole: roleMap.get(scoutRoleName.toLowerCase()),
    linkedMap: new Map(linkedUsers.map((u) => [u.discordUserId, u.scoutId])),
    memberMap: new Map(guildMembers.map((m) => [m.user.id, m])),
    expectedDivisions: expectedDivisionRoleNames(participants),
    /** Can the bot modify this member, or do they hold a role at/above it? */
    canBotModify: (member) =>
      !member.roles.some(
        (id) => (roleById.get(id)?.position ?? 0) >= botHighestPosition,
      ),
  };
}

/**
 * The checks, in report order. `needs` declares a precondition — unmet, the
 * check contributes a skip note instead of running. `run` returns
 * `{ items, note }`; `note` is context that belongs in the report even when the
 * category is empty.
 */
const CHECKS = [
  {
    id: "scout_role_no_link",
    title: (ctx) =>
      `Har \`${ctx.scoutRoleName}\`-rollen men ingen storage-länk`,
    needs: "scoutRole",
    run: ({ guildMembers, scoutRole, linkedMap }) => ({
      items: guildMembers
        .filter(
          (m) => m.roles.includes(scoutRole.id) && !linkedMap.has(m.user.id),
        )
        .map((m) => `- <@${m.user.id}> (${displayName(m)})`),
    }),
  },

  {
    id: "linked_no_scout_role",
    title: () =>
      `Saknar ${config.SCOUTNET_SCOUT_ROLE}-rollen *och* har ingen giltig Discord-koppling`,
    needs: "scoutRole",
    /**
     * The verification gate takes two proofs, so a missing role is only half the
     * question — asking half of it reports members who are in no danger at all.
     * The probe runs `readOnly`, which is what actually keeps the audit from
     * writing: the full probe refreshes an expiring token, and a refresh rotates
     * and re-stores the pair. The price is that a 401 comes back `unknown`
     * rather than `rejected` — only a refresh can tell an expired access token
     * from a revoked grant, and the nightly sync is the one that gets to spend
     * it. It only runs for members who lack the role.
     */
    run: async ({ linkedUsers, memberMap, scoutRole }) => {
      const items = [];
      let carried = 0;
      for (const u of linkedUsers) {
        const member = memberMap.get(u.discordUserId);
        if (!member || member.roles.includes(scoutRole.id)) continue;

        const connection = await verifyConnection(u.discordUserId, {
          readOnly: true,
        });
        if (connection.status === "accepted") {
          carried++;
          continue;
        }
        const why =
          connection.status === "unknown"
            ? `kunde inte avgöra kopplingen (${connection.detail})`
            : `kopplingen är död (${connection.detail})`;
        items.push(
          `- <@${u.discordUserId}> (${displayName(member)}) scoutid=\`${u.scoutId}\` — ${why}, be hen ${RELINK_INSTRUCTION}`,
        );
      }
      return {
        items,
        note:
          carried > 0
            ? `${carried} till saknar rollen men är verifierade via sin Discord-koppling — de påverkas inte, och får rollen när de nästa gång länkar om.`
            : null,
      };
    },
  },

  {
    id: "linked_no_tokens",
    title:
      "Länkade utan sparade Discord-tokens — botten kan inte re-pusha Linked Role-metadata",
    /**
     * The link is enough for roles and nicknames but not to speak to Discord in
     * the user's name, so `updateMetadata` cannot push the metadata that makes
     * Discord (re-)grant the Scout role. The failure is silent until the role
     * falls off, and then neither admin nor bot can fix it — the person has to
     * re-link themselves. `/link-scoutid` does not repair this.
     */
    run: async ({ linkedUsers, memberMap }) => {
      let tokenIds;
      try {
        tokenIds = await storage.getUserIdsWithTokens("discord-token");
      } catch (e) {
        return { items: [`(Kunde inte läsa tokens: ${e.message})`] };
      }
      return {
        items: linkedUsers
          .filter((u) => !tokenIds.has(u.discordUserId))
          .map(
            (u) =>
              `- <@${u.discordUserId}> (${displayName(memberMap.get(u.discordUserId)) || "ej i guilden"}) scoutid=\`${u.scoutId}\` — be hen ${RELINK_INSTRUCTION}. \`/link-scoutid\` lagar inte det här, och utan token finns inget andra bevis heller`,
          ),
      };
    },
  },

  {
    id: "stale_link",
    title: "Storage-länk men inte (längre) medlem i guilden",
    run: ({ linkedUsers, memberMap }) => ({
      items: linkedUsers
        .filter((u) => !memberMap.has(u.discordUserId))
        .map(
          (u) => `- discord=\`${u.discordUserId}\` scoutid=\`${u.scoutId}\``,
        ),
    }),
  },

  {
    id: "cancelled",
    title: "Länkad men avbokad i ScoutNet",
    needs: "participants",
    run: ({ linkedUsers, participants }) => ({
      items: linkedUsers
        .filter((u) => scoutnet.isCancelled(participants[u.scoutId]))
        .map((u) => {
          const p = participants[u.scoutId];
          return `- <@${u.discordUserId}> scoutid=\`${u.scoutId}\` ${scoutnet.fullName(p) || "?"} (avbokad ${scoutnet.cancelledLabel(p)})`;
        }),
    }),
  },

  {
    id: "name_mismatch",
    title: "Möjlig fellänkning — namn matchar inte",
    needs: "participants",
    /** Neither name present in the display name is the signal for a mislink. */
    run: ({ linkedUsers, memberMap, participants }) => {
      const items = [];
      for (const u of linkedUsers) {
        const member = memberMap.get(u.discordUserId);
        const p = participants[u.scoutId];
        if (!member || !p || scoutnet.isCancelled(p)) continue;
        if (!p.first_name && !p.last_name) continue;

        const shown = stripNickSuffix(displayName(member));
        const display = normalizeName(shown);
        const first = normalizeName(p.first_name || "");
        const last = normalizeName(p.last_name || "");
        if (
          (!first || display.includes(first)) &&
          (!last || display.includes(last))
        ) {
          continue;
        }
        // "Alexandra J" is the sync's own work, not a member who renamed
        // themselves: `fitNickname` shortens the surname when the full name plus
        // its suffix would not fit Discord's 32 characters. Without this the
        // audit reports every one of them, and a category that shouts about
        // nothing is one nobody reads.
        if (
          abbreviatedNames(scoutnet.fullName(p)).some(
            (form) => display === normalizeName(form),
          )
        ) {
          continue;
        }
        items.push(
          `- <@${u.discordUserId}> scoutid=\`${u.scoutId}\` Discord="${shown}" ScoutNet="${scoutnet.fullName(p)}"`,
        );
      }
      return { items };
    },
  },

  {
    id: "missing_static_roles",
    title: "Konfigurerade roller som saknas i Discord (statiska)",
    run: ({ roleMap }) => ({
      items: managedRoleNames()
        .filter((name) => !roleMap.has(name.toLowerCase()))
        .map((name) => `- \`${name}\``),
    }),
  },

  {
    id: "missing_division_roles",
    title:
      "Division-roller som ScoutNet refererar till men som saknas i Discord",
    needs: "participants",
    run: ({ roleMap, expectedDivisions }) => {
      const items = [];
      for (const [category, names] of expectedDivisions) {
        const missing = [...names].filter((n) => !roleMap.has(n.toLowerCase()));
        if (missing.length > 0) {
          items.push(`- ${category}: ${missing.sort().join(", ")}`);
        }
      }
      return { items };
    },
  },

  {
    id: "unknown_fee_ids",
    title: "Okända fee_id i ScoutNet (behöver konfigureras)",
    needs: "participants",
    run: ({ participants }) => {
      if (!config.SCOUTNET_FEE_ROLES) {
        return {
          items: ["(SCOUTNET_FEE_ROLES inte konfigurerad — hoppar över.)"],
        };
      }
      const seen = new Map(); // fee_id → participant count
      for (const p of Object.values(participants)) {
        if (scoutnet.isCancelled(p) || p?.fee_id == null) continue;
        const fid = String(p.fee_id);
        if (!config.SCOUTNET_FEE_ROLES[fid]) {
          seen.set(fid, (seen.get(fid) || 0) + 1);
        }
      }
      return {
        items: [...seen.entries()]
          .sort()
          .map(
            ([fid, count]) =>
              `- fee_id=\`${fid}\` (${count} deltagare) — saknas i SCOUTNET_FEE_ROLES`,
          ),
      };
    },
  },

  {
    id: "bot_permissions",
    title: "Bot-rollens hierarki och behörigheter",
    needs: "botMember",
    /**
     * A role at or above the bot's highest position cannot be assigned, and a
     * missing permission fails every write silently from the user's side. The
     * permission bits are read from the bot's *roles*, not from the member.
     */
    run: ({ roleMap, botRoles, botHighestPosition, expectedDivisions }) => {
      const items = [];
      const managed = new Set(managedRoleNames().map((n) => n.toLowerCase()));
      for (const names of expectedDivisions.values()) {
        for (const n of names) managed.add(n.toLowerCase());
      }

      for (const lower of managed) {
        const role = roleMap.get(lower);
        if (!role) continue; // already reported as a missing role
        if (role.position >= botHighestPosition) {
          items.push(
            `- \`${role.name}\` (position ${role.position}) ligger på eller över botens högsta position (${botHighestPosition})`,
          );
        }
      }

      let perms = 0n;
      for (const r of botRoles) {
        try {
          perms |= BigInt(r.permissions);
        } catch {
          // A role without parseable permissions contributes nothing.
        }
      }
      const has = (bit) => (perms & bit) === bit;
      if (!has(1n << 3n)) {
        // ADMINISTRATOR implies both
        if (!has(1n << 28n)) items.push("- Bot saknar MANAGE_ROLES");
        if (!has(1n << 27n)) items.push("- Bot saknar MANAGE_NICKNAMES");
      }
      return { items };
    },
  },

  {
    id: "role_drift",
    title: "Drift mellan faktiska och önskade roller",
    needs: "participants",
    /**
     * Members the bot cannot modify are skipped: a 403 from the role hierarchy
     * is expected for them, so reporting the drift would be a permanent finding
     * nobody can act on.
     */
    run: async (ctx) => {
      const { linkedUsers, memberMap, roleMap, roleById, botMember } = ctx;
      const managedStatic = new Set(
        managedRoleNames().map((n) => n.toLowerCase()),
      );
      const prefixes = divisionPrefixes().map((d) => d.prefix);
      const items = [];

      for (const u of linkedUsers) {
        const member = memberMap.get(u.discordUserId);
        if (!member) continue;
        if (botMember && !ctx.canBotModify(member)) continue;

        let desired;
        try {
          desired = await roles.getDesiredRoles(u.scoutId);
        } catch {
          continue;
        }
        const desiredLower = new Set(desired.map((n) => n.toLowerCase()));

        const missing = desired.filter((n) => {
          const role = roleMap.get(n.toLowerCase());
          return role && !role.managed && !member.roles.includes(role.id);
        });

        // Only roles the bot manages count as wrongly held — anything else in
        // the guild is somebody else's business.
        const extra = (member.roles || [])
          .map((id) => roleById.get(id)?.name)
          .filter(Boolean)
          .filter((n) => {
            const lower = n.toLowerCase();
            if (desiredLower.has(lower)) return false;
            if (roleMap.get(lower)?.managed) return false;
            return (
              managedStatic.has(lower) ||
              prefixes.some((p) => lower.startsWith(p))
            );
          });

        if (missing.length > 0 || extra.length > 0) {
          const parts = [];
          if (missing.length > 0) parts.push(`saknar: ${missing.join(", ")}`);
          if (extra.length > 0)
            parts.push(`har felaktigt: ${extra.join(", ")}`);
          items.push(`- <@${u.discordUserId}> — ${parts.join(" · ")}`);
        }
      }
      return { items };
    },
  },

  {
    id: "multiple_division_roles",
    title: "Användare med flera division-roller i samma kategori",
    /** Two divisions in one category means one of them was never removed. */
    run: ({ guildMembers, roleById }) => {
      const prefixes = divisionPrefixes();
      const items = [];
      for (const m of guildMembers) {
        const byCategory = new Map();
        for (const id of m.roles) {
          const lower = roleById.get(id)?.name.toLowerCase();
          if (!lower) continue;
          for (const { category, prefix } of prefixes) {
            if (!lower.startsWith(prefix)) continue;
            if (!byCategory.has(category)) byCategory.set(category, []);
            byCategory.get(category).push(roleById.get(id).name);
          }
        }
        for (const [category, names] of byCategory) {
          if (names.length > 1) {
            items.push(
              `- <@${m.user.id}> har flera ${category}-roller: ${names.sort().join(", ")}`,
            );
          }
        }
      }
      return { items };
    },
  },

  {
    id: "wrong_nickname_suffix",
    title: "Användare med fel nickname-suffix",
    needs: "participants",
    run: async ({ linkedUsers, memberMap }) => {
      const items = [];
      for (const u of linkedUsers) {
        const member = memberMap.get(u.discordUserId);
        if (!member) continue;

        let expected;
        try {
          expected = await roles.getNicknameSuffix(u.scoutId);
        } catch {
          continue;
        }
        const expectedToken = extractSuffix(expected);
        const shown = displayName(member);
        const actualToken = extractSuffix(shown);

        if ((expectedToken || "") !== (actualToken || "")) {
          items.push(
            `- <@${u.discordUserId}> nick="${shown}" — har "${actualToken ?? "(inget)"}" förväntat "${expectedToken ?? "(inget)"}"`,
          );
        }
      }
      return { items };
    },
  },
];

/** The skip note for an unmet precondition, or null when the check can run. */
function skipNote(need, ctx) {
  if (need === "participants" && !ctx.participants) return SKIPPED_NO_EVENT;
  if (need === "scoutRole" && !ctx.scoutRole) {
    return `(Rollen \`${ctx.scoutRoleName}\` finns inte i guilden.)`;
  }
  if (need === "botMember" && !ctx.botMember) {
    return "(Kunde inte hämta bot-medlemmen — hoppar över.)";
  }
  return null;
}

export async function runAudit(guildId) {
  const ctx = await gatherContext(guildId);

  const categories = [];
  for (const check of CHECKS) {
    const skip = check.needs ? skipNote(check.needs, ctx) : null;
    const { items = [], note = null } = skip
      ? { items: [skip] }
      : ((await check.run(ctx)) ?? {});
    categories.push({
      id: check.id,
      title: typeof check.title === "function" ? check.title(ctx) : check.title,
      items,
      note,
    });
  }

  const totals = { issues: 0, byCategory: {}, affectedUsers: 0 };
  const affected = new Set();
  for (const c of categories) {
    c.count = c.items.filter((i) => !isSkipNote(i)).length;
    totals.byCategory[c.id] = c.count;
    totals.issues += c.count;
    // How many *people* the findings are about. One person can appear in four
    // categories, so a finding count alone reads as an emergency when the truth
    // is two members needing to act. Pulled out of the item text because the
    // mention format is fixed and the alternative is threading a second number
    // through thirteen checks.
    for (const item of c.items) {
      for (const m of item.matchAll(/<@([^>]+)>/g)) affected.add(m[1]);
    }
  }
  totals.affectedUsers = affected.size;

  // Display names for the plain-text report, which cannot render a mention.
  const names = {};
  for (const m of ctx.guildMembers) names[m.user.id] = displayName(m);

  return {
    generated_at: new Date().toISOString(),
    meta: {
      guildMembers: ctx.guildMembers.length,
      linkedUsers: ctx.linkedUsers.length,
      participants: ctx.participants
        ? Object.keys(ctx.participants).length
        : null,
    },
    categories,
    totals,
    names,
  };
}

/** "3 medlemmar · 2 länkade · 2 i ScoutNet" — the header both formats share. */
function metaLine({ guildMembers, linkedUsers, participants }) {
  const parts = [`${guildMembers} medlemmar`, `${linkedUsers} länkade`];
  if (participants != null) parts.push(`${participants} i ScoutNet`);
  return parts.join(" · ");
}

/** The report as a Discord message, where markup and mentions render. */
export function formatAuditMarkdown(audit) {
  const lines = [
    "**Audit-rapport för ScoutID-länkningar**",
    metaLine(audit.meta),
    "",
  ];

  if (audit.totals.issues === 0) {
    lines.push("✅ Inga avvikelser hittades.");
    const skipped = audit.categories.filter((c) => c.items.some(isSkipNote));
    if (skipped.length > 0) {
      lines.push("", `_Skippade: ${skipped.map((c) => c.title).join(", ")}_`);
    }
    return lines.join("\n").trimEnd();
  }

  lines.push(
    `Hittade **${audit.totals.issues}** fynd hos **${audit.totals.affectedUsers}** personer:`,
    "",
  );
  for (const c of audit.categories.filter((c) => c.count > 0)) {
    lines.push(`__${c.title}__ — ${c.count}`);
    lines.push(...c.items.filter((i) => !isSkipNote(i)));
    if (c.note) lines.push(`_${c.note}_`);
    lines.push("");
  }

  // A note on a category with nothing wrong still belongs in the report: "17 are
  // fine and here is why" is the sentence that stops someone acting on a number
  // they misread.
  for (const c of audit.categories) {
    if (c.count === 0 && c.note) lines.push(`_${c.note}_`);
  }

  return lines.join("\n").trimEnd();
}

/**
 * The same report as plain text, for the file attachment.
 *
 * An attachment renders nothing, so markup would arrive as literal `__…__` and
 * mentions as raw numeric ids — unreadable exactly when the report is long
 * enough to need reading. Names are resolved from `audit.names` instead.
 */
export function formatAuditText(audit) {
  const strip = (t) =>
    t
      .replace(/<@([^>]+)>/g, (_, id) => audit.names?.[id] ?? `användare ${id}`)
      .replace(/\*+/g, "")
      .replace(/__/g, "")
      .replace(/`/g, "")
      // Items spell out `<@id> (nickname)` because a rendered mention shows the
      // account name, not the server nickname. Resolved, they are the same
      // string twice.
      .replace(/([^\s()][^()]*) \(\1\)/g, "$1")
      .replace(/^- /, "  · ");

  const lines = [
    "AUDIT-RAPPORT FÖR SCOUTID-LÄNKNINGAR",
    "",
    metaLine(audit.meta),
  ];
  lines.push(
    "",
    audit.totals.issues === 0
      ? "Inga avvikelser hittades."
      : `${audit.totals.issues} fynd hos ${audit.totals.affectedUsers} personer:`,
  );

  for (const c of audit.categories) {
    if (c.count === 0 && !c.note) continue;
    lines.push("");
    if (c.count > 0) {
      const heading = `${strip(c.title)} (${c.count})`;
      lines.push(heading, "-".repeat(heading.length));
      lines.push(...c.items.filter((i) => !isSkipNote(i)).map(strip));
    }
    if (c.note) lines.push(`  (${strip(c.note)})`);
  }

  return lines.join("\n").trimEnd() + "\n";
}

/** One-line-plus-bullets digest, for a caller that wants the shape not the detail. */
export function summarizeAudit(audit) {
  const head = `${metaLine(audit.meta)} · ${audit.totals.issues} fynd hos ${audit.totals.affectedUsers} personer`;
  const topIssues = audit.categories
    .filter((c) => c.count > 0)
    .map((c) => `• ${c.title}: ${c.count}`);
  return topIssues.length === 0
    ? `${head} ✅`
    : `${head}\n${topIssues.join("\n")}`;
}
