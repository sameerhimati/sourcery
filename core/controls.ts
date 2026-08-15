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

/**
 * How much `retrieval_score` moves on its own when you re-run the same query
 * against the same provider — i.e. the noise floor of a single measurement.
 *
 * MEASURED, not chosen: `seed_std_mean` from the 480-arm credibility run
 * (48 queries × 2 providers × 5 fresh fetches). See docs/s2-summary.json.
 *
 * Exported because a gap smaller than this is not a result, and anything that
 * reports a winner needs to know where that line sits. The published headline —
 * a 0.22 quality gap that looked real at n=12 — was five times smaller than
 * this number, which is the whole reason it turned out to be nothing.
 */
export const SEED_NOISE = 1.04;

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

// ─── Run 2: the pooled relevance judge ───
// Additive: the constants above are run 1's instrument and stay untouched so its
// results remain reproducible. Run 2 (core/pooled.ts) judges each unique
// question-and-page pair once, on a short scale with named rungs, per
// docs/preregistration-v3.md. The judge never learns which provider returned a
// page — pooling detaches pages from providers before judging, so blinding is
// structural rather than promised.

export const RELEVANCE_JUDGE_TEMP = 0;

/** The four rungs, each with a meaning a person can argue with. Order matters:
 *  index = the rung's numeric value. */
export const RELEVANCE_RUNGS = [
  { rung: 0, name: "not relevant", meaning: "does not address the question" },
  { rung: 1, name: "marginal", meaning: "on the topic, but would not help answer it" },
  { rung: 2, name: "relevant", meaning: "contains part of the answer, or usable evidence toward it" },
  { rung: 3, name: "highly relevant", meaning: "answers the question directly" },
] as const;

export const RELEVANCE_JUDGE_SYSTEM = `You judge whether ONE web page helps answer ONE question. Grade the page on this scale:
${RELEVANCE_RUNGS.map((r) => `${r.rung} = ${r.name}: ${r.meaning}`).join("\n")}
A page can contain every word of the question and answer nothing — judge whether it answers, not whether it matches keywords. A missing publish date is not itself disqualifying; stale content that the question implicitly needs fresh is.
Return JSON only: {"rung": <int 0-3>, "rationale": "<one sentence>"}.`;

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
