import { openai, MODEL } from "./llm";
import { Source } from "./types";

// The PRIMARY metric, truest to Sourcery's thesis: grade the *retrieval* — the
// fetched sources themselves — not the answer written from them. Held constant
// across arms (same MODEL, temperature:0, json_object) so only the retrieval
// backend varies. The answer judge (judge.ts) stays as a secondary metric.
const SYSTEM = `You grade a web-search retrieval system on the QUALITY OF THE SOURCES it fetched for a query, on a 0-10 scale. You are NOT grading any written answer — only the fetched sources.
Rubric:
- freshness: are the sources recent enough for what the query implies (breaking news needs days-old; a stable how-to can be older)? Missing dates are a mild negative, not a disqualifier.
- relevance: do the sources actually address the query, from authoritative/on-topic domains?
- extraction quality: is the fetched content substantive and usable (real article text) versus empty, truncated to nothing, or boilerplate/navigation garbage?
Reward fresh, on-topic, cleanly-extracted sources. Penalize stale, off-topic, or empty/garbled content.
Return JSON only: {"score": <int 0-10>, "rationale": "<one sentence>"}.`;

const EXCERPT_CHARS = 500;

export async function retrievalJudge(
  query: string,
  sources: Source[],
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
    model: MODEL,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM },
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
