import { openai } from "./llm";
import { MODEL, RETRIEVAL_JUDGE_SYSTEM, RETRIEVAL_JUDGE_TEMP } from "./controls";
import { Source } from "./types";

// The PRIMARY metric, truest to Sourcery's thesis: grade the *retrieval* — the
// fetched sources themselves — not the answer written from them. Held constant
// across arms (prompt/model/temp live in controls.ts) so only the retrieval
// backend varies. The answer judge (judge.ts) stays as a secondary metric.
const EXCERPT_CHARS = 500;

export async function retrievalJudge(
  query: string,
  sources: Source[],
  model: string = MODEL,
): Promise<{ score: number; rationale: string }> {
  const srcList =
    sources
      .map((s, i) => {
        const body = (s.content ?? s.snippet ?? "").slice(0, EXCERPT_CHARS);
        const pub = s.published ?? "unknown date";
        return `[${i + 1}] ${s.domain} — ${pub}\n${body || "(no content extracted)"}`;
      })
      .join("\n\n") || "(no sources retrieved)";

  const res = await openai.chat.completions.create({
    model,
    temperature: RETRIEVAL_JUDGE_TEMP,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: RETRIEVAL_JUDGE_SYSTEM },
      {
        role: "user",
        content: `Query: ${query}\n\nFetched sources (domain — date, then extracted content):\n${srcList}`,
      },
    ],
  });

  const raw = res.choices[0]?.message?.content ?? "{}";
  try {
    const p = JSON.parse(raw) as { score?: unknown; rationale?: unknown };
    const n = Math.round(Number(p.score));
    const score = Number.isFinite(n) ? Math.max(0, Math.min(10, n)) : 0;
    return { score, rationale: String(p.rationale ?? "") };
  } catch {
    return { score: 0, rationale: "retrieval judge returned unparseable output" };
  }
}
