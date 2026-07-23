import { getOpenAI } from "./llm";
import { MODEL, JUDGE_SYSTEM, JUDGE_TEMP } from "./controls";
import { Source } from "./types";

export async function judge(
  query: string,
  answerText: string,
  sources: Source[],
  model: string = MODEL,
): Promise<{ score: number; rationale: string }> {
  const srcList =
    sources
      .map(
        (s, i) =>
          `[${i + 1}] ${s.title} (${s.domain})${s.published ? ` — ${s.published}` : ""}`,
      )
      .join("\n") || "(none)";

  const res = await getOpenAI().chat.completions.create({
    model,
    temperature: JUDGE_TEMP,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: JUDGE_SYSTEM },
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
