import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

// There is no framework here to lint for — sourcery is a Node CLI over a
// framework-free core, so this is plain TypeScript rules. (It used to extend
// eslint-config-next, which only made sense while the repo also carried a Next
// dashboard.)
const eslintConfig = defineConfig([
  globalIgnores([
    // Not source: the bundled CLI is tsup output, and design/ is a vendored
    // mockup. Linting them buried every real finding under ~15 phantom errors,
    // which is the same as having no linter at all.
    "dist/**",
    "design/**",
  ]),
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { process: "readonly", console: "readonly" },
    },
  },
]);

export default eslintConfig;
