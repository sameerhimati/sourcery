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
}

export interface Arm {
  id: string; // "A", "B", "C"
  provider: Provider;
  config: ArmConfig;
  answer: string;
  sources: Source[];
  latency_ms: number;
  score: number; // 0–10 from judge
  rationale: string;
  error?: string; // set if this arm failed; UI can show a fallback
}

export interface Run {
  query: string;
  variable: Axis;
  arms: Arm[];
  winner: string | null; // arm id, or null if all failed
}

export interface RunRequest {
  query: string;
  variable?: Axis; // default "provider"
  values?: string[]; // default depends on axis
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
