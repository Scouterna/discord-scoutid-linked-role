/**
 * The name overrides in scoutnet.js: the one place a ScoutNet name is replaced,
 * so every reader of the participant list sees the same name.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.DOTENV_CONFIG_QUIET = "true";
process.env.TABLE_CONNECTION_STRING =
  "DefaultEndpointsProtocol=https;AccountName=unittest;AccountKey=dGVzdA==;EndpointSuffix=core.windows.net";

const { applyNameOverrides, nameOverride, fullName } =
  await import("../../src/scoutnet.js");

const overrides = { 123: { first_name: "Kim", last_name: "Andersson" } };

test("an override replaces the name and keeps the rest of the participant", () => {
  const participants = {
    123: { first_name: "Fel", last_name: "Namn", fee_id: 1 },
    456: { first_name: "Alex", last_name: "Berg", fee_id: 2 },
  };
  const result = applyNameOverrides(participants, overrides);
  assert.equal(fullName(result[123]), "Kim Andersson");
  assert.equal(result[123].fee_id, 1);
  assert.equal(result[456], participants[456]);
  // The cached list is not changed underneath the next reader.
  assert.equal(participants[123].first_name, "Fel");
});

test("an override for someone not in the event adds nobody", () => {
  const result = applyNameOverrides({}, overrides);
  assert.deepEqual(result, {});
});

test("without overrides the list is returned as it is", () => {
  const participants = { 123: { first_name: "Fel" } };
  assert.equal(applyNameOverrides(participants, null), participants);
});

test("the link name comes from the override, by member number", () => {
  assert.equal(nameOverride(123, overrides), "Kim Andersson");
  assert.equal(nameOverride("123", overrides), "Kim Andersson");
  assert.equal(nameOverride(456, overrides), null);
  assert.equal(nameOverride(123, null), null);
});
