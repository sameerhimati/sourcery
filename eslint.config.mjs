import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Not source: the bundled CLI is tsup output, and design/ is a vendored
    // mockup. Linting them buried every real finding under ~15 phantom errors,
    // which is the same as having no linter at all.
    "dist/**",
    "design/**",
  ]),
]);

export default eslintConfig;
