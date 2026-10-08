/**
 * The member-facing pages name the server and the event from config, never
 * from a literal. A literal here is a copy of a deployment's identity inside a
 * generic codebase, and an HTML string is where such a copy hides best.
 */
import test from "node:test";
import assert from "node:assert/strict";

const { getNotInServerPageHTML, getNoRolesPageHTML } =
  await import("../../src/templates.js");

test("not-in-server names the configured server", () => {
  const html = getNotInServerPageHTML({
    discordUsername: "anna",
    relinkPath: "#länka",
    serverName: "Testlägret-servern",
  });
  assert.match(html, /inte med i Testlägret-servern/);
});

test("not-in-server escapes the server name like everything else", () => {
  const html = getNotInServerPageHTML({
    discordUsername: "anna",
    relinkPath: "#länka",
    serverName: "<script>x</script>",
  });
  assert.doesNotMatch(html, /<script>x<\/script>/);
  assert.match(html, /&lt;script&gt;/);
});

test("not-in-server falls back to plain Swedish without a name", () => {
  for (const serverName of [undefined, ""]) {
    const html = getNotInServerPageHTML({
      discordUsername: "anna",
      relinkPath: "#länka",
      serverName,
    });
    assert.match(html, /inte med i servern\./);
    assert.doesNotMatch(html, /undefined/);
  }
});

test("no-roles names the configured event", () => {
  const html = getNoRolesPageHTML({
    scoutnetUnreachable: false,
    eventName: "Testlägret",
  });
  assert.match(html, /aktiv anmälan till Testlägret/);
});

test("no-roles falls back without an event name", () => {
  for (const eventName of [undefined, ""]) {
    const html = getNoRolesPageHTML({ scoutnetUnreachable: false, eventName });
    assert.match(html, /aktiv anmälan till eventet/);
    assert.doesNotMatch(html, /undefined/);
  }
});

test("no page carries a deployment's name by itself", () => {
  const pages = [
    getNotInServerPageHTML({ discordUsername: "a", relinkPath: "#x" }),
    getNoRolesPageHTML({ scoutnetUnreachable: false }),
    getNoRolesPageHTML({ scoutnetUnreachable: true }),
  ];
  for (const html of pages) assert.doesNotMatch(html, /wsj/i);
});
