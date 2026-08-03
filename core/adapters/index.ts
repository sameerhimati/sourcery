import { ArmConfig, FetchResult, Provider } from "../types";
import { readCached, writeCached } from "../fetch-cache";
import { fetchBrightData } from "./brightdata";
import {
  creditsPerArm,
  fetchFirecrawl,
  firecrawlBalance,
  firecrawlHealth,
  HARD_TARGET_MULTIPLIER,
} from "./firecrawl";
import { fetchPlain } from "./plain";
import { fetchTavily } from "./tavily";
import { fetchExa } from "./exa";

// The whole trick: one identical interface for every provider. An adapter is a
// (query, config) → {sources, context} function plus the metadata needed to tell
// a user why it isn't working. Registering one is a single entry here.
export interface AdapterSpec {
  id: string;
  label: string;
  /** Env vars that must be present. Empty = works with no account at all. */
  requiredEnv: string[];
  /** One line, shown by `sourcery providers` and in docs/providers.md. */
  blurb: string;
  fetch: (query: string, config: ArmConfig) => Promise<FetchResult>;
  /**
   * Optional cheap probe for `sourcery providers --check`: quota, balance, or
   * anything that decides whether a long run will actually complete. A set key
   * is not the same as a usable account — an exhausted balance looks identical
   * to a healthy one until the arms start failing. Must not consume quota.
   */
  health?: () => Promise<string>;
  /**
   * Optional cost model, for the pre-flight estimate. Present only for providers
   * metered in a countable balance you can exhaust mid-run — today just
   * Firecrawl. Bright Data bills bandwidth, Tavily and Exa have their own
   * quotas, and `plain` is free, so none of them can answer "will this run
   * finish?" in a single number, and claiming otherwise would be worse than
   * saying nothing.
   */
  cost?: {
    /** Floor credits for one arm at this config. */
    perArm: (config: Pick<ArmConfig, "num_sources" | "extraction">) => number;
    /** Live remaining balance, or null if unreadable. Must not consume quota. */
    balance: () => Promise<number | null>;
    /** Multiple of `perArm` an unlucky arm can reach, for the pessimistic end. */
    hardTargetMultiplier: number;
    unit: string;
  };
}

export const ADAPTERS: Record<string, AdapterSpec> = {
  bright_data: {
    id: "bright_data",
    label: "Bright Data",
    requiredEnv: ["BRIGHTDATA_API_TOKEN", "BRIGHTDATA_SERP_ZONE", "BRIGHTDATA_UNLOCKER_ZONE"],
    blurb: "Google SERP via proxy, then per-page extraction through Web Unlocker.",
    fetch: fetchBrightData,
  },
  firecrawl: {
    id: "firecrawl",
    label: "Firecrawl",
    requiredEnv: ["FIRECRAWL_API_KEY"],
    blurb: "Search + scrape in one call; returns markdown per result.",
    fetch: fetchFirecrawl,
    health: firecrawlHealth,
    cost: {
      perArm: creditsPerArm,
      balance: firecrawlBalance,
      hardTargetMultiplier: HARD_TARGET_MULTIPLIER,
      unit: "credits",
    },
  },
  tavily: {
    id: "tavily",
    label: "Tavily",
    requiredEnv: ["TAVILY_API_KEY"],
    blurb: "Search API built for RAG; returns snippets, optionally raw page content.",
    fetch: fetchTavily,
  },
  exa: {
    id: "exa",
    label: "Exa",
    requiredEnv: ["EXA_API_KEY"],
    blurb: "Neural/embedding search over its own index, with page text included.",
    fetch: fetchExa,
  },
  plain: {
    id: "plain",
    label: "Plain fetch",
    requiredEnv: [],
    blurb: "The free baseline: keyless SERP + bare fetch() + regex de-tagging.",
    fetch: fetchPlain,
  },
};

/**
 * The arms to compare when the caller hasn't named any.
 *
 * Resolved from the environment, not hardcoded. While this was a fixed
 * `[bright_data, firecrawl]` pair, someone holding only a Tavily key got a
 * scorecard of two failed arms on their first run, and the other three
 * registered adapters could never appear in a default batch however many keys
 * they had — a constant quietly deciding which providers the tool was allowed
 * to have an opinion about.
 *
 * `plain` is a filler, never a pick. It needs no key, so it would otherwise
 * always read as ready, and a keyless SERP baseline is for trying the tool
 * rather than benchmarking with it. It joins only to guarantee there is
 * something to compare against.
 *
 * `candidates` narrows the pool to a set the caller has already chosen (which
 * is what `init` does), so the "at least two arms" rule lives in one place.
 */
export function defaultProviders(candidates?: string[]): Provider[] {
  const pool = candidates ?? Object.keys(ADAPTERS).filter((id) => id !== "plain");
  const ready = pool.filter((id) => missingEnv(id).length === 0);
  return ready.length >= 2 ? ready : [...ready, "plain"];
}

export function listAdapters(): AdapterSpec[] {
  return Object.values(ADAPTERS);
}

export function getAdapter(provider: Provider): AdapterSpec {
  const spec = ADAPTERS[provider];
  if (!spec) {
    throw new Error(
      `Unknown provider "${provider}". Known: ${Object.keys(ADAPTERS).join(", ")}.`,
    );
  }
  return spec;
}

/** Env vars missing for this provider (empty = ready to run). */
export function missingEnv(provider: Provider): string[] {
  return getAdapter(provider).requiredEnv.filter((k) => !process.env[k]);
}

/**
 * The one metered step in an arm, and therefore the one place the cache lives —
 * both callers (`runArm` for run/batch, and the credibility matrix) come through
 * here, so neither has to know about it. `fetched_at` is returned so callers can
 * record how old the sources really are: the freshness metrics are computed off
 * these sources, and a reused fetch must never look like a live one.
 */
export async function fetchSources(
  provider: Provider,
  query: string,
  config: ArmConfig,
  seed = 0,
): Promise<FetchResult & { fetched_at: string; from_cache: boolean }> {
  const hit = readCached(provider, query, config, seed);
  if (hit) return { ...hit, from_cache: true };

  const fetched_at = new Date().toISOString();
  const result = await getAdapter(provider).fetch(query, config);
  writeCached(provider, query, config, result, seed, fetched_at);
  return { ...result, fetched_at, from_cache: false };
}
