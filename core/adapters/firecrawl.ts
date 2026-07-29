import { ArmConfig, DEFAULT_CONFIG, FetchResult, Source } from "../types";
import { host, tbsParam, toContext } from "./util";
import { cleanMarkdown } from "../extract";
import { dateFromSnippet, dateFromUrl, dateFromContent, dateFromMetadata, parsePublished } from "../date";

const ENDPOINT = "https://api.firecrawl.dev/v2/search";
const CREDIT_ENDPOINT = "https://api.firecrawl.dev/v2/team/credit-usage";

// ─── credit model, measured 2026-07-29 ───
// Billing is: 2 credits per search (per source type, per 10 results) + 1 credit
// per page scraped. Measured by diffing the balance across three controlled
// calls at limit=8 — search alone cost 2, adding markdown scrapes cost +8, and
// adding `sources: ["web","news"]` cost +10 (a second search at 2, plus 8 more
// scrapes for the news results).
//
// This used to be a flat `CREDITS_PER_ARM = 10`, which had the unit prices right
// but forgot that asking for two source types buys two searches AND two sets of
// scrapes. `providers --check` therefore reported twice the runway it had, which
// is how a 5000/mo plan disappeared into a 240-arm run (240 × 20 = 4800) with no
// warning.
const CREDITS_PER_SEARCH = 2;
const CREDITS_PER_SCRAPE = 1;
// `fetchFirecrawl` always requests both web and news (news is where the native
// publish dates come from, which is what the freshness metric leans on).
const SOURCE_TYPES = 2;
// Observed in the wild: some arms bill ~3x the floor below. A scrape is 1 credit
// for a page that yields to a plain fetch, more when Firecrawl has to escalate
// to a heavier browser/stealth path — so the cost is a property of the TARGETS a
// query happens to surface, not of the query itself. Government statistics pages
// were the expensive ones. Reported as a range because a budget gauge that only
// ever quotes the optimistic end is the thing that stranded a run mid-flight.
const HARD_TARGET_MULTIPLIER = 3;

/** Floor cost of one arm under `config` — exact when every page scrapes cleanly. */
export function creditsPerArm(config: Pick<ArmConfig, "num_sources" | "extraction">): number {
  const searches = CREDITS_PER_SEARCH * SOURCE_TYPES;
  const scrapes =
    config.extraction === "clean"
      ? CREDITS_PER_SCRAPE * config.num_sources * SOURCE_TYPES
      : 0;
  return searches + scrapes;
}

/** Arms a balance affords, as a (pessimistic, optimistic) pair. */
export function armsAffordable(
  credits: number,
  config: Pick<ArmConfig, "num_sources" | "extraction">,
): { min: number; max: number } {
  const floor = creditsPerArm(config);
  return {
    min: Math.floor(credits / (floor * HARD_TARGET_MULTIPLIER)),
    max: Math.floor(credits / floor),
  };
}

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
  const plan = data?.planCredits ? ` of ${data.planCredits}/mo` : "";
  if (left <= 0) return `OUT OF CREDITS (${left}${plan}) — every arm will 402`;
  // Quote the range, not a single number: the spread is how hard the pages a
  // query surfaces are to scrape, which you cannot know before running it.
  const { min, max } = armsAffordable(left, DEFAULT_CONFIG);
  const arms = min === max ? `${max}` : `${min}-${max}`;
  return `${left} credits${plan} ≈ ${arms} arms at ${creditsPerArm(DEFAULT_CONFIG)}+/arm`;
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
