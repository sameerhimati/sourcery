import { complete } from "./llm";
import { RELEVANCE_JUDGE_SYSTEM, RELEVANCE_JUDGE_TEMP } from "./controls";
import type { PooledPage } from "./pool";

// Run 2's judge: one question, ONE page, a rung from 0 to 3. Differs from run
// 1's retrievalJudge (0–10 over a whole source list) on the two counts the
// method demands: a short scale with named rungs, and one page at a time so a
// verdict can be pooled and reused across providers.
const EXCERPT_CHARS = 1600; // matches what run 1 stored per source — the page as we have it

export interface RungVerdict {
  /** null = the judge answered with something that wasn't a rung. Run 1 mapped
   *  that to score 0, which made a broken judge indistinguishable from a real
   *  zero and dragged means down invisibly. A null is excluded from scoring and
   *  counted, so a corrupted judge is loud instead. */
  rung: number | null;
  rationale: string;
}

/** Pure parse of the judge's JSON, exported for tests. */
export function parseRungVerdict(raw: string): RungVerdict {
  try {
    const p = JSON.parse(raw) as { rung?: unknown; rationale?: unknown };
    // Number(null) is 0 — a judge that returned no rung must not score a real 0.
    if (p.rung === null || p.rung === undefined) {
      return { rung: null, rationale: "judge returned an out-of-range or missing rung" };
    }
    const n = Math.round(Number(p.rung));
    if (!Number.isFinite(n) || n < 0 || n > 3) {
      return { rung: null, rationale: "judge returned an out-of-range or missing rung" };
    }
    return { rung: n, rationale: String(p.rationale ?? "") };
  } catch {
    return { rung: null, rationale: "judge returned unparseable output" };
  }
}

export async function relevanceJudge(
  page: PooledPage,
  model: string,
): Promise<RungVerdict> {
  const body = page.content.slice(0, EXCERPT_CHARS);
  const raw =
    (await complete({
      model,
      temperature: RELEVANCE_JUDGE_TEMP,
      jsonMode: true,
      messages: [
        { role: "system", content: RELEVANCE_JUDGE_SYSTEM },
        {
          role: "user",
          content:
            `Question: ${page.query}\n\n` +
            `Page: ${page.title}\n` +
            `Domain: ${page.domain}\n` +
            `Published: ${page.published ?? "unknown date"}\n\n` +
            `Content:\n${body || "(no content extracted)"}`,
        },
      ],
    })) || "{}";
  return parseRungVerdict(raw);
}
