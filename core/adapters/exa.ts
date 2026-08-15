// Exa: neural search over its own crawled index rather than a Google proxy, with
// page text returned inline via `contents.text`.
//
// Two things matter for this eval. Exa reports a real `publishedDate` per result,
// so its freshness numbers come from the provider rather than the date ladder —
// the cleanest date signal of any adapter here. And its freshness knob is a hard
// `startPublishedDate` filter, not Google's soft `tbs` recency bias, so a "24h"
// arm can legitimately return fewer sources than asked for instead of drifting
// older. Both are index-design differences, not bugs.

import { ArmConfig, FetchResult, Source } from "../types";
import { host, toContext } from "./util";
import { cleanMarkdown } from "../extract";
import { dateFromSnippet, dateFromUrl, dateFromContent, parsePublished } from "../date";

const ENDPOINT = "https://api.exa.ai/search";

const WINDOW_MS: Record<string, number | undefined> = {
  "24h": 86400000,
  "30d": 30 * 86400000,
  "1y": 365 * 86400000,
  all: undefined,
};

interface ExaResult {
  title?: string;
  url?: string;
  publishedDate?: string;
  author?: string | null;
  text?: string;
}

export async function fetchExa(
  query: string,
  config: ArmConfig,
  now: number = Date.now(),
): Promise<FetchResult> {
  const key = process.env.EXA_API_KEY;
  if (!key) throw new Error("EXA_API_KEY not set");

  const body: Record<string, unknown> = {
    query,
    numResults: config.num_sources,
  };
  if (config.extraction === "clean") body.contents = { text: true };
  const window = WINDOW_MS[config.freshness];
  if (window) body.startPublishedDate = new Date(now - window).toISOString();

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "x-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Exa ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = (await res.json()) as { results?: ExaResult[] };

  const sources: Source[] = (data.results ?? [])
    .filter((r): r is ExaResult & { url: string } => Boolean(r.url))
    .slice(0, config.num_sources)
    .map((r) => {
      const content = r.text ? cleanMarkdown(r.text) : undefined;
      const snippet = content ? content.slice(0, 300) : "";
      return {
        title: r.title ?? r.url,
        url: r.url,
        // Native date first — one of the few adapters that reliably has one.
        published:
          parsePublished(r.publishedDate, now) ??
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
