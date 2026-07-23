import { getOpenAI } from "./llm";
import { MODEL, ANSWER_SYSTEM, ANSWER_TEMP } from "./controls";

/** SAME model + prompt for every arm — only the sources (context) differ. */
export async function answer(
  query: string,
  context: string,
  model: string = MODEL,
): Promise<string> {
  if (!context.trim()) return "No sources were retrieved for this query.";

  const res = await getOpenAI().chat.completions.create({
    model,
    temperature: ANSWER_TEMP,
    messages: [
      { role: "system", content: ANSWER_SYSTEM },
      { role: "user", content: `Query: ${query}\n\nSources:\n${context}` },
    ],
  });

  return res.choices[0]?.message?.content?.trim() ?? "";
}
