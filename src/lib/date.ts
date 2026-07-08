// Publish-date parsing. Providers hand us dates in wildly inconsistent shapes
// (ISO, "July 2, 2026", "Oct 18, 2025", "1 month ago") and often none at all —
// so every extractor here returns an ISO date string OR null, never throws, and
// the UI is expected to render null as "unknown". Empirically (see the live
// smoke tests): Bright Data SERP `last_modified_date` is almost always null but
// snippets frequently lead with a date; Firecrawl page metadata carries a date
// only for real articles, under inconsistently-cased keys.

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** Clamp a parsed date to a sane window and emit YYYY-MM-DD, else null. */
function toISO(d: Date | null): string | null {
  if (!d || Number.isNaN(d.getTime())) return null;
  const year = d.getUTCFullYear();
  // Reject garbage (epoch-0 pages, far-future typos). 2000..now+1d is generous.
  if (year < 2000 || d.getTime() > Date.now() + 86400000) return null;
  return d.toISOString().slice(0, 10);
}

/** "July 2, 2026" / "Oct 18, 2025" / "Jul 2 2026" → Date. */
function parseWordyDate(s: string): Date | null {
  const m = s.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if (!m) return null;
  const mon = MONTHS[m[1].slice(0, 3).toLowerCase()];
  if (mon === undefined) return null;
  return new Date(Date.UTC(Number(m[3]), mon, Number(m[2])));
}

/** "5 days ago" / "1 month ago" / "today" / "yesterday", anchored to `now`. */
function parseRelative(s: string, now: number): Date | null {
  const t = s.toLowerCase().trim();
  if (/^today\b/.test(t)) return new Date(now);
  if (/^yesterday\b/.test(t)) return new Date(now - 86400000);
  const m = t.match(/^(\d+)\s*(hour|day|week|month|year)s?\s+ago/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = { hour: 3600000, day: 86400000, week: 604800000, month: 2592000000, year: 31536000000 }[m[2]]!;
  return new Date(now - n * unit);
}

/** `/2026/06/18/` or `/2026/06/` in a URL path → Date. */
function parseUrlDate(url: string): Date | null {
  const m = url.match(/\/(20\d{2})\/(\d{1,2})(?:\/(\d{1,2}))?\//);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3] ?? 1)));
}

/**
 * Normalize any single provider/native date value to ISO or null.
 * Handles ISO strings, wordy dates, and relative phrases.
 */
export function parsePublished(
  input: string | null | undefined,
  now: number = Date.now(),
): string | null {
  if (!input) return null;
  const s = String(input).trim();
  if (!s) return null;

  // Native ISO / RFC — let Date try first (covers "2026-07-02T04:27:42Z").
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return toISO(new Date(s));

  return (
    toISO(parseRelative(s, now)) ??
    toISO(parseWordyDate(s)) ??
    null
  );
}

/**
 * Pull a leading date out of a search snippet, e.g.
 * "July 2, 2026. OpenAI proposes…" or "5 days ago — …".
 */
export function dateFromSnippet(
  snippet: string | null | undefined,
  now: number = Date.now(),
): string | null {
  if (!snippet) return null;
  const head = snippet.slice(0, 40);
  return (
    toISO(parseRelative(head, now)) ??
    toISO(parseWordyDate(head)) ??
    null
  );
}

/** Date embedded in a URL path (blogs, news CMSes). */
export function dateFromUrl(url: string): string | null {
  return toISO(parseUrlDate(url));
}

/**
 * Leading date inside extracted page content — articles often print the
 * publish date near the top ("Introducing X  May 28, 2026"). Scans a short
 * head window with the wordy/relative parsers only (no bare-year matching, to
 * avoid grabbing copyright years).
 */
export function dateFromContent(
  content: string | null | undefined,
  now: number = Date.now(),
): string | null {
  if (!content) return null;
  const head = content.slice(0, 400);
  return (
    toISO(parseRelative(head, now)) ??
    toISO(parseWordyDate(head)) ??
    null
  );
}

const DATE_META_KEYS = [
  "article:published_time",
  "og:published_time",
  "publishedtime",
  "datepublished",
  "date",
  "article:modified_time",
  "og:updated_time",
  "modifiedtime",
  "datemodified",
];

/**
 * Best publish date from a page-metadata bag (Firecrawl `metadata`), matching
 * keys case-insensitively and preferring *published* over *modified*. Returns
 * ISO or null.
 */
export function dateFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
  now: number = Date.now(),
): string | null {
  if (!metadata) return null;
  const lower: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(metadata)) lower[k.toLowerCase()] = v;
  for (const key of DATE_META_KEYS) {
    const v = lower[key];
    if (typeof v === "string") {
      const iso = parsePublished(v, now);
      if (iso) return iso;
    }
  }
  return null;
}
