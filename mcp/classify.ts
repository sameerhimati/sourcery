import { TYPE_LABELS } from "@core/batch";
import { MODEL } from "@core/controls";
import type { QueryType } from "@core/eval-dataset";
import { complete } from "@core/llm";

// Derived from TYPE_LABELS (a Record<QueryType, string>) rather than re-typed:
// a seventh query type cannot be added to the dataset without appearing here.
export const QUERY_TYPES = Object.keys(TYPE_LABELS) as QueryType[];

const CLASSIFY_SYSTEM =
  `You label a web-search query with the ONE retrieval type it belongs to.\n` +
  `Types:\n` +
  QUERY_TYPES.map((t) => `- ${t}: ${TYPE_LABELS[t]}`).join("\n") +
  `\nReturn JSON only: {"type": "<one of the ids above>"}.`;

/**
 * One cheap LLM call, temperature 0 — routing is a lookup, so the same query
 * must land on the same type every time. Throws (rather than guessing a type)
 * when the model returns something outside the six: a silently mislabelled
 * query would recommend the wrong provider with full confidence.
 */
export async function classifyQuery(
  query: string,
  model: string = MODEL,
): Promise<QueryType> {
  const raw = await complete({
    model,
    temperature: 0,
    jsonMode: true,
    messages: [
      { role: "system", content: CLASSIFY_SYSTEM },
      { role: "user", content: query },
    ],
  });

  let type: unknown;
  try {
    type = (JSON.parse(raw) as { type?: unknown }).type;
  } catch {
    throw new Error(`classifier did not return JSON: ${raw.slice(0, 200)}`);
  }
  if (typeof type !== "string" || !QUERY_TYPES.includes(type as QueryType)) {
    throw new Error(
      `classifier returned an unknown query type ${JSON.stringify(type)} ` +
        `(expected one of: ${QUERY_TYPES.join(", ")})`,
    );
  }
  return type as QueryType;
}
