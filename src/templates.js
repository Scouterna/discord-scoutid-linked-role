import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Serve the success page HTML template
 */
export function getSuccessPageHTML() {
  const templatePath = join(__dirname, "templates", "success.html");
  return readFileSync(templatePath, "utf8");
}

/**
 * The page for a linking that stored the link but could not tell Discord.
 *
 * A separate page rather than a flag on the success one, because almost every
 * sentence differs: the accounts *are* linked, and the one thing the member came
 * for — the `Scout` role — is the thing that did not happen. The old answer here
 * was `res.sendStatus(500)`, which says nothing and invites exactly what it got
 * on 2026-08-24: three attempts in ten seconds.
 *
 * Both substitutions are injected rather than written into the template, and for
 * the same reason: the role is named by `SCOUTNET_SCOUT_ROLE`, so a hardcoded
 * "Scout" here is a copy that cannot be renamed — and the path wording lives in
 * exactly one place (`RELINK_PATH` in metadata.js) because five copies of it had
 * drifted into all being wrong the same way. An HTML file is the easiest place
 * for such a copy to hide, since nothing importing it would ever fail.
 */
export function getIncompletePageHTML({ relinkPath, scoutRole }) {
  const templatePath = join(__dirname, "templates", "linked-incomplete.html");
  return readFileSync(templatePath, "utf8")
    .replace("{{RELINK_PATH}}", relinkPath)
    .replace("{{SCOUT_ROLE}}", scoutRole);
}
