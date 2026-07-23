import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Axis } from "@core/types";

// Project config, loaded from sourcery.config.mjs (native ES module — no runtime
// TS loader dependency). Everything is optional; CLI flags override config, which
// overrides the engine's built-in defaults. This is also the extension seam where
// custom query sets / providers will hang off later.
export interface SourceryConfig {
  model?: string; // answer + judge model
  variable?: Axis; // default axis to vary in `run`
  values?: string[]; // default values for that axis
}

export const CONFIG_FILES = ["sourcery.config.mjs", "sourcery.config.js"];

/** Load the first config file found in `cwd`; returns {} when none exists. */
export async function loadConfig(cwd = process.cwd()): Promise<SourceryConfig> {
  for (const name of CONFIG_FILES) {
    const path = resolve(cwd, name);
    if (!existsSync(path)) continue;
    const mod = (await import(pathToFileURL(path).href)) as {
      default?: SourceryConfig;
    };
    return mod.default ?? {};
  }
  return {};
}
