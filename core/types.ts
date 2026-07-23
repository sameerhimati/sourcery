// ─── Data Contract ─── shared boundary with the UI. Do not break this shape.

export type Provider = "bright_data" | "firecrawl";
export type Axis = "provider" | "freshness" | "num_sources" | "extraction";
export type Freshness = "24h" | "30d" | "1y" | "all";
export type Extraction = "clean" | "raw";

export interface ArmConfig {
  freshness: Freshness;
  num_sources: number;
  extraction: Extraction;
}

export interface Source {
  title: string;
  url: string;
  published: string | null; // ISO date if known, else null
  domain: string;
  snippet?: string;
  content?: string; // extracted page text (truncated), else snippet fallback
}

export interface Arm {
  id: string; // "A", "B", "C"
  provider: Provider;
  config: ArmConfig;
  model: string; // LLM used for answer + judges (held constant across arms in a run)
  answer: string;
  sources: Source[];
  latency_ms: number;
  retrieval_score: number; // 0–10 from the retrieval judge — the PRIMARY/winner metric
  retrieval_rationale: string;
  score: number; // 0–10 from the answer judge — SECONDARY metric
  rationale: string;
  error?: string; // set if this arm failed; UI can show a fallback
}

export interface Run {
  query: string;
  variable: Axis;
  arms: Arm[];
  // arm id of the winner, chosen by highest retrieval_score among non-errored
  // arms; null if all failed. (Shape unchanged; semantics are now retrieval-based.)
  winner: string | null;
}

export interface RunRequest {
  query: string;
  variable?: Axis; // default "provider"
  values?: string[]; // default depends on axis
  // Optional overrides applied to the base config before the varied axis is
  // swept (additive; all default to DEFAULT_CONFIG / MODEL server-side).
  model?: string;
  num_sources?: number;
  freshness?: Freshness;
  extraction?: Extraction;
}

// Internal only — carries fetched content into the answer step.
export interface FetchResult {
  sources: Source[];
  context: string; // concatenated text handed to the answering LLM
}

export const DEFAULT_CONFIG: ArmConfig = {
  // all-time by default: Bright Data's SERP parse returns empty far more often with a
  // `tbs` freshness filter applied. Freshness is exercised as its own axis instead.
  freshness: "all",
  num_sources: 8,
  extraction: "clean",
};
