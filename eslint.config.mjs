import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/**", "web-ext-artifacts/**"] },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    ignores: ["test/**"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: { ...globals.browser, ...globals.webextensions, SS: "readonly", CurveEditor: "readonly", module: "readonly" },
    },
  },
  {
    files: ["volume-processor.js"],
    languageOptions: { globals: { ...globals.audioWorklet } },
  },
  {
    files: ["test/**/*.js"],
    languageOptions: { ecmaVersion: 2022, sourceType: "script", globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: ["**/*.mjs"],
    languageOptions: { ecmaVersion: 2023, sourceType: "module", globals: { ...globals.node, ...globals.browser } },
  },
];
