import type { QueryType } from "./eval-dataset";
import type { Provider } from "./types";
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
  answer_mean: number;
  n_queries: number;
}

/** The winning provider for one query type, with enough context to judge it. */
export interface TypeRouting extends TypeCell {
  // null when only one provider was ever run for this type — a "win" with no
  // opponent is not evidence, and the caller should be able to see that.
  runner_up: Provider | null;
  margin: number; // retrieval_mean lead over the runner-up; 0 when unopposed
}

const round2 = (n: number) => Number(n.toFixed(2));

/**
 * Best provider per query type, ranked by retrieval_score — the primary metric
 * the whole harness is built around. Ties break on answer_score, then on
 * provider id so the table is deterministic across runs.
 */
export function bestPerType(cells: TypeCell[]): TypeRouting[] {
  const byType = new Map<QueryType, TypeCell[]>();
  for (const cell of cells) {
    const list = byType.get(cell.type);
    if (list) list.push(cell);
    else byType.set(cell.type, [cell]);
  }

  return [...byType.entries()]
    .sort(([a], [b]) => a.localeCompare(b)) // deterministic table order
    .map(([type, group]) => {
      const ranked = [...group].sort(
        (a, b) =>
          b.retrieval_mean - a.retrieval_mean ||
          b.answer_mean - a.answer_mean ||
          a.provider.localeCompare(b.provider),
      );
      const [best, next] = ranked;
      return {
        ...best,
        type,
        runner_up: next?.provider ?? null,
        margin: next ? round2(best.retrieval_mean - next.retrieval_mean) : 0,
      };
    });
}

/**
 * Aggregate a `.sourcery/runs.jsonl` history into a routing table.
 *
 * Only batch records contribute: a `run` record is one free-form query with no
 * QueryType label, so it cannot be filed under a type without re-classifying it
 * — which would mean an LLM call, and this function is pure. Errored rows are
 * skipped so one failed arm doesn't drag a cell's mean toward zero.
 */
export function bestProviderByType(records: SourceryRecord[]): TypeRouting[] {
  const acc = new Map<
    string,
    { type: QueryType; provider: Provider; retrieval: number[]; answer: number[]; queries: Set<string> }
  >();

  for (const rec of records) {
    if (rec.mode !== "batch") continue;
    const { row } = rec;
    if (row.error) continue;
    const key = `${row.type}|${row.provider}`;
    let cell = acc.get(key);
    if (!cell) {
      cell = { type: row.type, provider: row.provider, retrieval: [], answer: [], queries: new Set() };
      acc.set(key, cell);
    }
    cell.retrieval.push(row.retrieval_score);
    cell.answer.push(row.answer_score);
    cell.queries.add(row.queryId);
  }

  const mean = (nums: number[]) => nums.reduce((s, x) => s + x, 0) / nums.length;

  const cells: TypeCell[] = [...acc.values()].map((c) => ({
    type: c.type,
    provider: c.provider,
    retrieval_mean: round2(mean(c.retrieval)),
    answer_mean: round2(mean(c.answer)),
    // Means are over rows, but n_queries counts DISTINCT queries — re-running
    // the same batch is more samples, not more evidence, and the gap between
    // the two numbers is the honest signal of that.
    n_queries: c.queries.size,
  }));

  return bestPerType(cells);
}
