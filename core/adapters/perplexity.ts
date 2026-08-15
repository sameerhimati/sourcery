// Perplexity's Search API — the endpoint that returns ranked web pages
// (POST /search), NOT the `sonar` chat models at /chat/completions. This eval
// measures which pages a provider finds; an arm that returned a written answer
// would be measuring a different thing under the same column heading. If this
// file ever points at the chat endpoint, the numbers stop meaning what the rest
// of the repo says they mean.
//
// Two things matter for the eval. Perplexity has no full-page mode: every result
// arrives as an excerpt Perplexity extracted itself, sized by
// `search_context_size` and capped per page. So this arm's `content` is a page
// excerpt, never the whole page the way Firecrawl's markdown is — quote its
// extraction numbers with that word attached. And results carry a native `date`,
// so its freshness comes from the provider rather than the date ladder, which
// puts it alongside Exa and ahead of Tavily on that signal.

import { ArmConfig, FetchResult, Source } from "../types";
import { host, toContext } from "./util";
import { cleanMarkdown } from "../extract";
import { dateFromSnippet, dateFromUrl, dateFromContent, parsePublished } from "../date";

const ENDPOINT = "https://api.perplexity.ai/search";

// The API rejects more than 20 results. A 400 we provoked would be tagged as a
// provider-stage failure and charged to Perplexity, so clamp rather than send it.
const MAX_RESULTS = 20;

const RECENCY: Record<string, string | undefined> = {
  "24h": "day",
  "30d": "month",
  "1y": "year",
  all: undefined,
};

interface PerplexityResult {
  title?: string;
  url?: string;
  snippet?: string;
  date?: string | null;
  last_updated?: string | null;
}

export async function fetchPerplexity(
  query: string,
  config: ArmConfig,
): Promise<FetchResult> {
  const key = process.env.PERPLEXITY_API_KEY;
  if (!key) throw new Error("PERPLEXITY_API_KEY not set");

  const body: Record<string, unknown> = {
    query,
    max_results: Math.min(config.num_sources, MAX_RESULTS),
    // Perplexity's only extraction knob: how much of each page it pulls into
    // `snippet`. "high" is the most it will hand back, "low" is the passage
    // nearest the query — the closest analogue it has to this eval's axis.
    search_context_size: config.extraction === "clean" ? "high" : "low",
  };
  const recency = RECENCY[config.freshness];
  if (recency) body.search_recency_filter = recency;

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
    throw new Error(`Perplexity ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = (await res.json()) as { results?: PerplexityResult[] };
  const now = Date.now();

  const sources: Source[] = (data.results ?? [])
    .filter((r): r is PerplexityResult & { url: string } => Boolean(r.url))
    .slice(0, config.num_sources)
    .map((r) => {
      const text = r.snippet ?? "";
      // Only count it as extracted content when we actually asked for the long
      // excerpt, and only when something came back — a stub would otherwise
      // inflate this arm's extraction rate with a line of boilerplate.
      const content =
        config.extraction === "clean" && text.length > 40
          ? cleanMarkdown(text)
          : undefined;
      const snippet = content ? content.slice(0, 300) : text;
      return {
        title: r.title ?? r.url,
        url: r.url,
        // Native publish date first, then the page's own last-modified stamp,
        // which is a weaker claim about age but still the provider's own.
        published:
          parsePublished(r.date, now) ??
          parsePublished(r.last_updated, now) ??
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
