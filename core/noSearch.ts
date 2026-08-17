import { complete } from "./llm";
import {
  MODEL,
  NO_SEARCH_GRADER_SYSTEM,
  NO_SEARCH_GRADER_TEMP,
  NO_SEARCH_SYSTEM,
  NO_SEARCH_TEMP,
  NO_SEARCH_VERDICTS,
} from "./controls";
import type { EvalQuery } from "./eval-dataset";
import { mapWithConcurrency } from "./extract";
import { stage } from "./stage";
import { judgeLabel } from "./credibility";

// The no-search baseline: answer every question with zero sources, then grade
// that answer against what the question says a right answer contains.
//
// Its whole job is to partition the question set. On a question the model could
// already answer, no provider can distinguish itself — the answer was never
// going to come from the retrieved pages — so those questions dilute the very
// difference the run exists to measure. Knowing which they are is the
// difference between "providers barely differ" and "providers barely differ on
// the third of questions where retrieval was never the bottleneck".
//
// It is also the cheapest thing in the run by a wide margin: one call per
// question to answer, one to grade, and no provider credits at all.

export type NoSearchVerdict = (typeof NO_SEARCH_VERDICTS)[number]["verdict"];

const VERDICT_NAMES = NO_SEARCH_VERDICTS.map((v) => v.verdict) as readonly string[];

export interface NoSearchGrade {
  /** null = the grader answered with something that wasn't a verdict. Counted
   *  and excluded, never silently folded into "unknown" — a broken grader and a
   *  model that admitted ignorance are opposite findings. */
  verdict: NoSearchVerdict | null;
  rationale: string;
}

/** Pure parse of the grader's JSON, exported for tests. */
export function parseNoSearchGrade(raw: string): NoSearchGrade {
  try {
    const p = JSON.parse(raw) as { verdict?: unknown; rationale?: unknown };
    const v = typeof p.verdict === "string" ? p.verdict.trim().toLowerCase() : "";
    if (!VERDICT_NAMES.includes(v)) {
      return { verdict: null, rationale: "grader returned an unrecognised verdict" };
    }
    return { verdict: v as NoSearchVerdict, rationale: String(p.rationale ?? "") };
  } catch {
    return { verdict: null, rationale: "grader returned unparseable output" };
  }
}

/** Answer with no sources at all. Deliberately not core/answer.ts, which
 *  short-circuits an empty context to "No sources were retrieved for this
 *  query." — correct there, and exactly the wrong thing here. */
export async function noSearchAnswer(query: string, model: string = MODEL): Promise<string> {
  return complete({
    model,
    temperature: NO_SEARCH_TEMP,
    messages: [
      { role: "system", content: NO_SEARCH_SYSTEM },
      { role: "user", content: query },
    ],
  });
}

/**
 * Grade the no-source answer against the question's own note.
 *
 * The note is the only ground truth on hand, and it is AI-drafted — so this
 * measures agreement with our own stated answer, not truth. That is acceptable
 * precisely because this is a per-question property and not a provider
 * comparison: no arm is advantaged or disadvantaged by it. It belongs in the
 * limitations, not in a footnote nobody reads.
 */
export async function gradeNoSearch(
  query: string,
  note: string,
  answerText: string,
  model: string,
): Promise<NoSearchGrade> {
  const raw =
    (await complete({
      model,
      temperature: NO_SEARCH_GRADER_TEMP,
      jsonMode: true,
      messages: [
        { role: "system", content: NO_SEARCH_GRADER_SYSTEM },
        {
          role: "user",
          content:
            `Question: ${query}\n\n` +
            `Reference — what a right answer contains:\n${note || "(none given)"}\n\n` +
            `The answer, written with no sources:\n${answerText}`,
        },
      ],
    })) || "{}";
  return parseNoSearchGrade(raw);
}

export interface NoSearchRow {
  queryId: string;
  query: string;
  /** The model that answered with no sources. */
  model: string;
  /** The model that graded the answer — short label, judgeLabel(ref). */
  grader: string;
  answer: string;
  verdict: NoSearchVerdict | null;
  rationale: string;
  /** The answer or grade call threw. Retried on resume. */
  error?: string;
}

export function noSearchKey(queryId: string, grader: string): string {
  return `${queryId}|${grader}`;
}

export interface NoSearchOpts {
  concurrency?: number;
  /** The model answering with no sources. Defaults to the run's answer model. */
  model?: string;
  onRow?: (row: NoSearchRow, done: number, total: number) => void;
  /** noSearchKey()s already on disk (resume). */
  done?: ReadonlySet<string>;
}

export async function runNoSearchBaseline(
  queries: EvalQuery[],
  graders: string[],
  opts: NoSearchOpts = {},
): Promise<NoSearchRow[]> {
  const concurrency = opts.concurrency ?? 4;
  const model = opts.model ?? MODEL;
  const jobs = queries
    .flatMap((q) => graders.map((graderRef) => ({ q, graderRef })))
    .filter(({ q, graderRef }) => !opts.done?.has(noSearchKey(q.id, judgeLabel(graderRef))));
  const total = jobs.length;
  let landed = 0;

  // One answer per question, reused by every grader: the answer is the thing
  // being graded, so regenerating it per grader would have them grading
  // different text and call the difference disagreement.
  const answers = new Map<string, Promise<string>>();
  const answerFor = (q: EvalQuery): Promise<string> => {
    const cached = answers.get(q.id);
    if (cached) return cached;
    const p = stage("answer", noSearchAnswer(q.query, model));
    // Every job awaiting this promise handles its rejection, but a later
    // grader may not attach until after it rejects — which Node reports as an
    // unhandled rejection. This marks it handled without swallowing it.
    p.catch(() => {});
    answers.set(q.id, p);
    return p;
  };

  return mapWithConcurrency(jobs, concurrency, async ({ q, graderRef }) => {
    const base = {
      queryId: q.id,
      query: q.query,
      model,
      grader: judgeLabel(graderRef),
    };
    let row: NoSearchRow;
    try {
      const answerText = await answerFor(q);
      const grade = await stage("judge", gradeNoSearch(q.query, q.note ?? "", answerText, graderRef));
      row = { ...base, answer: answerText, verdict: grade.verdict, rationale: grade.rationale };
    } catch (e) {
      row = {
        ...base,
        answer: "",
        verdict: null,
        rationale: "",
        error: e instanceof Error ? e.message : String(e),
      };
    }
    opts.onRow?.(row, ++landed, total);
    return row;
  });
}

/** Resume skips rows that landed; errored ones get another attempt. */
export function resumableNoSearchKeys(rows: NoSearchRow[]): Set<string> {
  const keys = new Set<string>();
  for (const r of rows) {
    if (r.error) continue;
    keys.add(noSearchKey(r.queryId, r.grader));
  }
  return keys;
}

export function dedupeNoSearchRows(rows: NoSearchRow[]): NoSearchRow[] {
  const latest = new Map<string, NoSearchRow>();
  for (const r of rows) latest.set(noSearchKey(r.queryId, r.grader), r);
  return [...latest.values()].filter((r) => !r.error);
}

export interface NoSearchSummary {
  model: string;
  graders: string[];
  n_questions: number;
  /** Questions every grader agreed the model already knew. These are the ones
   *  retrieval cannot discriminate on — the analysis reports the provider
   *  comparison with and without them. */
  already_known: string[];
  /** Questions where a confident answer was wrong. On the unanswerable eight
   *  this is the honesty check firing exactly as intended. */
  confidently_wrong: string[];
  counts: Record<string, number>; // verdict → questions where it was the majority
  n_ungraded: number; // grader returned no usable verdict
  n_errors: number;
}

/** One verdict per question, by majority across graders. A tie goes to the
 *  louder verdict, which means two things: "knew" has to win outright before a
 *  question is written off as one retrieval couldn't have helped with, and a
 *  split over "wrong" surfaces rather than hiding behind "unknown". */
export function summarizeNoSearch(
  rawRows: NoSearchRow[],
  meta: { model: string; graders: string[] },
): NoSearchSummary {
  const rows = dedupeNoSearchRows(rawRows);
  const byQuery = new Map<string, NoSearchVerdict[]>();
  for (const r of rows) {
    if (r.verdict === null) continue;
    (byQuery.get(r.queryId) ?? byQuery.set(r.queryId, []).get(r.queryId)!).push(r.verdict);
  }

  // Later in this list wins a tie: "knew" first so it must win outright,
  // "wrong" last so a hallucination is never quietly downgraded to "unknown".
  const caution: NoSearchVerdict[] = ["knew", "partial", "unknown", "wrong"];
  const counts: Record<string, number> = { knew: 0, partial: 0, wrong: 0, unknown: 0 };
  const alreadyKnown: string[] = [];
  const confidentlyWrong: string[] = [];

  for (const [queryId, verdicts] of byQuery) {
    let best: NoSearchVerdict = "unknown";
    let bestCount = -1;
    for (const v of caution) {
      const n = verdicts.filter((x) => x === v).length;
      if (n >= bestCount && n > 0) {
        best = v;
        bestCount = n;
      }
    }
    counts[best]++;
    if (best === "knew") alreadyKnown.push(queryId);
    if (best === "wrong") confidentlyWrong.push(queryId);
  }

  return {
    model: meta.model,
    graders: meta.graders,
    n_questions: byQuery.size,
    already_known: alreadyKnown.sort(),
    confidently_wrong: confidentlyWrong.sort(),
    counts,
    n_ungraded: rows.filter((r) => r.verdict === null).length,
    n_errors: rawRows.filter((r) => r.error).length,
  };
}
