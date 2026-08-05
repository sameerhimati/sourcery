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
import { stage, stageOf } from "./stage";
import { fetchSources, defaultProviders } from "./adapters";
import { answer } from "./answer";
import { judge } from "./judge";
import { retrievalJudge } from "./retrievalJudge";
import { MODEL } from "./controls";

// A function, not a constant: the provider row now depends on which keys are
// set, and this module is imported long before the CLI has loaded .env.local.
// Evaluated at module scope it would freeze an empty environment's answer.
const defaultValues = (axis: Axis): string[] =>
  ({
    provider: defaultProviders(),
    freshness: ["24h", "all"],
    num_sources: ["3", "10"],
    extraction: ["clean", "raw"],
  })[axis];

const ARM_IDS = ["A", "B", "C", "D", "E"];

/** Build one arm's (provider, config) by varying exactly one knob off a base config. */
function armSpec(
  variable: Axis,
  value: string,
  base: ArmConfig,
): { provider: Provider; config: ArmConfig } {
  const config: ArmConfig = { ...base };
  // Varying a non-provider axis still needs SOME provider to fetch through. The
  // first ready one, so a machine without a Bright Data key doesn't run every
  // freshness arm through an adapter it can't authenticate.
  let provider: Provider = defaultProviders()[0];
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
  judgeModel: string = MODEL,
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
  // Hoisted so a downstream failure still reports what the provider actually
  // returned. The old catch spread `...base` and published sources: [] for an
  // arm whose fetch had succeeded, which reads downstream as "returned nothing".
  let fetch_ms: number | undefined;
  let fetched: Awaited<ReturnType<typeof fetchSources>> | undefined;
  try {
    const fetchStart = Date.now();
    fetched = await stage("provider", fetchSources(spec.provider, query, spec.config));
    fetch_ms = Date.now() - fetchStart;
    const { sources, context, fetched_at, from_cache } = fetched;
    // Retrieval judge (primary) grades the sources; answer + answer judge
    // (secondary) run in parallel off the same fetched context. The answer uses
    // `model`; both judges use `judgeModel` (kept stale by default on purpose).
    const [retrieval, ans] = await Promise.all([
      stage("judge", retrievalJudge(query, sources, judgeModel)),
      stage("answer", answer(query, context, model)),
    ]);
    const { score, rationale } = await stage("judge", judge(query, ans, sources, judgeModel));
    return {
      ...base,
      answer: ans,
      sources,
      retrieval_score: retrieval.score,
      retrieval_rationale: retrieval.rationale,
      score,
      rationale,
      fetched_at,
      from_cache,
      fetch_ms,
      latency_ms: Date.now() - start,
    };
  } catch (e) {
    return {
      ...base,
      error: e instanceof Error ? e.message : String(e),
      error_stage: stageOf(e),
      sources: fetched?.sources ?? [],
      ...(fetched?.fetched_at ? { fetched_at: fetched.fetched_at } : {}),
      ...(fetched ? { from_cache: fetched.from_cache } : {}),
      ...(fetch_ms !== undefined ? { fetch_ms } : {}),
      rationale: "no result",
      retrieval_rationale: "no result",
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
  const values = req.values?.length ? req.values : defaultValues(variable);
  const model = req.model?.trim() || MODEL;
  // Judge defaults to MODEL (the stale judge), NOT to `model` — overriding the
  // answer model must not silently hand the judge a fresher cutoff.
  const judgeModel = req.judge_model?.trim() || MODEL;

  // Base config = defaults with any UI-set knobs applied, off which the varied
  // axis is swept. (Sweeping the varied axis overrides its own knob per arm.)
  const base: ArmConfig = {
    ...DEFAULT_CONFIG,
    ...(req.num_sources ? { num_sources: req.num_sources } : {}),
    ...(req.freshness ? { freshness: req.freshness } : {}),
    ...(req.extraction ? { extraction: req.extraction } : {}),
  };

  // Arms are parallel, so progress is "how many have settled", not a position in
  // a queue. Reported as each one lands rather than at the end, which is the
  // only thing that distinguishes a slow arm from a hung one.
  let settled = 0;
  const arms: Arm[] = await Promise.all(
    values.map((value, i) => {
      const { provider, config } = armSpec(variable, value, base);
      return runArm(
        { id: ARM_IDS[i] ?? `arm${i}`, provider, config },
        req.query,
        model,
        judgeModel,
      ).then((arm) => {
        req.onProgress?.({ done: ++settled, total: values.length, label: provider });
        return arm;
      });
    }),
  );

  return {
    query: req.query,
    variable,
    arms,
    winner: pickWinner(arms),
    judge_model: judgeModel,
  };
}
