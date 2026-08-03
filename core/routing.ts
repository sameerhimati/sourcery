import type { QueryType } from "./eval-dataset";
import type { Provider } from "./types";
import { ci95 } from "./credibility";
import type { SourceryRecord } from "./records";

// ─── Which provider for which kind of query ───
// Pure aggregation over whatever the user has already run. This is the seed of
// the static router: `which_provider` (MCP) reads it today, a routing table
// shipped alongside the eval reads it tomorrow. No I/O, no LLM — the caller
// supplies the records and owns the decision about where they came from.

/** One (type × provider) aggregate — the minimal input the picker needs. Both
 *  the user's own JSONL and the committed S2 summary's `by_type` fit this shape. */
export interface TypeCell {
  type: QueryType;
  provider: Provider;
  retrieval_mean: number;
  retrieval_ci95: number; // half-width; a lead smaller than this is not a lead
  answer_mean: number;
  n_queries: number;
  error_rate: number; // fraction of attempted arms that returned nothing usable
}

/** The winning provider for one query type, with enough context to judge it. */
export interface TypeRouting extends TypeCell {
  // null when only one provider was ever run for this type — a "win" with no
  // opponent is not evidence, and the caller should be able to see that.
  runner_up: Provider | null;
  margin: number; // retrieval_mean lead over the runner-up; 0 when unopposed
  // Which question actually decided it:
  //   retrieval     — the quality gap survived its own confidence interval
  //   reliability   — quality was indistinguishable; the more dependable one won
  //   inconclusive  — neither separates them. This is a coin flip and says so;
  //                   the pick is just the better point estimate.
  //   unopposed     — nothing else has been run for this type
  decided_by: "retrieval" | "reliability" | "inconclusive" | "unopposed";
}

const round2 = (n: number) => Number(n.toFixed(2));

/**
 * Above this failure rate a provider is not recommended while a materially more
 * dependable one exists, however well it scores on the calls that do come back.
 * One request in five returning nothing is a broken dependency, not a trade-off.
 *
 * A policy choice rather than a measurement — it is the one number here you might
 * reasonably want to move. Discounting the score by the failure rate instead was
 * tried and rejected: it rated a 30%-failure provider a hair *ahead* on
 * product_lookup (3.55 vs 3.54), which is precisely the call this rule exists to
 * stop the table from making.
 */
export const MAX_ERROR_RATE = 0.2;

/** Materiality guard: a floor must not fire over a rounding-sized difference. */
const RELIABILITY_EDGE = 0.05;

/**
 * Best provider per query type.
 *
 * Ranked on retrieval_score first — the primary metric the harness is built
 * around — but only where the gap survives its own confidence interval. The
 * reference run found its providers a statistical tie on quality and separated
 * them only on reliability, so a picker that ranked on quality alone would spend
 * most of its answers reporting noise as a winner: recommending the provider
 * that scored 0.04 higher and failed a third of its arms.
 *
 * When the leader's margin is inside its own CI, the tie is broken on
 * error_rate instead, and `decided_by` says so. Remaining ties fall through to
 * answer_score, then provider id, so the table is deterministic across runs.
 *
 * A quality win is also refused outright when the winner fails more than
 * MAX_ERROR_RATE of its calls and someone materially steadier is available —
 * no source-quality edge is worth a backend that returns nothing 30% of the time.
 */
export function bestPerType(cells: TypeCell[]): TypeRouting[] {
  const byType = new Map<QueryType, TypeCell[]>();
  for (const cell of cells) {
    const list = byType.get(cell.type);
    if (list) list.push(cell);
    else byType.set(cell.type, [cell]);
  }

  // Last-resort ordering once the deciding question has been answered. Retrieval
  // stays ahead of answer_score throughout: the source-level score is the one
  // the harness trusts, and the answer judge can penalize a correct post-cutoff
  // answer. Provider id last, purely so the table is stable across runs.
  const byQualityThenId = (a: TypeCell, b: TypeCell) =>
    b.retrieval_mean - a.retrieval_mean ||
    b.answer_mean - a.answer_mean ||
    a.provider.localeCompare(b.provider);

  return [...byType.entries()]
    .sort(([a], [b]) => a.localeCompare(b)) // deterministic table order
    .map(([type, group]) => {
      const byQuality = [...group].sort(byQualityThenId);
      const [leader, chaser] = byQuality;

      if (!chaser) {
        return { ...leader, type, runner_up: null, margin: 0, decided_by: "unopposed" as const };
      }

      // The CI is a half-width, so a lead smaller than it means the two
      // intervals overlap and this dataset cannot order them.
      const separated = leader.retrieval_mean - chaser.retrieval_mean > leader.retrieval_ci95;

      // ...and a lead the leader is too unreliable to collect on doesn't count.
      const unfit =
        leader.error_rate > MAX_ERROR_RATE &&
        leader.error_rate - chaser.error_rate > RELIABILITY_EDGE;

      const ranked =
        separated && !unfit
          ? byQuality
          : [...group].sort((a, b) => a.error_rate - b.error_rate || byQualityThenId(a, b));
      const [best, next] = ranked;

      const decided_by =
        separated && !unfit
          ? ("retrieval" as const)
          : best.error_rate !== next.error_rate
            ? ("reliability" as const)
            : ("inconclusive" as const);

      return {
        ...best,
        type,
        runner_up: next.provider,
        margin: round2(best.retrieval_mean - next.retrieval_mean),
        decided_by,
      };
    });
}

/**
 * Aggregate a `.sourcery/runs.jsonl` history into a routing table.
 *
 * Only batch records contribute: a `run` record is one free-form query with no
 * QueryType label, so it cannot be filed under a type without re-classifying it
 * — which would mean an LLM call, and this function is pure.
 *
 * Errored rows are excluded from the score means (a failure has no score to
 * average) but counted toward error_rate, because a provider failing half its
 * arms is the single most useful thing this table can tell you.
 */
export function bestProviderByType(records: SourceryRecord[]): TypeRouting[] {
  const acc = new Map<
    string,
    {
      type: QueryType;
      provider: Provider;
      retrieval: number[];
      answer: number[];
      queries: Set<string>;
      arms: number;
      errors: number;
    }
  >();

  for (const rec of records) {
    if (rec.mode !== "batch") continue;
    const { row } = rec;
    const key = `${row.type}|${row.provider}`;
    let cell = acc.get(key);
    if (!cell) {
      cell = {
        type: row.type,
        provider: row.provider,
        retrieval: [],
        answer: [],
        queries: new Set(),
        arms: 0,
        errors: 0,
      };
      acc.set(key, cell);
    }
    cell.arms += 1;
    if (row.error) {
      cell.errors += 1;
      continue;
    }
    cell.retrieval.push(row.retrieval_score);
    cell.answer.push(row.answer_score);
    cell.queries.add(row.queryId);
  }

  const mean = (nums: number[]) => (nums.length ? nums.reduce((s, x) => s + x, 0) / nums.length : 0);

  const cells: TypeCell[] = [...acc.values()].map((c) => ({
    type: c.type,
    provider: c.provider,
    retrieval_mean: round2(mean(c.retrieval)),
    // ci95() returns 0 for n<2, which here would read as "no uncertainty" and
    // let a single sample win outright. One row is not evidence of a lead, so
    // an unknown interval is treated as an infinite one: the comparison falls
    // through to reliability instead of inventing confidence.
    retrieval_ci95: c.retrieval.length < 2 ? Infinity : round2(ci95(c.retrieval)),
    answer_mean: round2(mean(c.answer)),
    // Means are over rows, but n_queries counts DISTINCT queries — re-running
    // the same batch is more samples, not more evidence, and the gap between
    // the two numbers is the honest signal of that.
    n_queries: c.queries.size,
    error_rate: c.arms ? Number((c.errors / c.arms).toFixed(4)) : 0,
  }));

  return bestPerType(cells);
}
