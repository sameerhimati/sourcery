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

const DEFAULT_VALUES: Record<Axis, string[]> = {
  provider: ["bright_data", "firecrawl"],
  freshness: ["24h", "all"],
  num_sources: ["3", "10"],
  extraction: ["clean", "raw"],
};

const ARM_IDS = ["A", "B", "C", "D", "E"];

/** Build one arm's (provider, config) by varying exactly one knob off the defaults. */
function armSpec(
  variable: Axis,
  value: string,
): { provider: Provider; config: ArmConfig } {
  const config: ArmConfig = { ...DEFAULT_CONFIG };
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

export async function runEval(req: RunRequest): Promise<Run> {
  const variable: Axis = req.variable ?? "provider";
  const values = req.values?.length ? req.values : DEFAULT_VALUES[variable];

  const arms: Arm[] = await Promise.all(
    values.map(async (value, i): Promise<Arm> => {
      const { provider, config } = armSpec(variable, value);
      const base: Arm = {
        id: ARM_IDS[i] ?? `arm${i}`,
        provider,
        config,
        answer: "",
        sources: [],
        latency_ms: 0,
        score: 0,
        rationale: "",
      };
      const start = Date.now();
      try {
        const { sources, context } = await fetchSources(provider, req.query, config);
        const ans = await answer(req.query, context);
        const { score, rationale } = await judge(req.query, ans, sources);
        return {
          ...base,
          answer: ans,
          sources,
          score,
          rationale,
          latency_ms: Date.now() - start,
        };
      } catch (e) {
        return {
          ...base,
          error: e instanceof Error ? e.message : String(e),
          rationale: "arm failed",
          latency_ms: Date.now() - start,
        };
      }
    }),
  );

  const ok = arms.filter((a) => !a.error);
  const winner = ok.length
    ? ok.reduce((best, a) => (a.score > best.score ? a : best)).id
    : null;

  return { query: req.query, variable, arms, winner };
}
