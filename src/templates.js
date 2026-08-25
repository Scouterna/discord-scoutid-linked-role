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
