import { ArmConfig, FetchResult, Provider } from "../types";
import { fetchBrightData } from "./brightdata";
import { fetchFirecrawl } from "./firecrawl";
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

/** The pair `batch` and the dashboard compare by default. */
export const DEFAULT_PROVIDERS: Provider[] = ["bright_data", "firecrawl"];

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

export function fetchSources(
  provider: Provider,
  query: string,
  config: ArmConfig,
): Promise<FetchResult> {
  return getAdapter(provider).fetch(query, config);
}
