import { ArmConfig, FetchResult, Source } from "../types";
import { host, tbsParam, toContext } from "./util";
import { cleanMarkdown } from "../extract";
import { dateFromSnippet, dateFromUrl, dateFromMetadata, parsePublished } from "../date";

const ENDPOINT = "https://api.firecrawl.dev/v2/search";

interface WebResult {
  title?: string;
  url: string;
  description?: string;
  markdown?: string;
  metadata?: Record<string, unknown>;
}

interface NewsResult {
  title?: string;
  url?: string;
  date?: string;
}

/** Normalize a title for fuzzy matching news→web (news URLs are opaque redirects). */
function normTitle(t: string | undefined): string {
  return (t ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export async function fetchFirecrawl(
  query: string,
  config: ArmConfig,
): Promise<FetchResult> {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) throw new Error("FIRECRAWL_API_KEY not set");

  const body: Record<string, unknown> = {
    query,
    limit: config.num_sources,
    sources: ["web", "news"],
  };
  // scrapeOptions makes the one search call also return each page's markdown +
  // metadata — Firecrawl's whole pitch: discover and extract in a single request.
  if (config.extraction === "clean") {
    body.scrapeOptions = { formats: ["markdown"] };
  }
  const tbs = tbsParam(config.freshness);
  if (tbs) body.tbs = tbs;

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
    throw new Error(`Firecrawl ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    data?: { web?: WebResult[]; news?: NewsResult[] };
  };
  const web = data?.data?.web ?? [];
  const news = data?.data?.news ?? [];
  const now = Date.now();

  // Index native news dates by normalized title — news URLs are Google `/goto?`
  // redirects so they can't be matched to web results by URL.
  const newsDates = new Map<string, string>();
  for (const n of news) {
    const iso = parsePublished(n.date, now);
    const t = normTitle(n.title);
    if (iso && t) newsDates.set(t, iso);
  }

  const sources: Source[] = web
    .slice(0, config.num_sources)
    .filter((r) => r.url)
    .map((r) => {
      const snippet = r.description ?? "";
      // Date ladder for Firecrawl: page metadata → native news date (by title)
      // → snippet-leading date → URL-path date.
      const published =
        dateFromMetadata(r.metadata, now) ??
        newsDates.get(normTitle(r.title)) ??
        dateFromSnippet(snippet, now) ??
        dateFromUrl(r.url);
      return {
        title: r.title ?? r.url,
        url: r.url,
        published,
        domain: host(r.url),
        snippet,
        content: r.markdown ? cleanMarkdown(r.markdown) : undefined,
      };
    });

  return { sources, context: toContext(sources) };
}
