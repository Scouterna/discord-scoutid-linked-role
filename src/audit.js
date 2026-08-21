import config from "./config.js";
import * as discord from "./discord.js";
import * as scoutnet from "./scoutnet.js";
import * as storage from "./storage.js";
import * as roles from "./roles.js";
import { RELINK_INSTRUCTION, verifyConnection } from "./metadata.js";

/**
 * Server consistency audit.
 *
 * Collects all relevant Discord/ScoutNet/storage data once, then runs a
 * series of checks. Returns a structured report with both detail items and
 * counts so callers can render it as a full report or a short summary.
 */

const SCOUT_ROLE_FALLBACK = "scout";

function normalizeName(s) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

/**
 * Static role names the bot might attempt to assign (excludes per-division names).
 */
function staticManagedRoleNames() {
  const names = new Set();
  if (config.SCOUTNET_SCOUT_ROLE) names.add(config.SCOUTNET_SCOUT_ROLE);
  if (config.SCOUTNET_EVENT_ID && config.SCOUTNET_EVENT_ROLE) {
    names.add(config.SCOUTNET_EVENT_ROLE);
  }
  if (config.SCOUTNET_EVENT_ID && config.SCOUTNET_FEE_ROLES) {
    for (const category of new Set(Object.values(config.SCOUTNET_FEE_ROLES))) {
      const flatRole = config.SCOUTNET_CATEGORY_ROLES?.[category];
      if (flatRole) names.add(flatRole);

      const divConfig = config.SCOUTNET_DIVISION_ROLES?.[category];
      if (divConfig) {
        names.add(divConfig.withoutDiv);
      } else {
        names.add(category);
      }
    }
  }
  return [...names];
}

/**
 * Parse a "(suffix)" trailing token from a display name.
 */
function extractSuffix(name) {
  const m = (name || "").match(/\s*\(([^()]*)\)\s*$/);
  return m ? m[1] : null;
}

/**
 * Compute desired division role names per category for the set of divisions
 * that actually occur in current ScoutNet data. Returns Map<categoryKey, Set<roleName>>.
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
    if (!category) continue;
    const divConfig = config.SCOUTNET_DIVISION_ROLES?.[category];
    if (!divConfig) continue;
    const division = p.questions?.[divConfig.questionId];
    if (!division) continue;
    const padded = String(division).padStart(2, "0");
    expected.get(category).add(divConfig.withDiv.replace("{div}", padded));
  }
  return expected;
}

export async function runAudit(guildId) {
  const [guildMembers, guildRoles, linkedUsers, participants, botMember] =
    await Promise.all([
      discord.getGuildMembers(guildId),
      discord.getGuildRoles(guildId),
      storage.getAllLinkedUsers(),
      config.SCOUTNET_EVENT_ID ? scoutnet.getParticipants() : null,
      discord.getBotMember(guildId).catch(() => null),
    ]);

  const roleMap = new Map();
  for (const r of guildRoles) roleMap.set(r.name.toLowerCase(), r);
  const roleById = new Map(guildRoles.map((r) => [r.id, r]));

  const linkedMap = new Map(
    linkedUsers.map((u) => [u.discordUserId, u.scoutId]),
  );
  const memberMap = new Map(guildMembers.map((m) => [m.user.id, m]));

  const scoutRoleName = config.SCOUTNET_SCOUT_ROLE || SCOUT_ROLE_FALLBACK;
  const scoutRole = roleMap.get(scoutRoleName.toLowerCase());

  const botRoles = botMember
    ? botMember.roles.map((id) => roleById.get(id)).filter(Boolean)
    : [];
  const botHighestPosition = botRoles.reduce(
    (max, r) => Math.max(max, r.position),
    0,
  );
  // True if the bot can modify this member (member has no role at/above bot)
  const canBotModify = (member) =>
    !member.roles.some(
      (id) => (roleById.get(id)?.position ?? 0) >= botHighestPosition,
    );

  const categories = [];

  // --- 1. Has Scout role but no storage link ---
  {
    const items = [];
    if (!scoutRole) {
      items.push(`(Rollen \`${scoutRoleName}\` finns inte i guilden.)`);
    } else {
      const orphans = guildMembers.filter(
        (m) => m.roles.includes(scoutRole.id) && !linkedMap.has(m.user.id),
      );
      for (const m of orphans) {
        const name = m.nick || m.user.global_name || m.user.username;
        items.push(`- <@${m.user.id}> (${name})`);
      }
    }
    categories.push({
      id: "scout_role_no_link",
      title: `Har \`${scoutRoleName}\`-rollen men ingen storage-länk`,
      items,
    });
  }

  // --- 1b. Länkade men saknar Scout-rollen ---
  // Discord Linked Role har fallit bort (avkopplat appen, lämnat servern, metadata-utgång).
  // Vid nästa /refresh-scoutid får dessa sina roller borttagna och Overifierad satt.
  {
    const items = [];
    let note = null;
    if (!scoutRole) {
      items.push(`(Rollen \`${scoutRoleName}\` finns inte i guilden.)`);
    } else {
      // The gate takes two proofs, so the missing role is only half a question —
      // and asking half of it made this category list 17 people who were in no
      // danger whatsoever, with identical advice none of them needed. An audit
      // that reports a non-problem as loudly as a problem is one nobody reads.
      //
      // So ask the other half. `verifyConnection` is a GET, which keeps the audit
      // read-only, and it only runs for members who lack the role — at most a
      // handful once the migration has settled.
      let carried = 0;
      for (const u of linkedUsers) {
        const member = memberMap.get(u.discordUserId);
        if (!member) continue;
        if (member.roles.includes(scoutRole.id)) continue;
        const connection = await verifyConnection(u.discordUserId);
        if (connection.status === "accepted") {
          carried++;
          continue;
        }
        const name =
          member.nick || member.user.global_name || member.user.username;
        const why =
          connection.status === "unknown"
            ? `kunde inte avgöra kopplingen (${connection.detail})`
            : `kopplingen är död (${connection.detail})`;
        items.push(
          `- <@${u.discordUserId}> (${name}) scoutid=\`${u.scoutId}\` — ${why}, be hen ${RELINK_INSTRUCTION}`,
        );
      }
      if (carried > 0) {
        note = `${carried} till saknar rollen men är verifierade via sin Discord-koppling — de påverkas inte, och får rollen när de nästa gång länkar om.`;
      }
    }
    categories.push({
      id: "linked_no_scout_role",
      title: "Saknar Scout-rollen *och* har ingen giltig Discord-koppling",
      items,
      note,
    });
  }

  // --- 1c. Länkade utan sparade OAuth-tokens ---
  // Länken räcker för att sätta roller och smeknamn, men inte för att prata med
  // Discord i användarens namn. Utan Discord-tokenet kan `updateMetadata` inte
  // pusha Linked Role-metadata, vilket är det som får Discord att (åter)ge
  // Scout-rollen. Konsekvensen är tyst: allt fungerar tills Scout-rollen faller
  // bort, och då kan varken admin eller bot laga det — personen måste själv
  // köra om `/linked-role`.
  //
  // Det här är precis vad Redis-wipen 2026-05-26 lämnade efter sig: länkar och
  // tokens försvann tillsammans, och `/link-scoutid` återskapar bara länken.
  {
    const items = [];
    let discordTokenIds;
    try {
      discordTokenIds = await storage.getUserIdsWithTokens("discord-token");
    } catch (e) {
      items.push(`(Kunde inte läsa tokens: ${e.message})`);
    }
    if (discordTokenIds) {
      for (const u of linkedUsers) {
        if (discordTokenIds.has(u.discordUserId)) continue;
        const member = memberMap.get(u.discordUserId);
        const name = member
          ? member.nick || member.user.global_name || member.user.username
          : "ej i guilden";
        items.push(
          `- <@${u.discordUserId}> (${name}) scoutid=\`${u.scoutId}\` — be hen ${RELINK_INSTRUCTION}. \`/link-scoutid\` lagar inte det här, och utan token finns inget andra bevis heller`,
        );
      }
    }
    categories.push({
      id: "linked_no_tokens",
      title:
        "Länkade utan sparade Discord-tokens — botten kan inte re-pusha Linked Role-metadata",
      items,
    });
  }

  // --- 2. Storage link but not in guild ---
  {
    const stale = linkedUsers.filter((u) => !memberMap.has(u.discordUserId));
    const items = stale.map(
      (u) => `- discord=\`${u.discordUserId}\` scoutid=\`${u.scoutId}\``,
    );
    categories.push({
      id: "stale_link",
      title: "Storage-länk men inte (längre) medlem i guilden",
      items,
    });
  }

  // --- 3. Linked but cancelled in ScoutNet ---
  {
    const items = [];
    if (!participants) {
      items.push("(SCOUTNET_EVENT_ID inte satt — hoppar över.)");
    } else {
      for (const u of linkedUsers) {
        const p = participants[u.scoutId];
        if (scoutnet.isCancelled(p)) {
          const name =
            [p.first_name, p.last_name].filter(Boolean).join(" ") || "?";
          items.push(
            `- <@${u.discordUserId}> scoutid=\`${u.scoutId}\` ${name} (avbokad ${scoutnet.cancelledLabel(p)})`,
          );
        }
      }
    }
    categories.push({
      id: "cancelled",
      title: "Länkad men avbokad i ScoutNet",
      items,
    });
  }

  // --- 4. Name mismatch Discord vs ScoutNet ---
  {
    const items = [];
    if (!participants) {
      items.push("(SCOUTNET_EVENT_ID inte satt — hoppar över.)");
    } else {
      for (const u of linkedUsers) {
        const member = memberMap.get(u.discordUserId);
        const p = participants[u.scoutId];
        if (!member || !p || scoutnet.isCancelled(p)) continue;
        if (!p.first_name && !p.last_name) continue;

        const rawDisplay =
          member.nick || member.user.global_name || member.user.username || "";
        const displayClean = rawDisplay.replace(/\s*\(.*\)\s*$/, "");
        const display = normalizeName(displayClean);
        const first = normalizeName(p.first_name || "");
        const last = normalizeName(p.last_name || "");
        if (
          (!first || display.includes(first)) &&
          (!last || display.includes(last))
        ) {
          continue;
        }
        items.push(
          `- <@${u.discordUserId}> scoutid=\`${u.scoutId}\` Discord="${displayClean}" ScoutNet="${[p.first_name, p.last_name].filter(Boolean).join(" ")}"`,
        );
      }
    }
    categories.push({
      id: "name_mismatch",
      title: "Möjlig fellänkning — namn matchar inte",
      items,
    });
  }

  // --- A1a. Statiska roller som boten kan tilldela men som inte finns i guilden ---
  {
    const items = [];
    for (const name of staticManagedRoleNames()) {
      if (!roleMap.has(name.toLowerCase())) {
        items.push(`- \`${name}\``);
      }
    }
    categories.push({
      id: "missing_static_roles",
      title: "Konfigurerade roller som saknas i Discord (statiska)",
      items,
    });
  }

  // --- A1b. Division-roller som behövs men saknas (baserat på faktiska ScoutNet-värden) ---
  {
    const items = [];
    if (!participants) {
      items.push("(SCOUTNET_EVENT_ID inte satt — hoppar över.)");
    } else {
      const expected = expectedDivisionRoleNames(participants);
      for (const [category, names] of expected) {
        const missing = [...names].filter((n) => !roleMap.has(n.toLowerCase()));
        if (missing.length > 0) {
          items.push(`- ${category}: ${missing.sort().join(", ")}`);
        }
      }
    }
    categories.push({
      id: "missing_division_roles",
      title:
        "Division-roller som ScoutNet refererar till men som saknas i Discord",
      items,
    });
  }

  // --- A1c. fee_id i ScoutNet som inte är konfigurerade ---
  {
    const items = [];
    if (!participants) {
      items.push("(SCOUTNET_EVENT_ID inte satt — hoppar över.)");
    } else if (!config.SCOUTNET_FEE_ROLES) {
      items.push("(SCOUTNET_FEE_ROLES inte konfigurerad — hoppar över.)");
    } else {
      const seen = new Map(); // fee_id → count
      for (const p of Object.values(participants)) {
        if (scoutnet.isCancelled(p)) continue;
        if (p?.fee_id == null) continue;
        const fid = String(p.fee_id);
        if (!config.SCOUTNET_FEE_ROLES[fid]) {
          seen.set(fid, (seen.get(fid) || 0) + 1);
        }
      }
      for (const [fid, count] of [...seen.entries()].sort()) {
        items.push(
          `- fee_id=\`${fid}\` (${count} deltagare) — saknas i SCOUTNET_FEE_ROLES`,
        );
      }
    }
    categories.push({
      id: "unknown_fee_ids",
      title: "Okända fee_id i ScoutNet (behöver konfigureras)",
      items,
    });
  }

  // --- A2. Bot-roll vs hierarki ---
  {
    const items = [];
    if (!botMember) {
      items.push("(Kunde inte hämta bot-medlemmen — hoppar över.)");
    } else {
      // Compute managed role names (incl. division roles from data)
      const managedNames = new Set(
        staticManagedRoleNames().map((n) => n.toLowerCase()),
      );
      if (participants) {
        for (const names of expectedDivisionRoleNames(participants).values()) {
          for (const n of names) managedNames.add(n.toLowerCase());
        }
      }

      for (const lower of managedNames) {
        const r = roleMap.get(lower);
        if (!r) continue; // already flagged in A1a/A1b
        if (r.position >= botHighestPosition) {
          items.push(
            `- \`${r.name}\` (position ${r.position}) ligger på eller över botens högsta position (${botHighestPosition})`,
          );
        }
      }

      // Aggregate bot permissions across its roles
      let perms = 0n;
      for (const r of botRoles) {
        try {
          perms |= BigInt(r.permissions);
        } catch {
          // ignore parse errors
        }
      }
      const ADMIN = 1n << 3n;
      const MANAGE_ROLES = 1n << 28n;
      const MANAGE_NICKNAMES = 1n << 27n;
      const isAdmin = (perms & ADMIN) === ADMIN;
      if (!isAdmin) {
        if ((perms & MANAGE_ROLES) !== MANAGE_ROLES) {
          items.push("- Bot saknar MANAGE_ROLES");
        }
        if ((perms & MANAGE_NICKNAMES) !== MANAGE_NICKNAMES) {
          items.push("- Bot saknar MANAGE_NICKNAMES");
        }
      }
    }
    categories.push({
      id: "bot_permissions",
      title: "Bot-rollens hierarki och behörigheter",
      items,
    });
  }

  // --- B3. Drift mellan faktiska och önskade roller (dry-run sync) ---
  {
    const items = [];
    if (!participants) {
      items.push("(SCOUTNET_EVENT_ID inte satt — hoppar över.)");
    } else {
      for (const u of linkedUsers) {
        const member = memberMap.get(u.discordUserId);
        if (!member) continue;
        // Skip users the bot can't modify (admins/mods above bot) — would be false positives
        if (botMember && !canBotModify(member)) continue;
        let desired;
        try {
          desired = await roles.getDesiredRoles(u.scoutId);
        } catch {
          continue;
        }
        const desiredLower = new Set(desired.map((n) => n.toLowerCase()));
        const currentRoleNames = (member.roles || [])
          .map((id) => roleById.get(id)?.name)
          .filter(Boolean);

        const missing = desired.filter((n) => {
          const r = roleMap.get(n.toLowerCase());
          if (!r) return false;
          if (r.managed) return false; // managed roles can't be assigned by our bot
          return !member.roles.includes(r.id);
        });

        // For removals we only consider roles the bot manages
        const managedStatic = new Set(
          staticManagedRoleNames().map((n) => n.toLowerCase()),
        );
        const divPrefixes = Object.values(config.SCOUTNET_DIVISION_ROLES || {})
          .map((d) => {
            const idx = d.withDiv.indexOf("{div}");
            return idx >= 0 ? d.withDiv.substring(0, idx).toLowerCase() : null;
          })
          .filter(Boolean);

        const extra = currentRoleNames.filter((n) => {
          const lower = n.toLowerCase();
          if (desiredLower.has(lower)) return false;
          const r = roleMap.get(lower);
          if (r?.managed) return false; // can't remove managed roles
          if (managedStatic.has(lower)) return true;
          return divPrefixes.some((p) => lower.startsWith(p));
        });

        if (missing.length > 0 || extra.length > 0) {
          const parts = [];
          if (missing.length > 0) parts.push(`saknar: ${missing.join(", ")}`);
          if (extra.length > 0)
            parts.push(`har felaktigt: ${extra.join(", ")}`);
          items.push(`- <@${u.discordUserId}> — ${parts.join(" · ")}`);
        }
      }
    }
    categories.push({
      id: "role_drift",
      title: "Drift mellan faktiska och önskade roller",
      items,
    });
  }

  // --- B4. Användare med flera division-roller i samma kategori ---
  {
    const items = [];
    const divPrefixes = Object.entries(config.SCOUTNET_DIVISION_ROLES || {})
      .map(([cat, d]) => {
        const idx = d.withDiv.indexOf("{div}");
        return idx >= 0
          ? { category: cat, prefix: d.withDiv.substring(0, idx).toLowerCase() }
          : null;
      })
      .filter(Boolean);

    for (const m of guildMembers) {
      const byCategory = new Map();
      for (const id of m.roles) {
        const r = roleById.get(id);
        if (!r) continue;
        const lower = r.name.toLowerCase();
        for (const { category, prefix } of divPrefixes) {
          if (lower.startsWith(prefix)) {
            if (!byCategory.has(category)) byCategory.set(category, []);
            byCategory.get(category).push(r.name);
          }
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
    categories.push({
      id: "multiple_division_roles",
      title: "Användare med flera division-roller i samma kategori",
      items,
    });
  }

  // --- B5. Fel nickname-suffix ---
  {
    const items = [];
    if (!participants) {
      items.push("(SCOUTNET_EVENT_ID inte satt — hoppar över.)");
    } else {
      for (const u of linkedUsers) {
        const member = memberMap.get(u.discordUserId);
        if (!member) continue;
        let expectedSuffix;
        try {
          expectedSuffix = await roles.getNicknameSuffix(u.scoutId);
        } catch {
          continue;
        }
        // expectedSuffix is " (X)" or ""; extract just X
        const expectedToken = expectedSuffix
          ? (expectedSuffix.match(/\(([^()]*)\)/)?.[1] ?? null)
          : null;

        const display =
          member.nick || member.user.global_name || member.user.username || "";
        const actualToken = extractSuffix(display);

        if ((expectedToken || "") !== (actualToken || "")) {
          items.push(
            `- <@${u.discordUserId}> nick="${display}" — har "${actualToken ?? "(inget)"}" förväntat "${expectedToken ?? "(inget)"}"`,
          );
        }
      }
    }
    categories.push({
      id: "wrong_nickname_suffix",
      title: "Användare med fel nickname-suffix",
      items,
    });
  }

  // Filter out the placeholder "skipped" items from being counted as issues
  const issueCount = (items) => items.filter((i) => !i.startsWith("(")).length;

  const totals = {
    issues: 0,
    byCategory: {},
    // How many *people* the findings are about. `issues` counts findings, and one
    // person can appear in four categories — so 23 findings read as an emergency
    // when the truth was two members needing to act. Pulled out of the item text
    // rather than threaded through every category: the mention format is fixed,
    // and the alternative is restructuring thirteen builders for one number.
    affectedUsers: 0,
  };
  const affected = new Set();
  for (const c of categories) {
    const n = issueCount(c.items);
    c.count = n;
    totals.byCategory[c.id] = n;
    totals.issues += n;
    for (const item of c.items) {
      for (const m of item.matchAll(/<@([^>]+)>/g)) affected.add(m[1]);
    }
  }
  totals.affectedUsers = affected.size;

  // Display names for every member, so the plain-text report can say who someone
  // is instead of `<@1013377192023040000>`. Discord renders mentions; a .txt
  // attachment does not, and that is the form the report takes exactly when it is
  // long enough to matter.
  const names = {};
  for (const m of guildMembers) {
    names[m.user.id] = m.nick || m.user.global_name || m.user.username;
  }

  return {
    generated_at: new Date().toISOString(),
    meta: {
      guildMembers: guildMembers.length,
      linkedUsers: linkedUsers.length,
      participants: participants ? Object.keys(participants).length : null,
    },
    categories,
    totals,
    names,
  };
}

export function formatAuditMarkdown(audit) {
  const lines = [];
  lines.push("**Audit-rapport för ScoutID-länkningar**");
  const m = audit.meta;
  const parts = [`${m.guildMembers} medlemmar`, `${m.linkedUsers} länkade`];
  if (m.participants != null) parts.push(`${m.participants} i ScoutNet`);
  lines.push(parts.join(" · "));
  lines.push("");

  if (audit.totals.issues === 0) {
    lines.push("✅ Inga avvikelser hittades.");
    const skipped = audit.categories.filter((c) =>
      c.items.some((i) => i.startsWith("(")),
    );
    if (skipped.length > 0) {
      lines.push("");
      lines.push(`_Skippade: ${skipped.map((c) => c.title).join(", ")}_`);
    }
    return lines.join("\n").trimEnd();
  }

  lines.push(
    `Hittade **${audit.totals.issues}** fynd hos **${audit.totals.affectedUsers}** personer:`,
  );
  lines.push("");

  const withIssues = audit.categories.filter((c) => c.count > 0);
  for (const c of withIssues) {
    lines.push(`__${c.title}__ — ${c.count}`);
    for (const item of c.items) {
      if (item.startsWith("(")) continue;
      lines.push(item);
    }
    if (c.note) lines.push(`_${c.note}_`);
    lines.push("");
  }

  // Notes on categories with nothing wrong still belong in the report: "17 are
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
 * Discord renders `**bold**` and turns `<@123>` into a name — in a *message*. The
 * report becomes a `.txt` attachment as soon as it passes 2000 characters, and an
 * attachment renders nothing: it arrives as literal `__…__` and raw numeric ids,
 * unreadable exactly when it is long enough to need reading.
 *
 * So the file gets its own rendering: names resolved from `audit.names`, markup
 * stripped, headings underlined with dashes.
 */
export function formatAuditText(audit) {
  const strip = (t) =>
    t
      .replace(/<@([^>]+)>/g, (_, id) => audit.names?.[id] ?? `användare ${id}`)
      // Single `*` as well as `**`: several titles use it for emphasis, and it
      // survived the first version of this as literal asterisks.
      .replace(/\*+/g, "")
      .replace(/__/g, "")
      .replace(/`/g, "")
      // The items spell out `<@id> (nickname)` because a rendered mention shows
      // the *account* name, not the server nickname. Resolved to a name they are
      // usually the same string twice.
      .replace(/([^\s()][^()]*) \(\1\)/g, "$1")
      .replace(/^- /, "  · ");

  const m = audit.meta;
  const lines = ["AUDIT-RAPPORT FÖR SCOUTID-LÄNKNINGAR", ""];
  const head = [`${m.guildMembers} medlemmar`, `${m.linkedUsers} länkade`];
  if (m.participants != null) head.push(`${m.participants} i ScoutNet`);
  lines.push(head.join(" · "));

  if (audit.totals.issues === 0) {
    lines.push("", "Inga avvikelser hittades.");
  } else {
    lines.push(
      "",
      `${audit.totals.issues} fynd hos ${audit.totals.affectedUsers} personer:`,
    );
  }

  for (const c of audit.categories) {
    if (c.count === 0 && !c.note) continue;
    lines.push("");
    if (c.count > 0) {
      const heading = `${strip(c.title)} (${c.count})`;
      lines.push(heading);
      lines.push("-".repeat(heading.length));
      for (const item of c.items) {
        if (item.startsWith("(")) continue;
        lines.push(strip(item));
      }
    }
    if (c.note) lines.push(`  (${strip(c.note)})`);
  }

  return lines.join("\n").trimEnd() + "\n";
}

export function summarizeAudit(audit) {
  const m = audit.meta;
  const parts = [`${m.guildMembers} medlemmar`, `${m.linkedUsers} länkade`];
  if (m.participants != null) parts.push(`${m.participants} i ScoutNet`);
  parts.push(
    `${audit.totals.issues} fynd hos ${audit.totals.affectedUsers} personer`,
  );

  const topIssues = audit.categories
    .filter((c) => c.count > 0)
    .map((c) => `${c.title}: ${c.count}`);

  const head = parts.join(" · ");
  if (topIssues.length === 0) return `${head} ✅`;
  return `${head}\n${topIssues.map((t) => `• ${t}`).join("\n")}`;
}
