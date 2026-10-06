import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const templateDir = join(dirname(fileURLToPath(import.meta.url)), "templates");

const read = (name) => readFileSync(join(templateDir, name), "utf8");

/** The page a completed linking lands on. */
export function getSuccessPageHTML() {
  return read("success.html");
}

/**
 * The page for a linking that stored the link but could not tell Discord.
 *
 * A separate page rather than a flag on the success one, because almost every
 * sentence differs: the accounts *are* linked, and the one thing the member came
 * for — the Scout role — is what did not happen.
 *
 * Both substitutions are injected rather than written into the template. The
 * role is named by `SCOUTNET_SCOUT_ROLE`, so a hardcoded "Scout" here would be a
 * copy that cannot be renamed, and the path wording lives only in `RELINK_PATH`.
 * An HTML file is the easiest place for such a copy to hide, since nothing
 * importing it would ever fail.
 */
export function getIncompletePageHTML({ relinkPath, scoutRole }) {
  return read("linked-incomplete.html")
    .replace("{{RELINK_PATH}}", relinkPath)
    .replace("{{SCOUT_ROLE}}", scoutRole);
}

const escapeHtml = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

/** `<span class="path">` around the relink path, escaped like everything else. */
const path = (p) => `<span class="path">${escapeHtml(p)}</span>`;

/**
 * One layout for every page that has to say something went wrong: a heading, a
 * paragraph, and what to do. Every argument is *HTML*, so the callers below are
 * the only ones that build it, and anything that did not come from this file —
 * a Discord username — goes through `escapeHtml` first.
 */
function problemPage({ title, message, steps, footer }) {
  return read("linked-problem.html")
    .replaceAll("{{TITLE}}", escapeHtml(title))
    .replace("{{MESSAGE}}", message)
    .replace(
      "{{STEPS}}",
      steps.map((s) => `<li>${s}</li>`).join("\n          "),
    )
    .replace("{{FOOTER}}", footer);
}

const FOOTER_LOGGED =
  "Det här är loggat, så en admin kan se vad som hände. Hör av dig till din avdelningsledare om det inte löser sig.";

/**
 * The ScoutID half worked, but the Discord account that linked is not in the
 * server — every role write answered 404. The username is what makes the page
 * useful: on 2026-09-21 and 2026-09-27 the member was in the server the whole
 * time on another account, and "which account did I use?" was the one thing no
 * page told them.
 */
export function getNotInServerPageHTML({ discordUsername, relinkPath }) {
  const account = discordUsername
    ? `<strong>${escapeHtml(discordUsername)}</strong>`
    : "ett Discord-konto";
  return problemPage({
    title: "Fel Discord-konto",
    message: `Du loggade in med ${account}, men det kontot är inte med i WSJ27-servern. Därför har ingenting kopplats.`,
    steps: [
      "Använder du ett annat konto i servern? Logga ut ur Discord i webbläsaren, logga in med det kontot och gör om länkningen därifrån.",
      `Du gör om den i servern: ${path(relinkPath)}.`,
      "Är det här kontot du vill använda? Gå med i servern med det först, och gör sedan om länkningen.",
    ],
    footer: FOOTER_LOGGED,
  });
}

/** Linked, but nothing was granted — see `outcomeOf` in server.js for when. */
export function getNoRolesPageHTML({ scoutnetUnreachable }) {
  if (scoutnetUnreachable) {
    return problemPage({
      title: "Rollerna kommer senare",
      message:
        "Ditt ScoutID är kopplat, men vi kunde inte hämta din anmälan från ScoutNet just nu. Därför har du inte fått dina roller ännu.",
      steps: [
        "Du behöver inte göra något: kopplingen är sparad.",
        "Rollerna delas ut automatiskt vid nästa synk, senast inom ett dygn.",
      ],
      footer: FOOTER_LOGGED,
    });
  }
  return problemPage({
    title: "Inga roller",
    message:
      "Ditt ScoutID är kopplat, men du fick inga roller i servern. Oftast betyder det att vi inte hittar någon aktiv anmälan till WSJ27 på det ScoutID du loggade in med.",
    steps: [
      "Kontrollera att du loggade in med ditt eget ScoutID och inte till exempel en förälders.",
      "Är din anmälan avbokad eller inte klar, är det den som behöver ordnas först.",
    ],
    footer: FOOTER_LOGGED,
  });
}

/**
 * The flow could not be completed at all: the state had expired, the cookie did
 * not match, or something threw. Nothing was stored, so the only step is to
 * start over — which was also true of the bare `403` and `500` this replaces,
 * except that those said nothing.
 */
export function getLinkFailedPageHTML({ relinkPath, expired }) {
  return problemPage({
    title: "Länkningen gick inte igenom",
    message: expired
      ? "Länken har gått ut eller öppnades i en annan webbläsare än den du började i. Ingenting är sparat."
      : "Något gick fel på vår sida. Ingenting är sparat.",
    steps: [
      expired
        ? "Börja om från Discord och gör hela länkningen i samma webbläsare, inom tio minuter."
        : "Vänta en minut och börja om från Discord.",
      `Du hittar länkningen i servern: ${path(relinkPath)}.`,
    ],
    footer: FOOTER_LOGGED,
  });
}
