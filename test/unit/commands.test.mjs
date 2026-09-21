/**
 * How a command decides who it acts on.
 *
 * `personid` is not a convenience: Discord hides a member who has not accepted
 * the rules gate from every user picker, and that member can hold a link, roles
 * and a nickname. Without a way past the picker an admin cannot reach the people
 * most likely to need repairing — which is how 30 pending members of 139 looked
 * from the admin side on 2026-09-19.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.DOTENV_CONFIG_QUIET = "true";
process.env.TABLE_CONNECTION_STRING =
  "DefaultEndpointsProtocol=https;AccountName=unittest;AccountKey=dGVzdA==;EndpointSuffix=core.windows.net";
process.env.TABLE_NAME = "unittest";
process.env.DISCORD_TOKEN = "fake";
process.env.DISCORD_CLIENT_ID = "app-1";
process.env.DISCORD_GUILD_ID = "G1";
process.env.LOG_CHANNEL_ID = "";

const { targetUser, formatChanges, dryRunPlain } =
  await import("../../src/commands.js");
const { changedAnything } = await import("../../src/guild.js");

const interaction = (options) => ({ data: { name: "t", options } });
const PICKED = "111111111111111111";
const TYPED = "222222222222222222";

test("the picker resolves to the picked user", () => {
  const got = targetUser(interaction([{ name: "person", value: PICKED }]));
  assert.deepEqual(got, { id: PICKED });
});

test("a typed id resolves without the picker", () => {
  const got = targetUser(interaction([{ name: "personid", value: TYPED }]));
  assert.deepEqual(got, { id: TYPED });
});

test("both at once is refused rather than one silently winning", () => {
  // Picking one would act on someone the admin did not name half the time.
  const got = targetUser(
    interaction([
      { name: "person", value: PICKED },
      { name: "personid", value: TYPED },
    ]),
  );
  assert.ok(got.error, "expected an error");
  assert.equal(got.id, undefined);
});

for (const bad of [
  "truls",
  "123",
  "<@222222222222222222>",
  " ",
  "22222222222222222222222",
]) {
  test(`a malformed personid is refused: ${JSON.stringify(bad)}`, () => {
    const got = targetUser(interaction([{ name: "personid", value: bad }]));
    assert.ok(got.error, "expected an error");
    assert.match(got.error, /personid/);
    assert.equal(got.id, undefined);
  });
}

test("surrounding whitespace is forgiven — ids arrive pasted", () => {
  const got = targetUser(
    interaction([{ name: "personid", value: ` ${TYPED} ` }]),
  );
  assert.deepEqual(got, { id: TYPED });
});

test("neither option falls back to the caller when one is offered", () => {
  // `/refresh-scoutid` with no arguments means "refresh me".
  const got = targetUser(interaction([]), { fallback: "caller-1" });
  assert.deepEqual(got, { id: "caller-1" });
});

test("neither option and no fallback returns the caller's own wording", () => {
  const got = targetUser(interaction(undefined), { missing: "Ange `person`." });
  assert.deepEqual(got, { error: "Ange `person`." });
});

/**
 * What a sync result is rendered as, and the invariant that was broken on
 * 2026-09-21: `changedAnything` counts the nickname, `formatChanges` did not.
 * A suffix change moves every member and no role, so a whole-server dry run
 * reported "240 med ändringar" and then printed "Inga ändringar" 240 times —
 * the one run whose entire purpose was to show what would happen.
 */
const CASES = [
  {
    label: "nickname only",
    r: { nickname: "Alexandra J (AL47-Trollsländan)" },
  },
  {
    label: "roles only",
    r: { added: ["Ledare-12"], removed: ["Ledare-Väntande"] },
  },
  { label: "both", r: { added: ["CMT"], nickname: "Sam Ek (CMT)" } },
  { label: "neither", r: {} },
];

for (const { label, r } of CASES) {
  test(`rendering agrees with the change count — ${label}`, () => {
    const rendered = formatChanges(r);
    assert.equal(
      rendered !== "Inga ändringar",
      changedAnything(r),
      `"${rendered}" contradicts changedAnything`,
    );
  });
}

test("the nickname is printed, not merely counted", () => {
  assert.match(
    formatChanges({ nickname: "Alexandra J (AL47-Trollsländan)" }),
    /Smeknamn: Alexandra J \(AL47-Trollsländan\)/,
  );
});

test("the attachment's dry-run marker carries no markup", () => {
  // Discord renders nothing inside a file, so the bold form arrives as literal
  // asterisks. The marker has to be there: the attachment is the half that gets
  // saved and forwarded, and without it a dry run reads as a real one.
  const marker = dryRunPlain(true);
  assert.match(marker, /DRY RUN/);
  assert.doesNotMatch(marker, /[*`_]/);
  assert.equal(dryRunPlain(false), "");
});
