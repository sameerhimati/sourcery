import {
  Arm,
  ArmConfig,
  Axis,
  DEFAULT_CONFIG,
  Extraction,
  Freshness,
  Provider,
  Run,
  RunRequest,
} from "./types";
import { fetchSources } from "./adapters";
import { answer } from "./answer";
import { judge } from "./judge";
import { retrievalJudge } from "./retrievalJudge";
import { MODEL } from "./controls";

const DEFAULT_VALUES: Record<Axis, string[]> = {
  provider: ["bright_data", "firecrawl"],
  freshness: ["24h", "all"],
  num_sources: ["3", "10"],
  extraction: ["clean", "raw"],
};

const ARM_IDS = ["A", "B", "C", "D", "E"];

/** Build one arm's (provider, config) by varying exactly one knob off a base config. */
function armSpec(
  variable: Axis,
  value: string,
  base: ArmConfig,
): { provider: Provider; config: ArmConfig } {
  const config: ArmConfig = { ...base };
  let provider: Provider = "bright_data";
  switch (variable) {
    case "provider":
      provider = value as Provider;
      break;
    case "freshness":
      config.freshness = value as Freshness;
      break;
    case "num_sources":
      config.num_sources = parseInt(value, 10);
      break;
    case "extraction":
      config.extraction = value as Extraction;
      break;
  }
  return { provider, config };
}

export interface ArmSpec {
  id: string;
  provider: Provider;
  config: ArmConfig;
}

/**
 * Run one arm's full pipeline: discover → extract → retrieval-judge + answer →
 * answer-judge. Never throws — a failure is captured in `Arm.error` so a single
 * bad arm degrades gracefully instead of failing the whole run. Shared by the
 * live single-run orchestrator and the offline batch runner (DRY).
 */
export async function runArm(
  spec: ArmSpec,
  query: string,
  model: string = MODEL,
): Promise<Arm> {
  const base: Arm = {
    id: spec.id,
    provider: spec.provider,
    config: spec.config,
    model,
    answer: "",
    sources: [],
    latency_ms: 0,
    retrieval_score: 0,
    retrieval_rationale: "",
    score: 0,
    rationale: "",
  };
  const start = Date.now();
  try {
    const { sources, context } = await fetchSources(spec.provider, query, spec.config);
    // Retrieval judge (primary) grades the sources; answer + answer judge
    // (secondary) run in parallel off the same fetched context.
    const [retrieval, ans] = await Promise.all([
      retrievalJudge(query, sources, model),
      answer(query, context, model),
    ]);
    const { score, rationale } = await judge(query, ans, sources, model);
    return {
      ...base,
      answer: ans,
      sources,
      retrieval_score: retrieval.score,
      retrieval_rationale: retrieval.rationale,
      score,
      rationale,
      latency_ms: Date.now() - start,
    };
  } catch (e) {
    return {
      ...base,
      error: e instanceof Error ? e.message : String(e),
      rationale: "arm failed",
      retrieval_rationale: "arm failed",
      latency_ms: Date.now() - start,
    };
  }
}

/** Winner = highest retrieval_score among non-errored arms; null if all failed. */
export function pickWinner(arms: Arm[]): string | null {
  const ok = arms.filter((a) => !a.error);
  return ok.length
    ? ok.reduce((best, a) => (a.retrieval_score > best.retrieval_score ? a : best)).id
    : null;
}

export async function runEval(req: RunRequest): Promise<Run> {
  const variable: Axis = req.variable ?? "provider";
  const values = req.values?.length ? req.values : DEFAULT_VALUES[variable];
  const model = req.model?.trim() || MODEL;

  // Base config = defaults with any UI-set knobs applied, off which the varied
  // axis is swept. (Sweeping the varied axis overrides its own knob per arm.)
  const base: ArmConfig = {
    ...DEFAULT_CONFIG,
    ...(req.num_sources ? { num_sources: req.num_sources } : {}),
    ...(req.freshness ? { freshness: req.freshness } : {}),
    ...(req.extraction ? { extraction: req.extraction } : {}),
  };

  const arms: Arm[] = await Promise.all(
    values.map((value, i) => {
      const { provider, config } = armSpec(variable, value, base);
      return runArm({ id: ARM_IDS[i] ?? `arm${i}`, provider, config }, req.query, model);
    }),
  );

  return { query: req.query, variable, arms, winner: pickWinner(arms) };
}
