import { openai, MODEL } from "./llm";
import { Source } from "./types";

const SYSTEM = `You grade a web-search agent's answer on a 0-10 scale.
Rubric:
- correctness: is the answer factually right per the sources?
- freshness/relevance: does it reflect the most current, on-topic info the query implies?
- grounding: are claims supported by the fetched sources (no hallucination)?
Penalize claims not supported by the sources. Reward current, well-sourced answers.
Return JSON only: {"score": <int 0-10>, "rationale": "<one sentence>"}.`;

export async function judge(
  query: string,
  answerText: string,
  sources: Source[],
): Promise<{ score: number; rationale: string }> {
  const srcList =
    sources
      .map(
        (s, i) =>
          `[${i + 1}] ${s.title} (${s.domain})${s.published ? ` — ${s.published}` : ""}`,
      )
      .join("\n") || "(none)";

  const res = await openai.chat.completions.create({
    model: MODEL,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content: `Query: ${query}\n\nAnswer:\n${answerText}\n\nSources it used:\n${srcList}`,
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
    return { score: 0, rationale: "judge returned unparseable output" };
  }
}
