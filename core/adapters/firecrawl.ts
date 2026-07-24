import { ArmConfig, FetchResult, Source } from "../types";
import { host, tbsParam, toContext } from "./util";
import { cleanMarkdown } from "../extract";
import { dateFromSnippet, dateFromUrl, dateFromContent, dateFromMetadata, parsePublished } from "../date";

const ENDPOINT = "https://api.firecrawl.dev/v2/search";
const CREDIT_ENDPOINT = "https://api.firecrawl.dev/v2/team/credit-usage";

// Roughly what one arm costs at num_sources 8 with extraction on: the search is
// 2 credits per 10 results, each scrape is 1. Used only to translate a raw
// balance into "how many arms is that", which is the question you actually have.
const CREDITS_PER_ARM = 10;

/** Free, quota-neutral balance check. A key that's set but broke fails every
 *  arm identically, and discovering that 200 arms in is expensive in time. */
export async function firecrawlHealth(): Promise<string> {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) return "FIRECRAWL_API_KEY not set";
  const res = await fetch(CREDIT_ENDPOINT, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) return `credit check failed: HTTP ${res.status}`;
  const { data } = (await res.json()) as {
    data?: { remainingCredits?: number; planCredits?: number };
  };
  const left = data?.remainingCredits;
  if (typeof left !== "number") return "credit balance unavailable";
  const arms = Math.floor(left / CREDITS_PER_ARM);
  const plan = data?.planCredits ? ` of ${data.planCredits}/mo` : "";
  return left <= 0
    ? `OUT OF CREDITS (${left}${plan}) — every arm will 402`
    : `${left} credits${plan} ≈ ${arms} arms`;
}

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
        dateFromContent(r.markdown ? cleanMarkdown(r.markdown) : undefined, now) ??
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
