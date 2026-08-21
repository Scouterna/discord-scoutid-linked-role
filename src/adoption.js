import config from "./config.js";
import * as scoutnet from "./scoutnet.js";
import * as storage from "./storage.js";

/**
 * Adoption: how many registered participants have actually linked, per group.
 *
 * **Nothing here knows what a `deltagare` or a `cmt` is.** The grouping falls out
 * of the three config maps, which is what makes it survive a reorganisation:
 *
 *   SCOUTNET_FEE_ROLES      fee_id → category
 *   SCOUTNET_DIVISION_ROLES category → question + role patterns
 *   SCOUTNET_CATEGORY_ROLES category → flat role name, used here as the label
 *
 * A category with a division config splits by the answer to its question; one
 * without is a single group. So the day a division config is added for a category
 * that lacks one, the split appears with no code change — which is the whole
 * reason not to special-case anything.
 *
 * The labels are the configured *role* names, so the report speaks the same
 * vocabulary as Discord rather than inventing a second one.
 */

/** Zero-padded the same way `getDesiredRoles` pads it, or the roles would not match. */
const pad = (d) => String(d).padStart(2, "0");

/** What to call a category in a heading: its flat role if it has one, else its key. */
function categoryLabel(cfg, category) {
  return cfg.SCOUTNET_CATEGORY_ROLES?.[category] ?? category;
}

/**
 * Which group does this participant belong to? Returns the label only — the
 * caller does the counting.
 */
function groupLabel(cfg, category, participant) {
  const divConfig = cfg.SCOUTNET_DIVISION_ROLES?.[category];
  if (!divConfig) return categoryLabel(cfg, category);
  const answer = participant.questions?.[divConfig.questionId];
  return answer
    ? divConfig.withDiv.replace("{div}", pad(answer))
    : divConfig.withoutDiv;
}

/**
 * Count registered against linked, per group.
 *
 * `participants` is ScoutNet's map keyed by member number, and `linkedScoutIds`
 * is the set of scoutids in storage — the join works directly because a scoutid
 * *is* a ScoutNet member number.
 *
 * `cfg` defaults to the live config and exists so a test can prove the claim in
 * the header: give a category a division config and it splits, take it away and
 * it collapses, with no code change either way. That property is the whole design
 * and it is not observable without being able to vary the config.
 */
export function computeAdoption({
  participants,
  linkedScoutIds,
  cfg = config,
}) {
  const cats = new Map();
  let total = 0;
  let linked = 0;
  const unmapped = [];

  for (const [memberNo, p] of Object.entries(participants ?? {})) {
    if (scoutnet.isCancelled(p)) continue;
    const category = cfg.SCOUTNET_FEE_ROLES?.[String(p.fee_id)];
    const isLinked = linkedScoutIds.has(String(memberNo));
    total++;
    if (isLinked) linked++;

    if (!category) {
      // Not dropped silently: an unmapped fee means these people get no category
      // role at all, which is worth seeing next to the coverage numbers.
      unmapped.push({
        name: `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim(),
        memberNo,
        feeId: p.fee_id ?? null,
        linked: isLinked,
      });
      continue;
    }

    if (!cats.has(category)) {
      cats.set(category, {
        category,
        label: categoryLabel(cfg, category),
        groups: new Map(),
      });
    }
    const groups = cats.get(category).groups;
    const label = groupLabel(cfg, category, p);
    if (!groups.has(label))
      groups.set(label, { label, total: 0, linked: 0, missing: [] });
    const g = groups.get(label);
    g.total++;
    if (isLinked) g.linked++;
    else
      g.missing.push({
        name: `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim(),
        memberNo,
      });
  }

  const categories = [...cats.values()].map((c) => {
    const groups = [...c.groups.values()].sort((a, b) =>
      a.label.localeCompare(b.label, "sv"),
    );
    return {
      ...c,
      groups,
      total: groups.reduce((n, g) => n + g.total, 0),
      linked: groups.reduce((n, g) => n + g.linked, 0),
    };
  });
  categories.sort((a, b) => a.label.localeCompare(b.label, "sv"));

  return { total, linked, categories, unmapped };
}

/** Reads the live data and computes. Kept apart so the maths is testable without a network. */
export async function runAdoption() {
  const [participants, linkedUsers] = await Promise.all([
    scoutnet.getParticipants(),
    storage.getAllLinkedUsers(),
  ]);
  return computeAdoption({
    participants,
    linkedScoutIds: new Set(linkedUsers.map((u) => String(u.scoutId))),
  });
}

const pct = (linked, total) =>
  total === 0 ? "–" : `${Math.round((linked / total) * 100)}%`;

/**
 * Plain text, for the attachment. Discord renders nothing in a file, and this
 * report is far past the 2000-character limit the moment there is more than one
 * category — 130 groups at full size.
 */
export function formatAdoptionText(result, { includeMissing = false } = {}) {
  const lines = ["ADOPTION — LÄNKADE AV ANMÄLDA", ""];
  lines.push(
    `${result.total} anmälda · ${result.linked} länkade · ${pct(result.linked, result.total)}`,
  );

  for (const c of result.categories) {
    lines.push("");
    const head = `${c.label}: ${c.linked}/${c.total} (${pct(c.linked, c.total)})`;
    lines.push(head);
    lines.push("-".repeat(head.length));
    for (const g of c.groups) {
      lines.push(
        `  ${g.label.padEnd(22)} ${String(g.linked).padStart(4)}/${String(g.total).padEnd(5)} ${pct(g.linked, g.total).padStart(4)}`,
      );
    }
  }

  if (result.unmapped.length > 0) {
    lines.push("");
    const head = `Utan mappad fee_id: ${result.unmapped.length}`;
    lines.push(head);
    lines.push("-".repeat(head.length));
    lines.push("  Dessa får ingen kategori-, division- eller smeknamnsroll.");
    for (const u of result.unmapped) {
      lines.push(`  · ${u.name} (${u.memberNo}) fee_id=${u.feeId}`);
    }
  }

  if (includeMissing) {
    lines.push("", "SAKNAS", "======");
    for (const c of result.categories) {
      for (const g of c.groups) {
        if (g.missing.length === 0) continue;
        lines.push("", `${g.label} — ${g.missing.length} saknas`);
        for (const m of g.missing) lines.push(`  · ${m.name} (${m.memberNo})`);
      }
    }
  }

  return lines.join("\n").trimEnd() + "\n";
}

/** One line per category, for the inline reply. */
export function formatAdoptionSummary(result) {
  const lines = [
    `**Adoption** — ${result.linked} av ${result.total} anmälda har länkat sig (${pct(result.linked, result.total)})`,
  ];
  for (const c of result.categories) {
    lines.push(
      `• ${c.label}: ${c.linked}/${c.total} (${pct(c.linked, c.total)})`,
    );
  }
  if (result.unmapped.length > 0) {
    lines.push(`⚠️ ${result.unmapped.length} utan mappad \`fee_id\``);
  }
  return lines.join("\n");
}
