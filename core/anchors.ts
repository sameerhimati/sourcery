import { readFileSync } from "node:fs";
import type { PooledPage } from "./pool";
import { relevanceJudge, RungVerdict } from "./relevanceJudge";
import { judgeLabel, mean } from "./credibility";
import { mapWithConcurrency } from "./extract";

// ─── The anchor set: test the testers ───
//
// Borrowed from sensory-panel practice (ISO 8586): the instrument is a judge,
// and judges drift. Instead of trusting a panel, every candidate judge model is
// scored against a small set of question-and-page pairs whose ratings a human
// has settled and stands behind. A judge that strays from the anchors is
// flagged for a reason anyone can point at — which also turns "we think model X
// is a bad judge" from an anecdote into a measurement anyone can rerun.
//
// Probes are the adversarial case from the null-model attacks: a well-formatted
// page stuffed with the question's keywords that answers nothing. Its correct
// rating is 0 by construction. A judge that scores a probe above 0 is grading
// keyword density, and no result it produces should be published.

export interface AnchorItem {
  id: string;
  kind: "anchor" | "probe";
  query: string;
  page: {
    title: string;
    domain: string;
    url: string;
    published: string | null;
    content: string;
  };
  expected_rung: number; // 0–3; probes must be 0
  note: string; // why this rating is settled — the part a reviewer argues with
}

export class AnchorSetError extends Error {}

function fail(source: string, where: string, problem: string, fix: string): never {
  throw new AnchorSetError(`${source}${where}: ${problem}\n  ${fix}`);
}

export function parseAnchors(text: string, source = "anchor set"): AnchorItem[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    fail(source, "", `is not valid JSON (${e instanceof Error ? e.message : e})`, "Check for a trailing comma or an unquoted key.");
  }
  if (!Array.isArray(raw) || !raw.length) {
    fail(source, "", "is not a non-empty JSON array", "The file is a JSON array of anchor entries.");
  }
  const seen = new Set<string>();
  return raw.map((item, i) => {
    const where = ` entry ${i + 1}`;
    if (typeof item !== "object" || item === null) {
      fail(source, where, "is not an object", "Each entry is { id, kind, query, page, expected_rung, note }.");
    }
    const o = item as Record<string, unknown>;
    const id = typeof o.id === "string" && o.id.trim() ? o.id.trim() : "";
    if (!id) fail(source, where, "has no `id`", "Give each entry a unique id.");
    if (seen.has(id)) fail(source, where, `reuses the id ${JSON.stringify(id)}`, "Ids must be unique.");
    seen.add(id);
    const kind = o.kind;
    if (kind !== "anchor" && kind !== "probe") {
      fail(source, where, `has kind ${JSON.stringify(kind ?? null)}`, `Use "anchor" (settled rating) or "probe" (keyword-stuffed page, correct rating 0).`);
    }
    const query = typeof o.query === "string" ? o.query.trim() : "";
    if (!query) fail(source, where, "has no `query`", "Each entry needs the question the page is judged against.");
    const p = o.page as Record<string, unknown> | undefined;
    const content = typeof p?.content === "string" ? p.content.trim() : "";
    if (!content) fail(source, where, "has no `page.content`", "The page text is what gets judged; it can't be empty.");
    const rung = o.expected_rung;
    if (typeof rung !== "number" || !Number.isInteger(rung) || rung < 0 || rung > 3) {
      fail(source, where, `has expected_rung ${JSON.stringify(rung ?? null)}`, "Use an integer 0–3.");
    }
    if (kind === "probe" && rung !== 0) {
      fail(source, where, "is a probe with a non-zero expected_rung", "A probe answers nothing by construction; its correct rating is 0.");
    }
    const note = typeof o.note === "string" ? o.note : "";
    if (!note.trim()) {
      fail(source, where, "has no `note`", "Say why the rating is settled — it's the part a reviewer can argue with.");
    }
    return {
      id,
      kind,
      query,
      page: {
        title: typeof p?.title === "string" ? p.title : "",
        domain: typeof p?.domain === "string" ? p.domain : "",
        url: typeof p?.url === "string" ? p.url : "",
        published: typeof p?.published === "string" ? p.published : null,
        content,
      },
      expected_rung: rung,
      note,
    };
  });
}

export function loadAnchors(path: string): AnchorItem[] {
  return parseAnchors(readFileSync(path, "utf8"), path);
}

export interface AnchorMiss {
  id: string;
  kind: "anchor" | "probe";
  expected: number;
  got: number | null;
  rationale: string;
}

export interface JudgeCalibration {
  judge: string;
  n: number;
  n_null: number; // verdicts that weren't a rung at all
  /** Fraction of anchors hit exactly. */
  exact_rate: number;
  /** Mean |got − expected| over verdicts that returned a rung. */
  mean_abs_dev: number;
  /** Probes this judge scored above 0 — any entry here is disqualifying. */
  probe_failures: AnchorMiss[];
  /** Every miss, worst first, so the flag is inspectable rather than a number. */
  misses: AnchorMiss[];
}

function anchorAsPage(a: AnchorItem): PooledPage {
  return {
    queryId: a.id,
    query: a.query,
    url: a.page.url || `anchor://${a.id}`,
    title: a.page.title,
    domain: a.page.domain,
    published: a.page.published,
    content: a.page.content,
    content_from: "anchor",
    returned_by: [],
  };
}

export interface CalibrateOpts {
  concurrency?: number;
  onVerdict?: (judge: string, anchorId: string, done: number, total: number) => void;
  /** Injectable for tests; defaults to the real relevance judge. */
  judgeFn?: (page: PooledPage, model: string) => Promise<RungVerdict>;
}

/** Score every candidate judge against the anchor set. */
export async function calibrateJudges(
  anchors: AnchorItem[],
  judges: string[],
  opts: CalibrateOpts = {},
): Promise<JudgeCalibration[]> {
  const judgeFn = opts.judgeFn ?? relevanceJudge;
  const jobs = judges.flatMap((judgeRef) => anchors.map((anchor) => ({ judgeRef, anchor })));
  let landed = 0;
  const verdicts = await mapWithConcurrency(
    jobs,
    opts.concurrency ?? 4,
    async ({ judgeRef, anchor }) => {
      const verdict = await judgeFn(anchorAsPage(anchor), judgeRef);
      opts.onVerdict?.(judgeLabel(judgeRef), anchor.id, ++landed, jobs.length);
      return { judgeRef, anchor, verdict };
    },
  );

  return judges.map((judgeRef) => {
    const mine = verdicts.filter((v) => v.judgeRef === judgeRef);
    const misses: AnchorMiss[] = mine
      .filter((v) => v.verdict.rung !== v.anchor.expected_rung)
      .map((v) => ({
        id: v.anchor.id,
        kind: v.anchor.kind,
        expected: v.anchor.expected_rung,
        got: v.verdict.rung,
        rationale: v.verdict.rationale,
      }))
      .sort(
        (a, b) =>
          Math.abs((b.got ?? -1) - b.expected) - Math.abs((a.got ?? -1) - a.expected),
      );
    const withRung = mine.filter((v) => v.verdict.rung !== null);
    return {
      judge: judgeLabel(judgeRef),
      n: mine.length,
      n_null: mine.length - withRung.length,
      exact_rate: Number(
        (mine.filter((v) => v.verdict.rung === v.anchor.expected_rung).length / (mine.length || 1)).toFixed(3),
      ),
      mean_abs_dev: Number(
        mean(withRung.map((v) => Math.abs((v.verdict.rung as number) - v.anchor.expected_rung))).toFixed(3),
      ),
      probe_failures: misses.filter((m) => m.kind === "probe" && (m.got ?? 0) > 0),
      misses,
    };
  });
}
