import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // This codebase deliberately reaches into loosely-typed mineflayer/plugin
      // objects via `any` at well-contained boundaries.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-empty": ["warn", { allowEmptyCatch: true }],
      // Too pedantic for this codebase's defensive `let x = null; … x = …` pattern.
      "no-useless-assignment": "off",
    },
  },
  {
    files: ["scripts/**/*.mjs", "*.config.ts", "*.config.js"],
    languageOptions: { globals: { ...globals.node } },
  },
);
