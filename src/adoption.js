import config from "./config.js";
import * as scoutnet from "./scoutnet.js";
import * as storage from "./storage.js";
import { divisionRoleName } from "./guild.js";

/**
 * Adoption: how many registered participants have actually linked, per group.
 *
 * **Nothing here knows what a `deltagare` or a `cmt` is.** The grouping falls
 * out of the three config maps, which is what makes it survive a
 * reorganisation:
 *
 *   SCOUTNET_FEE_ROLES      fee_id → category
 *   SCOUTNET_DIVISION_ROLES category → question + role patterns
 *   SCOUTNET_CATEGORY_ROLES category → flat role name, used here as the label
 *
 * A category with a division config splits by the answer to its question; one
 * without is a single group. Give a category a division config and the split
 * appears with no code change, which is the reason not to special-case anything.
 *
 * The labels are the configured *role* names, so the report speaks the same
 * vocabulary as Discord rather than inventing a second one.
 */

/** A category's heading: its flat role if it has one, else its config key. */
const categoryLabel = (cfg, category) =>
  cfg.SCOUTNET_CATEGORY_ROLES?.[category] ?? category;

/** Which group this participant falls in — the label only; the caller counts. */
function groupLabel(cfg, category, participant) {
  const divConfig = cfg.SCOUTNET_DIVISION_ROLES?.[category];
  if (!divConfig) return categoryLabel(cfg, category);
  return divisionRoleName(
    divConfig,
    participant.questions?.[divConfig.questionId],
  );
}

/**
 * Count registered against linked, per group.
 *
 * `participants` is ScoutNet's map keyed by member number and `linkedUsers` is
 * what storage holds — the join works directly because a scoutid *is* a ScoutNet
 * member number.
 *
 * **Everyone who lands in no group is counted under `outside`, by reason.** The
 * groups alone answer "how many have linked" while quietly leaving out whoever
 * the grouping could not place, and those are the people something is wrong for:
 * a coverage report that hides them reads as complete when it is not. The four
 * reasons are different problems with different owners, so they are counted
 * apart rather than as one "övrigt".
 *
 * `cfg` defaults to the live config so a test can vary it: the claim in the
 * header is not observable otherwise.
 */
export function computeAdoption({
  participants,
  linkedUsers = [],
  cfg = config,
}) {
  const linkedScoutIds = new Set(linkedUsers.map((u) => String(u.scoutId)));
  const cats = new Map();
  let total = 0;
  let linked = 0;

  const outside = {
    cancelled: [],
    noFee: [],
    unmappedFee: [],
    notRegistered: [],
  };

  for (const [memberNo, p] of Object.entries(participants ?? {})) {
    const isLinked = linkedScoutIds.has(String(memberNo));
    const person = { name: scoutnet.fullName(p), memberNo, linked: isLinked };

    // Outside `total` as well as outside the groups: a withdrawn registration is
    // not someone we are waiting for, so counting them would depress the
    // coverage figure with people who are not missing.
    if (scoutnet.isCancelled(p)) {
      outside.cancelled.push({ ...person, when: scoutnet.cancelledLabel(p) });
      continue;
    }

    total++;
    if (isLinked) linked++;

    const category = cfg.SCOUTNET_FEE_ROLES?.[String(p.fee_id)];
    if (!category) {
      // Two different faults that look alike in the data. No `fee_id` at all is
      // an unconfirmed, unpaid registration — ScoutNet's problem, and it may
      // resolve itself. A `fee_id` with no row in `SCOUTNET_FEE_ROLES` is ours,
      // and it is fixed by editing the ConfigMap. Either way the person gets no
      // category, division or nickname role.
      const bucket = p.fee_id == null ? outside.noFee : outside.unmappedFee;
      bucket.push({ ...person, feeId: p.fee_id ?? null });
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
    else g.missing.push({ name: scoutnet.fullName(p), memberNo });
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

  // A link whose scoutid is in no registration. They linked, so they hold the
  // marker roles, but no group can contain them — and the sync has nothing to
  // give them beyond the marker. The discord id rides along because it is what
  // `/status-scoutid personid:` takes.
  for (const u of linkedUsers) {
    if (!Object.hasOwn(participants ?? {}, String(u.scoutId))) {
      outside.notRegistered.push({
        scoutId: String(u.scoutId),
        discordUserId: u.discordUserId,
      });
    }
  }

  outside.total = Object.values(outside).reduce(
    (n, list) => n + (Array.isArray(list) ? list.length : 0),
    0,
  );

  return { total, linked, categories, outside };
}

/** Reads the live data and computes. Split out so the maths needs no network. */
export async function runAdoption() {
  const [participants, linkedUsers] = await Promise.all([
    scoutnet.getParticipants(),
    storage.getAllLinkedUsers(),
  ]);
  return computeAdoption({ participants, linkedUsers });
}

const pct = (linked, total) =>
  total === 0 ? "–" : `${Math.round((linked / total) * 100)}%`;

/**
 * The four ways out of the grouping: what it is called, what it means, and who
 * can do something about it. `short` is the summary line's wording, which cannot
 * be derived by lowercasing `label` — that turns ScoutNet into scoutnet.
 *
 * **No markup in `why`.** These strings only ever reach the attachment, and
 * Discord renders nothing in a file: a backtick would arrive as a backtick.
 *
 * `linkedNote` says what the count of *linked* people in that bucket means, and
 * it differs per bucket: a cancelled member who is still linked holds roles they
 * should not, while an unmapped one linked and simply got nothing for it.
 */
const OUTSIDE_REASONS = [
  {
    key: "cancelled",
    label: "Avbokade i ScoutNet",
    short: "avbokade",
    why: "Räknas inte som anmälda. Den som ändå är länkad behåller sina roller tills synken körs — /audit-scoutid kategori 5 listar dem.",
    linkedNote: "fortfarande länkad",
  },
  {
    key: "noFee",
    label: "Utan fee_id",
    short: "utan fee_id",
    why: "Obekräftad och obetald anmälan i ScoutNet. Ingen kategori går att härleda, alltså ingen division- eller smeknamnsroll — den som länkat sig får bara markerarrollen. Löser sig när anmälan bekräftas.",
    linkedNote: "länkad",
  },
  {
    key: "unmappedFee",
    label: "fee_id utan mappning",
    short: "med omappad fee_id",
    why: "Avgiften finns i ScoutNet men saknas i SCOUTNET_FEE_ROLES, så den som länkat sig får bara markerarrollen. Det här är vårt att laga: lägg till raden i configmappen.",
    linkedNote: "länkad",
  },
  {
    key: "notRegistered",
    label: "Länkade utan anmälan",
    short: "länkade utan anmälan",
    why: "Har länkat sig men finns inte i deltagarlistan. Antingen fel scoutid vid länkningen, eller inte anmäld till eventet.",
  },
];

/** Swedish plural for the counts beside a reason: "1 länkad", "3 länkade". */
const plural = (n, singular) => `${n} ${n === 1 ? singular : `${singular}e`}`;

/** Fold a sentence to the attachment's width; a file has no soft wrap. */
function wrap(text, indent = "  ", width = 78) {
  const out = [];
  let line = indent;
  for (const word of text.split(" ")) {
    if (line.length > indent.length && line.length + 1 + word.length > width) {
      out.push(line);
      line = indent + word;
    } else {
      line = line.length > indent.length ? `${line} ${word}` : line + word;
    }
  }
  out.push(line);
  return out;
}

/** The reasons with anything in them, so an empty one costs no lines. */
const outsidePresent = (outside) =>
  OUTSIDE_REASONS.map((r) => ({ ...r, people: outside?.[r.key] ?? [] })).filter(
    (r) => r.people.length > 0,
  );

const countLinked = (people) => people.filter((x) => x.linked).length;

/**
 * Plain text, for the attachment. Discord renders nothing in a file, and at 130
 * groups this report is far past the 2000-character message limit.
 */
export function formatAdoptionText(result, { includeMissing = false } = {}) {
  const lines = ["ADOPTION — LÄNKADE AV ANMÄLDA", ""];
  lines.push(
    `${result.total} anmälda (exkl. avbokade) · ${result.linked} länkade · ${pct(result.linked, result.total)}`,
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

  const present = outsidePresent(result.outside);
  if (present.length > 0) {
    lines.push("");
    const head = `Utanför grupperna: ${result.outside.total}`;
    lines.push(head);
    lines.push("=".repeat(head.length));
    for (const r of present) {
      const suffix = r.linkedNote
        ? `  (${plural(countLinked(r.people), r.linkedNote)})`
        : "";
      lines.push(
        `  ${r.label.padEnd(22)} ${String(r.people.length).padStart(4)}${suffix}`,
      );
    }

    for (const r of present) {
      lines.push("", `${r.label} — ${r.people.length}`);
      lines.push("-".repeat(`${r.label} — ${r.people.length}`.length));
      lines.push(...wrap(r.why));
      // A cancelled bucket is hundreds of people and none of them need doing
      // anything about — except the ones who are still linked, who are the whole
      // reason the count is here. The other buckets are small and listed whole.
      const listed =
        r.key === "cancelled" ? r.people.filter((x) => x.linked) : r.people;
      if (r.key === "cancelled" && listed.length === 0) continue;
      for (const x of listed) lines.push(`  · ${outsidePerson(r.key, x)}`);
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

/** One person in an `outside` bucket, with the detail that bucket turns on. */
function outsidePerson(key, x) {
  if (key === "notRegistered")
    return `scoutid ${x.scoutId} — discord-id ${x.discordUserId}`;
  const tail =
    key === "cancelled"
      ? ` avbokad ${x.when}`
      : key === "unmappedFee"
        ? ` fee_id=${x.feeId}`
        : "";
  return `${x.name} (${x.memberNo})${tail}${x.linked ? " — länkad" : ""}`;
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
  const present = outsidePresent(result.outside);
  if (present.length > 0) {
    lines.push(
      `⚠️ Utanför grupperna: ` +
        present.map((r) => `${r.people.length} ${r.short}`).join(" · ") +
        " — se filen för vilka och varför",
    );
  }
  return lines.join("\n");
}
