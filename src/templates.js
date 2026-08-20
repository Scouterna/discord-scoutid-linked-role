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
