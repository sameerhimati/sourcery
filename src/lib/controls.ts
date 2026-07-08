// ─── The held-constant controls ───
// Single source of truth for the model, prompts, and parameters that are held
// IDENTICAL across every arm. The whole experiment's validity rests on these
// not varying — only the retrieval backend changes. answer.ts / judge.ts /
// retrievalJudge.ts import from here, and the Controls tab renders from here,
// so what the UI shows is exactly what runs. Pure data — safe to import client-side.

import { Extraction, Freshness } from "./types";

export const MODEL = "gpt-4o-mini";

// Selectable models for the Controls knob. The run error-handles a model the
// API key can't access (per-arm error card), so this list can be liberal.
export const MODEL_OPTIONS = [
  "gpt-4o-mini",
  "gpt-4o",
  "gpt-4.1-mini",
  "gpt-4.1",
  "o4-mini",
];

export const FRESHNESS_OPTIONS: { value: Freshness; label: string }[] = [
  { value: "all", label: "all time" },
  { value: "24h", label: "past 24h" },
  { value: "30d", label: "past 30 days" },
  { value: "1y", label: "past year" },
];

export const EXTRACTION_OPTIONS: { value: Extraction; label: string }[] = [
  { value: "clean", label: "extract (fetch full page)" },
  { value: "raw", label: "snippets only" },
];

export const NUM_SOURCES = { min: 3, max: 12, default: 8 };

export const ANSWER_TEMP = 0.2;
export const ANSWER_SYSTEM = `You are a web-search agent. Answer the user's query using ONLY the numbered sources provided.
Cite sources by their domain in parentheses, e.g. (uscis.gov).
If the sources do not cover the query, say so plainly rather than inventing facts.
Be concise: 3-5 sentences.`;

export const JUDGE_TEMP = 0;
export const JUDGE_SYSTEM = `You grade a web-search agent's answer on a 0-10 scale.
Rubric:
- correctness: is the answer factually right per the sources?
- freshness/relevance: does it reflect the most current, on-topic info the query implies?
- grounding: are claims supported by the fetched sources (no hallucination)?
Penalize claims not supported by the sources. Reward current, well-sourced answers.
Return JSON only: {"score": <int 0-10>, "rationale": "<one sentence>"}.`;

export const RETRIEVAL_JUDGE_TEMP = 0;
export const RETRIEVAL_JUDGE_SYSTEM = `You grade a web-search retrieval system on the QUALITY OF THE SOURCES it fetched for a query, on a 0-10 scale. You are NOT grading any written answer — only the fetched sources.
Rubric:
- freshness: are the sources recent enough for what the query implies (breaking news needs days-old; a stable how-to can be older)? Missing dates are a mild negative, not a disqualifier.
- relevance: do the sources actually address the query, from authoritative/on-topic domains?
- extraction quality: is the fetched content substantive and usable (real article text) versus empty, truncated to nothing, or boilerplate/navigation garbage?
Reward fresh, on-topic, cleanly-extracted sources. Penalize stale, off-topic, or empty/garbled content.
Return JSON only: {"score": <int 0-10>, "rationale": "<one sentence>"}.`;

// Pipeline facts shown in the Controls tab. Mirror the defaults in types.ts
// (DEFAULT_CONFIG) and extract.ts — kept here as display copy for the tab.
export interface ControlItem {
  key: string;
  value: string;
  note: string;
}

export const PIPELINE_CONTROLS: ControlItem[] = [
  { key: "model", value: MODEL, note: "same model for answer + both judges, every arm" },
  { key: "answer temperature", value: String(ANSWER_TEMP), note: "low, for stable answers" },
  { key: "judge temperature", value: "0", note: "deterministic grading (both judges)" },
  { key: "num_sources", value: "8", note: "sources discovered per arm (DEFAULT_CONFIG)" },
  { key: "extraction", value: "clean", note: "fetch + extract real page content (vs raw = snippets only)" },
  { key: "freshness", value: "all", note: "no time filter by default; exercised as its own axis" },
  { key: "extract concurrency", value: "4", note: "parallel page fetches per arm (latency cap)" },
  { key: "content per source", value: "~1600 chars", note: "truncation handed into context + judge" },
];

// Named prompt/param blocks for the Controls tab.
export interface ControlStage {
  id: string;
  title: string;
  role: "primary" | "secondary" | "shared";
  temperature: number;
  responseFormat: string;
  system: string;
  blurb: string;
}

export const CONTROL_STAGES: ControlStage[] = [
  {
    id: "retrieval_judge",
    title: "Retrieval judge",
    role: "primary",
    temperature: RETRIEVAL_JUDGE_TEMP,
    responseFormat: "json_object",
    system: RETRIEVAL_JUDGE_SYSTEM,
    blurb:
      "The primary, winner-deciding metric. Grades the fetched sources themselves — freshness, relevance, extraction quality — not any written answer. Truest to the thesis.",
  },
  {
    id: "answer",
    title: "Answer step",
    role: "shared",
    temperature: ANSWER_TEMP,
    responseFormat: "text",
    system: ANSWER_SYSTEM,
    blurb:
      "Writes the answer from the retrieved context. Held constant so any answer difference traces to retrieval, not the writer.",
  },
  {
    id: "answer_judge",
    title: "Answer judge",
    role: "secondary",
    temperature: JUDGE_TEMP,
    responseFormat: "json_object",
    system: JUDGE_SYSTEM,
    blurb:
      "Secondary metric. Grades the written answer for correctness/grounding. Note: on post-cutoff facts it can wrongly penalize correct current answers — which is exactly why retrieval is the primary score.",
  },
];
