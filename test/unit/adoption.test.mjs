/**
 * Adoption grouping — how many registered participants have linked, per group.
 *
 * No emulator and no network: `computeAdoption` takes the participant map, the
 * links from storage and the config, and returns numbers. That is deliberate,
 * because the thing worth testing is the *grouping rule*, and the grouping rule is
 * config.
 *
 * The claim these cases exist to prove: **nothing here knows what a `deltagare` or
 * a `cmt` is.** Give a category a division config and it splits; take it away and
 * it collapses. Neither requires touching the code, which is what makes the report
 * survive a reorganisation of the event.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.DOTENV_CONFIG_QUIET = "true";
process.env.TABLE_CONNECTION_STRING =
  "DefaultEndpointsProtocol=https;AccountName=unittest;AccountKey=dGVzdA==;EndpointSuffix=core.windows.net";
process.env.TABLE_NAME = "unittest";

const { computeAdoption, formatAdoptionText, formatAdoptionSummary } =
  await import("../../src/adoption.js");

/** A config shaped like production's, built by hand so cases can vary it. */
const CFG = {
  SCOUTNET_FEE_ROLES: { 100: "deltagare", 200: "ledare", 300: "cmt" },
  SCOUTNET_DIVISION_ROLES: {
    deltagare: {
      questionId: "88168",
      withDiv: "Deltagare-{div}",
      withoutDiv: "Deltagare-Väntande",
    },
    ledare: {
      questionId: "107592",
      withDiv: "Ledare-{div}",
      withoutDiv: "Ledare-Väntande",
    },
  },
  SCOUTNET_CATEGORY_ROLES: { ledare: ["Ledare"] },
};

const P = (fee, answers = {}, extra = {}) => ({
  fee_id: fee,
  cancelled_date: null,
  first_name: "F",
  last_name: "L",
  questions: answers,
  ...extra,
});

const group = (result, label) =>
  result.categories.flatMap((c) => c.groups).find((g) => g.label === label);

test("a category with a division config splits by the answer", async () => {
  const result = computeAdoption({
    cfg: CFG,
    linkedUsers: [{ scoutId: "1", discordUserId: "d1" }],
    participants: {
      1: P(100, { 88168: "7" }),
      2: P(100, { 88168: "7" }),
      3: P(100, { 88168: "12" }),
    },
  });
  assert.equal(group(result, "Deltagare-07").total, 2);
  assert.equal(group(result, "Deltagare-07").linked, 1);
  assert.equal(group(result, "Deltagare-12").total, 1);
});

test("the division number is zero-padded, or the label would not match the role", async () => {
  const result = computeAdoption({
    cfg: CFG,
    linkedUsers: [],
    participants: { 1: P(100, { 88168: "3" }) },
  });
  assert.ok(group(result, "Deltagare-03"), "expected the padded label");
});

test("an unanswered division question lands in the waiting group", async () => {
  const result = computeAdoption({
    cfg: CFG,
    linkedUsers: [],
    participants: { 1: P(100, {}), 2: P(200, {}) },
  });
  assert.equal(group(result, "Deltagare-Väntande").total, 1);
  assert.equal(group(result, "Ledare-Väntande").total, 1);
});

test("a category with no division config is one group", async () => {
  // `cmt` has no entry in SCOUTNET_DIVISION_ROLES, so it must not be split — and
  // it must still be counted.
  const result = computeAdoption({
    cfg: CFG,
    linkedUsers: [{ scoutId: "9", discordUserId: "d9" }],
    participants: { 9: P(300), 10: P(300) },
  });
  const g = group(result, "cmt");
  assert.equal(g.total, 2);
  assert.equal(g.linked, 1);
});

test("giving that category a division config splits it, with no code change", async () => {
  // The claim the whole module rests on. Same participants, same code, one config
  // line different — so the day the CMT function lands in a ScoutNet question,
  // this report splits by it without being touched.
  const withDivision = {
    ...CFG,
    SCOUTNET_DIVISION_ROLES: {
      ...CFG.SCOUTNET_DIVISION_ROLES,
      cmt: {
        questionId: "99999",
        withDiv: "CMT-{div}",
        withoutDiv: "CMT-Ofördelad",
      },
    },
  };
  const participants = {
    9: P(300, { 99999: "4" }),
    10: P(300, { 99999: "4" }),
    11: P(300, {}),
  };

  const before = computeAdoption({
    cfg: CFG,
    participants,
    linkedUsers: [],
  });
  assert.equal(group(before, "cmt").total, 3, "one group before");

  const after = computeAdoption({
    cfg: withDivision,
    participants,
    linkedUsers: [],
  });
  assert.equal(group(after, "CMT-04").total, 2);
  assert.equal(group(after, "CMT-Ofördelad").total, 1);
  assert.equal(group(after, "cmt"), undefined, "the collapsed group is gone");
});

test("the flat category role is used as the heading, when there is one", async () => {
  const result = computeAdoption({
    cfg: CFG,
    linkedUsers: [],
    participants: { 1: P(200, { 107592: "5" }), 2: P(300) },
  });
  const labels = result.categories.map((c) => c.label);
  assert.ok(labels.includes("Ledare"), "SCOUTNET_CATEGORY_ROLES names ledare");
  assert.ok(labels.includes("cmt"), "cmt has no flat role, so its key is used");
});

test("cancelled participants are left out of the groups, by either field", async () => {
  const result = computeAdoption({
    cfg: CFG,
    linkedUsers: [],
    participants: {
      1: P(100, { 88168: "7" }),
      2: P(100, { 88168: "7" }, { cancelled_date: "2026-06-01" }),
      3: P(100, { 88168: "7" }, { cancelled: true }),
    },
  });
  assert.equal(result.total, 1);
  assert.equal(group(result, "Deltagare-07").total, 1);
});

test("an unmapped fee is reported, not silently dropped", async () => {
  // Those people get no category, division or nickname role at all, so they are
  // exactly who must not vanish from a coverage report.
  const result = computeAdoption({
    cfg: CFG,
    linkedUsers: [],
    participants: { 1: P(999) },
  });
  assert.equal(result.outside.unmappedFee.length, 1);
  assert.equal(result.outside.unmappedFee[0].feeId, 999);
  assert.equal(result.categories.length, 0);
  assert.match(formatAdoptionText(result), /fee_id utan mappning\s+1/);
  assert.match(formatAdoptionText(result), /SCOUTNET_FEE_ROLES/);
});

test("everyone outside the groups is counted, under the reason they fell out", () => {
  // The report's coverage figure is only honest if whoever it could not place is
  // visible beside it. Four different faults, four different owners — folding
  // them into one "övrigt" would hide which of them anyone can act on.
  const result = computeAdoption({
    cfg: CFG,
    linkedUsers: [
      { scoutId: "2", discordUserId: "d2" }, // cancelled but still linked
      { scoutId: "4", discordUserId: "d4" }, // unmapped fee
      { scoutId: "77", discordUserId: "d77" }, // no registration at all
    ],
    participants: {
      1: P(100, { 88168: "7" }),
      2: P(100, { 88168: "7" }, { cancelled: true }),
      3: P(null),
      4: P(999),
    },
  });

  assert.equal(result.total, 3, "cancelled must not depress the denominator");
  assert.equal(result.outside.cancelled.length, 1);
  assert.equal(result.outside.noFee.length, 1);
  assert.equal(result.outside.unmappedFee.length, 1);
  assert.equal(result.outside.notRegistered.length, 1);
  assert.equal(result.outside.total, 4);

  // A missing `fee_id` is ScoutNet's problem and may fix itself; a `fee_id` with
  // no row in the config is ours. They look alike in the data, so they are told
  // apart here or nowhere.
  assert.equal(result.outside.noFee[0].memberNo, "3");
  assert.equal(result.outside.unmappedFee[0].feeId, 999);

  const text = formatAdoptionText(result);
  assert.match(text, /Utanför grupperna: 4/);
  assert.match(text, /Avbokade i ScoutNet\s+1\s+\(1 fortfarande länkad\)/);
  // The cancelled bucket lists only those still linked — they hold roles they
  // should not, and the rest need nothing done about them.
  assert.match(text, /discord-id d77/, "an id to paste into personid:");
  // Nothing in the attachment may carry markup: Discord renders none of it in a
  // file, so a backtick arrives as a backtick. `fee_id` keeps its underscore —
  // that is the field's name, not emphasis.
  assert.doesNotMatch(text, /[`*]|__/, "markup in a file renders literally");

  const summary = formatAdoptionSummary(result);
  assert.match(summary, /Utanför grupperna/);
  assert.match(summary, /1 länkade utan anmälan/);
});

test("nothing outside the groups means no section at all", () => {
  // A clean event must not grow four empty headings that teach people to skim
  // past the one that matters the day it is not empty.
  const result = computeAdoption({
    cfg: CFG,
    linkedUsers: [{ scoutId: "1", discordUserId: "d1" }],
    participants: { 1: P(100, { 88168: "7" }) },
  });
  assert.equal(result.outside.total, 0);
  assert.doesNotMatch(formatAdoptionText(result), /Utanför grupperna/);
  assert.doesNotMatch(formatAdoptionSummary(result), /Utanför grupperna/);
});

test("the missing are named, but only when asked for", async () => {
  const result = computeAdoption({
    cfg: CFG,
    linkedUsers: [{ scoutId: "1", discordUserId: "d1" }],
    participants: {
      1: P(100, { 88168: "7" }),
      2: {
        ...P(100, { 88168: "7" }),
        first_name: "Saknad",
        last_name: "Person",
      },
    },
  });
  assert.doesNotMatch(formatAdoptionText(result), /Saknad Person/);
  assert.match(
    formatAdoptionText(result, { includeMissing: true }),
    /Saknad Person \(2\)/,
  );
});

// --- One division, for its leaders ---

const {
  computeDivision,
  formatDivision,
  leaderScope,
  resolveDivision,
  scopeGroups,
  divisionViews,
  divisionKinds,
  planDivisionRequest,
} = await import("../../src/adoption.js");

const SCOPED = {
  ...CFG,
  SCOUTNET_ADOPTION_SCOPE: { ledare: ["deltagare", "ledare"] },
  SCOUTNET_DIVISION_NAMES: { 12: "Musen" },
};

const named = (first, fee, answers, extra) =>
  P(fee, answers, { first_name: first, last_name: "L", ...extra });

test("a leader's scope is their own division, read from ScoutNet", () => {
  assert.deepEqual(leaderScope(P(200, { 107592: "12" }), SCOPED), {
    division: "12",
    categories: ["deltagare", "ledare"],
  });
  // Väntande: in the scope, but no troop to show yet.
  assert.equal(leaderScope(P(200, {}), SCOPED).waiting, true);
  // A participant has no row, so sees nothing.
  assert.equal(leaderScope(P(100, { 88168: "12" }), SCOPED), null);
  // A cancelled leader no longer has the troop.
  assert.equal(
    leaderScope(P(200, { 107592: "12" }, { cancelled: true }), SCOPED),
    null,
  );
});

test("each person lands in the stage where their path broke", () => {
  const result = computeDivision({
    cfg: SCOPED,
    division: "12",
    categories: ["deltagare", "ledare"],
    guildRoles: [{ id: "r-unv", name: "Overifierad" }],
    participants: {
      1: named("Ada", 100, { 88168: "12" }),
      2: named("Bo", 100, { 88168: "12" }),
      3: named("Cia", 100, { 88168: "12" }),
      4: named("Dan", 100, { 88168: "12" }),
      5: named("Eva", 200, { 107592: "12" }),
      // Outside: another troop, a cancelled registration, and an IST-like
      // category that answers the same question with the same number.
      6: named("Fia", 100, { 88168: "7" }),
      7: named("Gus", 100, { 88168: "12" }, { cancelled: true }),
      8: named("Hal", 300, { 88168: "12" }),
    },
    linkedUsers: [
      { scoutId: "2", discordUserId: "d2" },
      { scoutId: "3", discordUserId: "d3" },
      { scoutId: "4", discordUserId: "d4" },
      { scoutId: "5", discordUserId: "d5" },
    ],
    members: [
      { user: { id: "d3" }, pending: true, roles: [] },
      { user: { id: "d4" }, roles: ["r-unv"] },
      { user: { id: "d5" }, roles: [] },
    ],
  });
  const names = (k) => result.stages[k].map((x) => x.name);
  assert.deepEqual(names("notLinked"), ["Ada L"]);
  assert.deepEqual(names("notInServer"), ["Bo L"]);
  assert.deepEqual(names("pending"), ["Cia L"]);
  assert.deepEqual(names("unverified"), ["Dan L"]);
  assert.deepEqual(names("done"), ["Eva L"]);
  assert.equal(result.total, 5);
  assert.equal(result.name, "Musen");
});

test("someone linked from two accounts counts by the one that got furthest", () => {
  const result = computeDivision({
    cfg: SCOPED,
    division: "12",
    categories: ["deltagare"],
    participants: { 1: named("Ada", 100, { 88168: "12" }) },
    linkedUsers: [
      { scoutId: "1", discordUserId: "stray" },
      { scoutId: "1", discordUserId: "real" },
    ],
    members: [{ user: { id: "real" }, roles: [] }],
  });
  assert.equal(result.done, 1);
  assert.equal(result.stages.notInServer.length, 0);
});

test("the report names everyone, one per line, and marks the leaders", () => {
  const result = computeDivision({
    cfg: SCOPED,
    division: "12",
    categories: ["deltagare", "ledare"],
    participants: {
      1: named("Ada", 100, { 88168: "12" }),
      2: named("Eva", 200, { 107592: "12" }),
      3: named("Bo", 100, { 88168: "12" }),
    },
    linkedUsers: [{ scoutId: "3", discordUserId: "d3" }],
    members: [{ user: { id: "d3" }, roles: [] }],
  });
  const text = formatDivision(result);
  assert.match(text, /^\*\*Avdelning 12 – Musen\*\* · 1 av 3 är inne/);
  // The category label is a heading, so it is capitalised even when the
  // config key it falls back to is not.
  assert.match(text, /^-# Deltagare 1\/2 · Ledare 0\/1$/m);
  assert.match(text, /^- Ada L$/m);
  assert.match(text, /^- Eva L · \*Ledare\*$/m);
  // The done are named too: "who is in?" is half the question.
  assert.match(text, /✅ \*\*Inne och ser sina kanaler \(1\)\*\*\n- Bo L$/m);
  // An empty stage writes no heading.
  assert.doesNotMatch(text, /regler/);

  const plain = formatDivision(result, { plain: true });
  assert.doesNotMatch(plain, /\*|^-# /m, "a file renders no markup");
  assert.match(plain, /^ {2}· Eva L \(Ledare\)$/m);
});

test("a division can be asked for by its name as well as its value", () => {
  const cfg = {
    SCOUTNET_DIVISION_NAMES: {
      12: "Musen",
      "ledare/12": "Lyan",
      "lag/A": "Rävarna",
    },
  };
  assert.equal(resolveDivision("musen", ["deltagare"], cfg), "12");
  assert.equal(resolveDivision("Lyan", ["ledare"], cfg), "12");
  assert.equal(resolveDivision("Rävarna", ["lag"], cfg), "A");
  assert.equal(resolveDivision("7", ["deltagare"], cfg), "07");
  // Unknown names come back as typed and match nobody, rather than an error:
  // the value itself may be a word.
  assert.equal(resolveDivision("Okänd", ["deltagare"], cfg), "Okänd");
});

test("the report calls a division what the config calls it", () => {
  const result = computeDivision({
    cfg: { ...SCOPED, SCOUTNET_DIVISION_LABEL: "patrull" },
    division: "12",
    categories: ["deltagare", "ledare"],
    participants: {},
  });
  const text = formatDivision(result, { plain: true });
  assert.match(text, /^Patrull 12 – Musen/);
  assert.match(text, /Ingen anmäld i ScoutNet har patrull 12\./);
});

test("a category scoped to * sees everything, with or without a division", () => {
  const cfg = {
    ...SCOPED,
    SCOUTNET_ADOPTION_SCOPE: { ledare: ["deltagare", "ledare"], cmt: ["*"] },
  };
  // cmt has no division config: `*` must not need one.
  assert.deepEqual(leaderScope(P(300), cfg), { all: true });
  assert.equal(leaderScope(P(300, {}, { cancelled: true }), cfg), null);
  // `*` is not a category a division contains.
  assert.deepEqual(scopeGroups(cfg), [["deltagare", "ledare"]]);
});

const TWO_GROUPS = {
  SCOUTNET_ADOPTION_SCOPE: {
    ledare: ["deltagare", "ledare"],
    "ist-a": ["ist-a", "ist-b"],
    "ist-b": ["ist-b", "ist-a"],
    cmt: ["*"],
  },
  SCOUTNET_DIVISION_NAMES: {
    "07": "Vildsvinet",
    "ist-a/07": "Tordyvel",
    "ist-b/07": "Tordyvel",
  },
};

test("troops and IST patrols are separate kinds, each its own option", () => {
  const cfg = {
    ...TWO_GROUPS,
    SCOUTNET_DIVISION_LABELS: { "ist-a": ["ist-patrull"] },
  };
  // The same set in another order is the same group: IST in either category
  // sees the whole patrol.
  assert.deepEqual(scopeGroups(cfg), [
    ["deltagare", "ledare"],
    ["ist-a", "ist-b"],
  ]);
  assert.deepEqual(divisionKinds(cfg), [
    {
      label: "avdelning",
      option: "avdelning",
      groups: [["deltagare", "ledare"]],
    },
    {
      label: "ist-patrull",
      option: "ist-patrull",
      groups: [["ist-a", "ist-b"]],
    },
  ]);
  // Within a kind only that kind's groups are looked at.
  const [troops, patrols] = divisionKinds(cfg);
  assert.deepEqual(divisionViews("7", troops.groups, cfg), [
    { division: "07", categories: ["deltagare", "ledare"] },
  ]);
  assert.deepEqual(divisionViews("Tordyvel", patrols.groups, cfg), [
    { division: "07", categories: ["ist-a", "ist-b"] },
  ]);
  // No scope still gives the command its one option.
  assert.deepEqual(divisionKinds({}), [
    { label: "avdelning", option: "avdelning", groups: [] },
  ]);
});

test("a name opens only the group it belongs to", () => {
  // Two groups of one kind; "Vildsvinet" falls back to the shared name for
  // the second group's 07 too, which is called something else.
  const groups = [
    ["deltagare", "ledare"],
    ["ist-a", "ist-b"],
  ];
  assert.deepEqual(divisionViews("vildsvinet", groups, TWO_GROUPS), [
    { division: "07", categories: ["deltagare", "ledare"] },
  ]);
  assert.equal(divisionViews("7", groups, TWO_GROUPS).length, 2);
});

test("an IST sees their own patrol, from either IST category", () => {
  const cfg = {
    ...TWO_GROUPS,
    SCOUTNET_FEE_ROLES: { 400: "ist-a", 401: "ist-b", 100: "deltagare" },
    SCOUTNET_DIVISION_ROLES: {
      deltagare: { questionId: "88168" },
      "ist-a": { questionId: "88168" },
      "ist-b": { questionId: "88168" },
    },
  };
  assert.deepEqual(leaderScope(P(401, { 88168: "7" }), cfg), {
    division: "07",
    categories: ["ist-b", "ist-a"],
  });
  const result = computeDivision({
    cfg,
    division: "07",
    categories: ["ist-a", "ist-b"],
    participants: {
      1: named("Ia", 400, { 88168: "07" }),
      2: named("Ib", 401, { 88168: "07" }),
      // Troop 07 shares the question and the number, and is not in the patrol.
      3: named("Del", 100, { 88168: "07" }),
    },
  });
  assert.equal(result.total, 2);
  assert.equal(result.name, "Tordyvel");
  assert.equal(result.label, "avdelning");
  // Labelled by its first category, the report says what the patrol is.
  const labelled = computeDivision({
    cfg: { ...cfg, SCOUTNET_DIVISION_LABELS: { "ist-a": ["ist-patrull"] } },
    division: "07",
    categories: ["ist-a", "ist-b"],
    participants: {},
  });
  assert.match(
    formatDivision(labelled, { plain: true }),
    /^Ist-patrull 07 – Tordyvel/,
  );
});

test("nobody but staff sees across the troop–patrol boundary", () => {
  const cfg = {
    ...TWO_GROUPS,
    SCOUTNET_DIVISION_LABELS: { "ist-a": ["ist-patrull"] },
  };
  const troopLeader = { division: "07", categories: ["deltagare", "ledare"] };
  const ist = { division: "07", categories: ["ist-b", "ist-a"] };
  const plan = (asked, own, seesAll = false) =>
    planDivisionRequest({ asked, own, seesAll, cfg });

  // Their own, with or without the option.
  assert.equal(plan({}, troopLeader).kind.option, "avdelning");
  assert.deepEqual(plan({ avdelning: "Vildsvinet" }, troopLeader).views, [
    troopLeader,
  ]);
  // The set's own order is used, so the report is labelled as a patrol
  // however the scope row happened to list it.
  assert.deepEqual(plan({ "ist-patrull": "7" }, ist).views, [
    { division: "07", categories: ["ist-a", "ist-b"] },
  ]);
  // Same number, other kind: refused both ways.
  assert.match(
    plan({ "ist-patrull": "07" }, troopLeader).error,
    /din egen avdelning/,
  );
  assert.match(plan({ avdelning: "07" }, ist).error, /din egen ist-patrull/);
  // Another of their own kind: refused.
  assert.match(plan({ avdelning: "08" }, troopLeader).error, /din egen/);
  assert.match(plan({ "ist-patrull": "Ekoxe" }, ist).error, /din egen/);

  // Staff: the overview, or any one of either kind — never both at once.
  assert.deepEqual(plan({}, null, true), { overall: true });
  assert.deepEqual(plan({ "ist-patrull": "07" }, null, true).views, [
    { division: "07", categories: ["ist-a", "ist-b"] },
  ]);
  assert.deepEqual(plan({ avdelning: "07" }, null, true).views, [
    { division: "07", categories: ["deltagare", "ledare"] },
  ]);
  assert.match(
    plan({ avdelning: "07", "ist-patrull": "07" }, null, true).error,
    /bara en av/,
  );
});
