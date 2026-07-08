// Content extraction for the Bright Data arm: after SERP discovers URLs, we
// fetch each page's real content through the Web Unlocker as markdown. This is
// what makes the eval honest — the answering model sees actual page text, not
// just a one-line SERP snippet. Extraction is best-effort per URL: a failure
// degrades that one source to its snippet, it never fails the whole arm.

const ENDPOINT = "https://api.brightdata.com/request";

const EXTRACT_CONCURRENCY = 4; // ~3–8s/URL; cap so a 6-source arm stays under maxDuration
const CONTENT_CHARS = 1600; // per-source truncation handed into the answer context
const PER_URL_TIMEOUT_MS = 15000;

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

/**
 * Extract content for a batch of URLs in parallel (bounded). Returns a
 * cleaned-markdown string per input index, or null where extraction failed.
 */
export function extractAll(urls: string[]): Promise<(string | null)[]> {
  return mapWithConcurrency(urls, EXTRACT_CONCURRENCY, async (url) => {
    try {
      const content = await unlock(url);
      return content.length > 40 ? content : null; // empty/near-empty = miss
    } catch {
      return null;
    }
  });
}
