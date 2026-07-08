import { openai, MODEL } from "./llm";

const SYSTEM = `You are a web-search agent. Answer the user's query using ONLY the numbered sources provided.
Cite sources by their domain in parentheses, e.g. (uscis.gov).
If the sources do not cover the query, say so plainly rather than inventing facts.
Be concise: 3-5 sentences.`;

/** SAME model + prompt for every arm — only the sources (context) differ. */
export async function answer(query: string, context: string): Promise<string> {
  if (!context.trim()) return "No sources were retrieved for this query.";

  const res = await openai.chat.completions.create({
    model: MODEL,
    temperature: 0.2,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: `Query: ${query}\n\nSources:\n${context}` },
    ],
  });

  return res.choices[0]?.message?.content?.trim() ?? "";
}
