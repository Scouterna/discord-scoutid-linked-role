import js from "@eslint/js";
import globals from "globals";

/**
 * ESLint flat config.
 *
 * The extension was already installed — it ships with the `javascript-node`
 * devcontainer image, along with a global `eslint` — and it threw
 * `Could not find config file` for every file it looked at, because ESLint 9+
 * requires this file and the repository had none. 175 errors in one session's
 * log, none of them about the code. This is the file that was missing.
 *
 * Deliberately close to `recommended`. Nothing stylistic lives here: Prettier
 * owns formatting (see prettier.config.mjs), so there is no overlap to
 * arbitrate and no need for eslint-config-prettier. What is added below are the
 * three rules that say something about intent rather than about layout.
 */
export default [
  {
    // node_modules is ignored by default; these are not.
    ignores: [
      "docs/**",
      "logs/**",
      ".azure-scouterna/**",
      "src/templates/**", // HTML, not JavaScript
    ],
  },
  js.configs.recommended,
  {
    files: ["src/**/*.js", "test/**/*.mjs", "*.js", "*.mjs"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      // Everything here runs in node: process, console, fetch, setTimeout,
      // Buffer, URL. Without this, `no-undef` reports all of them.
      globals: { ...globals.node },
    },
    rules: {
      // `!= null` is used on purpose and in a load-bearing way — a ScoutNet
      // `cancelled_date` is either a date string or absent, and `!= null`
      // catches both null and undefined in one test. So loose equality is
      // enforced *except* against null, where it is the idiom.
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-var": "error",
      "prefer-const": "error",
    },
  },
];
