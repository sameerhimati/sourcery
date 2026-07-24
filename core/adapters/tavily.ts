// Tavily: a search API aimed squarely at RAG. One call returns ranked results
// with a `content` snippet, and `include_raw_content: "markdown"` adds the full
// page — so like Firecrawl it is discover-and-extract in a single request.
//
// Note for the eval: Tavily returns no per-result publish date, so freshness for
// this arm is inferred entirely by the date ladder (snippet → body → URL path).
// That handicaps it on the freshness metric relative to providers that report a
// native date. Say so when quoting the numbers.

import { ArmConfig, FetchResult, Source } from "../types";
import { host, toContext } from "./util";
import { cleanMarkdown } from "../extract";
import { dateFromSnippet, dateFromUrl, dateFromContent } from "../date";

const ENDPOINT = "https://api.tavily.com/search";

const TIME_RANGE: Record<string, string | undefined> = {
  "24h": "day",
  "30d": "month",
  "1y": "year",
  all: undefined,
};

interface TavilyResult {
  title?: string;
  url?: string;
  content?: string;
  raw_content?: string | null;
  score?: number;
}

export async function fetchTavily(
  query: string,
  config: ArmConfig,
): Promise<FetchResult> {
  const key = process.env.TAVILY_API_KEY;
  if (!key) throw new Error("TAVILY_API_KEY not set");

  const body: Record<string, unknown> = {
    query,
    max_results: config.num_sources,
    search_depth: "advanced",
  };
  if (config.extraction === "clean") body.include_raw_content = "markdown";
  const range = TIME_RANGE[config.freshness];
  if (range) body.time_range = range;

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Tavily ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = (await res.json()) as { results?: TavilyResult[] };
  const now = Date.now();

  const sources: Source[] = (data.results ?? [])
    .filter((r): r is TavilyResult & { url: string } => Boolean(r.url))
    .slice(0, config.num_sources)
    .map((r) => {
      const snippet = r.content ?? "";
      const content = r.raw_content ? cleanMarkdown(r.raw_content) : undefined;
      return {
        title: r.title ?? r.url,
        url: r.url,
        published:
          dateFromSnippet(snippet, now) ??
          dateFromContent(content, now) ??
          dateFromUrl(r.url),
        domain: host(r.url),
        snippet,
        content,
      };
    });

  return { sources, context: toContext(sources) };
}
