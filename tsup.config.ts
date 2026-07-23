import { defineConfig } from "tsup";
import { fileURLToPath } from "node:url";

// Bundle the CLI into a single runnable binary. Our own code (cli/* + core/*) is
// inlined with the @core alias resolved, so the result runs from any cwd without
// a tsconfig — closing the gap where `tsx` only resolved @core from the repo
// root. Runtime deps (openai, commander) stay external, required from node_modules.
export default defineConfig({
  entry: ["cli/index.ts"],
  format: ["cjs"], // package is CommonJS (no "type": "module")
  platform: "node",
  target: "node20",
  clean: true,
  shims: false,
  esbuildOptions(options) {
    options.alias = {
      "@core": fileURLToPath(new URL("./core", import.meta.url)),
    };
  },
});
