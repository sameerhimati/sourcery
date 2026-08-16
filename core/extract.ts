// Content extraction for the Bright Data arm: after SERP discovers URLs, we
// fetch each page's real content through the Web Unlocker as markdown. This is
// what makes the eval honest — the answering model sees actual page text, not
// just a one-line SERP snippet. Extraction is best-effort per URL: a failure
// degrades that one source to its snippet, it never fails the whole arm.

const ENDPOINT = "https://api.brightdata.com/request";

const EXTRACT_CONCURRENCY = 4; // cap so one arm cannot monopolise the unlocker
const CONTENT_CHARS = 1600; // per-source truncation handed into the answer context
// Measured against the live unlocker on 2026-08-16: 3.2s, 10.3s, 65.3s for three
// real pages. The old 15s cap was set from a stale "~3–8s/URL" estimate, and it
// was aborting extractions we then recorded as pages with no content — charging
// the provider for our own timeout. extractAll() swallows failures into null, so
// this was invisible: 7% of Bright Data's sources carried text before the change.
const PER_URL_TIMEOUT_MS = 60000;

/**
 * Run `fn` over `items` with a bounded number in flight at once. Order of
 * results matches input order. Rejections are the caller's to handle inside `fn`.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Collapse markdown boilerplate (nav link spam, blank runs) and truncate. */
export function cleanMarkdown(md: string, limit = CONTENT_CHARS): string {
  const text = md
    .replace(/\r/g, "")
    // drop lines that are only a markdown link (nav/menu chrome)
    .replace(/^\s*[-*]?\s*\[[^\]]*\]\([^)]*\)\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > limit ? text.slice(0, limit) + "…" : text;
}

/**
 * Fetch one URL's content via Bright Data Web Unlocker → cleaned markdown.
 * Throws on non-2xx or timeout so the caller can fall back to the snippet.
 */
export async function unlock(url: string): Promise<string> {
  const token = process.env.BRIGHTDATA_API_TOKEN;
  const zone = process.env.BRIGHTDATA_UNLOCKER_ZONE;
  if (!token) throw new Error("BRIGHTDATA_API_TOKEN not set");
  if (!zone) throw new Error("BRIGHTDATA_UNLOCKER_ZONE not set");

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PER_URL_TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        zone,
        url,
        format: "raw",
        data_format: "markdown",
        country: "us",
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Unlocker ${res.status}: ${text.slice(0, 200)}`);
    }
    return cleanMarkdown(await res.text());
  } finally {
    clearTimeout(timer);
  }
}

/** Why one URL produced no text. `null` content without one of these is a bug. */
export type ExtractMiss = "timeout" | "empty" | "http_error" | "network";

export interface ExtractResult {
  content: string | null;
  miss?: ExtractMiss;
  ms: number;
}

/**
 * Extract content for a batch of URLs in parallel (bounded), recording WHY each
 * miss happened.
 *
 * This used to collapse timeout, empty-body and error into a bare `null`, which
 * made our own aborted extractions indistinguishable from a page the provider
 * genuinely could not return. That is how a 15s cap on a provider needing 10-65s
 * was nearly published as "Bright Data returns almost no page text". A miss we
 * cannot explain must never be attributed to a vendor.
 */
export async function extractAllDetailed(urls: string[]): Promise<ExtractResult[]> {
  return mapWithConcurrency(urls, EXTRACT_CONCURRENCY, async (url) => {
    const started = Date.now();
    // One retry on an empty body. Measured 2026-08-16 over 40 URLs that returned
    // nothing during a run: 10 produced full text on a second attempt and 30 were
    // consistently empty. The unlocker is flaky as well as selective, so a single
    // attempt understates what the provider can actually return — and that
    // understatement lands on the provider's score, not ours.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const content = await unlock(url);
        if (content.length > 40) return { content, ms: Date.now() - started };
        if (attempt === 1) return { content: null, miss: "empty" as const, ms: Date.now() - started };
      } catch (e) {
        const aborted = e instanceof Error && (e.name === "AbortError" || /abort/i.test(e.message));
        const http = e instanceof Error && /^Unlocker \d/.test(e.message);
        // A timeout or an HTTP error is not the flakiness the retry is for.
        if (aborted || http || attempt === 1) {
          return {
            content: null,
            miss: aborted ? ("timeout" as const) : http ? ("http_error" as const) : ("network" as const),
            ms: Date.now() - started,
          };
        }
      }
    }
    return { content: null, miss: "empty" as const, ms: Date.now() - started };
  });
}

/** Content-only view, for callers that do not report on misses. */
export async function extractAll(urls: string[]): Promise<(string | null)[]> {
  return (await extractAllDetailed(urls)).map((r) => r.content);
}
