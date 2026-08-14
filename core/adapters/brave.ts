// Brave Search: an independent index — Brave runs its own crawler rather than
// reselling Google's results — reached with a single GET.
//
// Read this before quoting the arm: Brave returns no page content, ever. A
// result is a one-line `description`, plus up to five further excerpts from the
// same page if you ask for them. There is no page to extract, so "clean"
// extraction here means "ask for the extra excerpts", and the answering model
// sees a few hundred characters per source where the Firecrawl, Tavily and Exa
// arms see a few thousand. That is a real property of the provider rather than a
// gap in this adapter, and it belongs beside any score this arm earns: a judge
// reading eight snippets is grading a thinner brief than one reading eight pages.
// The extra excerpts are also a Pro-plan feature, so the same arm is thinner
// again on a cheaper account — see the retry in `search` below.
//
// Two more asymmetries worth stating when the numbers are published. Brave
// reports a per-result date for a lot of results, so freshness here often comes
// from the provider rather than the date ladder, as with Exa. And Brave returns
// news in its own cluster, separate from `web.results`; we read only the web
// cluster, because merging two separately-ranked lists would mean inventing an
// order Brave never gave. On breaking-news questions that can leave this arm
// looking staler than the index actually is.

import { ArmConfig, FetchResult, Source } from "../types";
import { host, toContext } from "./util";
import { cleanMarkdown } from "../extract";
import { dateFromSnippet, dateFromUrl, dateFromContent, parsePublished } from "../date";

const ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

// Brave's windows don't line up exactly with ours: `pm` is 31 days, not 30. The
// alternative is Brave's explicit `YYYY-MM-DDtoYYYY-MM-DD` range, which would
// make this the only adapter filtering on a hard date boundary and stop the
// freshness axis comparing like with like. One day of slack is the cheaper error.
const FRESHNESS: Record<string, string | undefined> = {
  "24h": "pd",
  "30d": "pm",
  "1y": "py",
  all: undefined,
};

// Asking for more than this is a rejected request, not a short result list.
const MAX_COUNT = 20;

interface BraveResult {
  title?: string;
  url?: string;
  description?: string;
  page_age?: string;
  age?: string;
  extra_snippets?: string[];
}

/**
 * One call, throwing a self-describing error on any non-2xx so `core/stage.ts`
 * can attribute the failure.
 */
async function search(params: URLSearchParams, key: string): Promise<BraveResult[]> {
  const res = await fetch(`${ENDPOINT}?${params.toString()}`, {
    headers: { "X-Subscription-Token": key, Accept: "application/json" },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Brave ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = (await res.json()) as { web?: { results?: BraveResult[] } };
  return data.web?.results ?? [];
}

export async function fetchBrave(
  query: string,
  config: ArmConfig,
  now: number = Date.now(),
): Promise<FetchResult> {
  const key = process.env.BRAVE_API_KEY;
  if (!key) throw new Error("BRAVE_API_KEY not set");

  const params = new URLSearchParams({
    q: query,
    count: String(Math.min(Math.max(config.num_sources, 1), MAX_COUNT)),
    // Brave defaults to correcting spelling. A silent rewrite would mean this
    // arm answered a different question from every other arm in the run, which
    // is the one thing the experiment cannot survive.
    spellcheck: "false",
    // Default-on, and it wraps every matched query term in highlight markup that
    // would otherwise land in the answering model's context as noise.
    text_decorations: "false",
    // We only ever read `web.results`. Pinning the filter keeps the envelope the
    // same shape on every question, and independent of Brave's default changing.
    result_filter: "web",
  });
  const freshness = FRESHNESS[config.freshness];
  if (freshness) params.set("freshness", freshness);

  // The only text Brave will give beyond the one-line description, and the only
  // parameter here gated on the subscription plan.
  const wantExcerpts = config.extraction === "clean";
  if (wantExcerpts) params.set("extra_snippets", "true");

  let results: BraveResult[];
  try {
    results = await search(params, key);
  } catch (err) {
    // A plan that doesn't include the extra excerpts must not cost us the whole
    // arm — retry once for the snippets Brave will give anyone. If that fails
    // too it's a genuine provider failure, and its error is the honest one.
    if (!wantExcerpts) throw err;
    params.delete("extra_snippets");
    results = await search(params, key);
  }

  const sources: Source[] = results
    .filter((r): r is BraveResult & { url: string } => Boolean(r.url))
    .slice(0, config.num_sources)
    .map((r) => {
      const snippet = r.description ?? "";
      // Only call it content when Brave actually returned more than the snippet.
      // Echoing the description back as `content` would dress a one-line result
      // up as an extracted page in the context handed to the answering model.
      const extras = r.extra_snippets ?? [];
      const content = extras.length
        ? cleanMarkdown([snippet, ...extras].filter(Boolean).join("\n\n"))
        : undefined;
      return {
        title: r.title ?? r.url,
        url: r.url,
        // Brave documents both `page_age` and `age` and describes neither, so
        // take whichever is present; `parsePublished` normalizes either shape.
        published:
          parsePublished(r.page_age, now) ??
          parsePublished(r.age, now) ??
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
