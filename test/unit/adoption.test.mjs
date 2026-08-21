/**
 * Adoption grouping — how many registered participants have linked, per group.
 *
 * No emulator and no network: `computeAdoption` takes the participant map, the
 * set of linked scoutids and the config, and returns numbers. That is deliberate,
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

const { computeAdoption, formatAdoptionText } =
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
  SCOUTNET_CATEGORY_ROLES: { ledare: "Ledare" },
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
    linkedScoutIds: new Set(["1"]),
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
    linkedScoutIds: new Set(),
    participants: { 1: P(100, { 88168: "3" }) },
  });
  assert.ok(group(result, "Deltagare-03"), "expected the padded label");
});

test("an unanswered division question lands in the waiting group", async () => {
  const result = computeAdoption({
    cfg: CFG,
    linkedScoutIds: new Set(),
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
    linkedScoutIds: new Set(["9"]),
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
    linkedScoutIds: new Set(),
  });
  assert.equal(group(before, "cmt").total, 3, "one group before");

  const after = computeAdoption({
    cfg: withDivision,
    participants,
    linkedScoutIds: new Set(),
  });
  assert.equal(group(after, "CMT-04").total, 2);
  assert.equal(group(after, "CMT-Ofördelad").total, 1);
  assert.equal(group(after, "cmt"), undefined, "the collapsed group is gone");
});

test("the flat category role is used as the heading, when there is one", async () => {
  const result = computeAdoption({
    cfg: CFG,
    linkedScoutIds: new Set(),
    participants: { 1: P(200, { 107592: "5" }), 2: P(300) },
  });
  const labels = result.categories.map((c) => c.label);
  assert.ok(labels.includes("Ledare"), "SCOUTNET_CATEGORY_ROLES names ledare");
  assert.ok(labels.includes("cmt"), "cmt has no flat role, so its key is used");
});

test("cancelled participants are left out, by either field", async () => {
  const result = computeAdoption({
    cfg: CFG,
    linkedScoutIds: new Set(),
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
    linkedScoutIds: new Set(),
    participants: { 1: P(999) },
  });
  assert.equal(result.unmapped.length, 1);
  assert.equal(result.unmapped[0].feeId, 999);
  assert.equal(result.categories.length, 0);
  assert.match(formatAdoptionText(result), /Utan mappad fee_id: 1/);
});

test("the missing are named, but only when asked for", async () => {
  const result = computeAdoption({
    cfg: CFG,
    linkedScoutIds: new Set(["1"]),
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
