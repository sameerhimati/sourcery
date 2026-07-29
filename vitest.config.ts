import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Mirror the tsconfig path alias so tests resolve @core/* the same way the CLI
// does.
export default defineConfig({
  resolve: {
    alias: {
      "@core": fileURLToPath(new URL("./core", import.meta.url)),
    },
  },
});
