import { complete, type ChatMessage } from "./llm";
import { RETRIEVAL_JUDGE_SYSTEM, RETRIEVAL_JUDGE_TEMP } from "./controls";
import type { Source } from "./types";

// Run 2's set-level judge: one question, one provider's WHOLE returned set, a
// score from 0 to 10. The companion to relevanceJudge, which grades one page at
// a time — this one answers the question a per-page mean only approximates, was
// this a good set of results to hand an agent.
//
// The prompt and temperature are run 1's, imported unchanged from controls.ts,
// so a set score here and a set score there are the same measurement. What is
// NOT reused is run 1's parse: retrievalJudge maps unparseable output to a real
// 0, which is the exact failure relevanceJudge exists to avoid — a broken judge
// becomes indistinguishable from a genuinely bad result set and drags the mean
// down with nothing in the output saying so. A null here is excluded from
// scoring and counted, so a corrupted judge is loud instead of invisible.
//
// Matching relevanceJudge's excerpt length is deliberate: if the per-page judge
// and the set judge saw different amounts of the same page, any disagreement
// between the two metrics would be partly an artefact of that difference rather
// than a finding about retrieval.
const EXCERPT_CHARS = 1600;

export interface SetVerdict {
  /** null = the judge answered with something that wasn't a score. */
  score: number | null;
  rationale: string;
}

/** Pure parse of the judge's JSON, exported for tests. */
export function parseSetVerdict(raw: string): SetVerdict {
  try {
    const p = JSON.parse(raw) as { score?: unknown; rationale?: unknown };
    // Number(null) is 0 — a judge that returned no score must not score a real 0.
    if (p.score === null || p.score === undefined) {
      return { score: null, rationale: "judge returned an out-of-range or missing score" };
    }
    const n = Math.round(Number(p.score));
    if (!Number.isFinite(n) || n < 0 || n > 10) {
      return { score: null, rationale: "judge returned an out-of-range or missing score" };
    }
    return { score: n, rationale: String(p.rationale ?? "") };
  } catch {
    return { score: null, rationale: "judge returned unparseable output" };
  }
}

/** Render a returned set the way the judge sees it: no provider name anywhere,
 *  so blinding survives even though a set — unlike a pooled page — belongs to
 *  exactly one provider. */
export function renderSources(sources: Source[]): string {
  return (
    sources
      .map((s, i) => {
        const body = (s.content ?? s.snippet ?? "").slice(0, EXCERPT_CHARS);
        return (
          `[${i + 1}] ${s.title} (${s.domain})${s.published ? ` — ${s.published}` : ""}\n` +
          (body || "(no content extracted)")
        );
      })
      .join("\n\n") || "(no sources retrieved)"
  );
}

/** Built once, used by both the synchronous and the batch path, so the two
 *  submit byte-identical work. See relevanceMessages for why that matters. */
export function setJudgeMessages(query: string, sources: Source[]): ChatMessage[] {
  return [
    { role: "system", content: RETRIEVAL_JUDGE_SYSTEM },
    {
      role: "user",
      content: `Query: ${query}\n\nFetched sources (title, domain — date, then extracted content):\n${renderSources(sources)}`,
    },
  ];
}

export async function setJudge(
  query: string,
  sources: Source[],
  model: string,
): Promise<SetVerdict> {
  const raw =
    (await complete({
      model,
      temperature: RETRIEVAL_JUDGE_TEMP,
      jsonMode: true,
      messages: setJudgeMessages(query, sources),
    })) || "{}";
  return parseSetVerdict(raw);
}
