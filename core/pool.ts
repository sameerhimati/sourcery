import type { Provider, Source } from "./types";

// ─── Pooling: the answer key as an output, not an input ───
//
// Run 2 does not write down the right answers in advance. Every page any
// provider returned for a question goes into one pool, each unique
// question-and-page pair is judged once, and the verdict is reused for every
// provider that returned that page. Two things follow, both load-bearing:
//
//   • The same page can never get a different verdict for a different vendor.
//   • The judge never learns which provider returned a page, because by the
//     time judging happens the page has been detached from its providers.
//     Blinding is structural, not a promise.

/**
 * Normalize a URL so the same page returned by two providers pools to one key.
 *
 * Conservative on purpose: it strips only what provably never identifies a
 * different page — the fragment, tracking parameters, a trailing slash, host
 * case. Anything more aggressive (sorting params, dropping "www.") risks
 * merging two genuinely different pages, and a false merge silently gives one
 * provider credit for a page it never returned.
 */
export function normalizeUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return raw.trim();
  }
  u.hash = "";
  const params = u.searchParams;
  const drop: string[] = [];
  for (const key of params.keys()) {
    if (/^utm_/i.test(key) || /^(fbclid|gclid|mc_cid|mc_eid|igshid)$/i.test(key)) {
      drop.push(key);
    }
  }
  for (const key of drop) params.delete(key);
  u.hostname = u.hostname.toLowerCase();
  let out = u.toString();
  // URL serializes a bare query "?" away already; strip one trailing slash so
  // /path/ and /path pool together (and https://a.com/ → https://a.com).
  if (out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

/** The pool/judgement identity of one question-and-page pair. */
export function pairKey(queryId: string, url: string): string {
  return `${queryId}|${url}`;
}

/**
 * One unique question-and-page pair, ready to be judged.
 *
 * `content` is the canonical text for this page: the longest extraction among
 * the providers that returned it. Providers extract the same URL differently,
 * and the pair is judged once, so one text has to stand for the page; longest
 * is the version that gives the page its best shot, and `content_from` records
 * whose extraction that was so the choice stays auditable. Per-provider
 * extraction quality remains measurable from the fetch rows — it just no
 * longer leaks into the relevance verdict.
 */
export interface PooledPage {
  queryId: string;
  query: string;
  url: string; // normalized
  title: string;
  domain: string;
  published: string | null;
  content: string;
  content_from: Provider;
  returned_by: Provider[];
}

/** The slice of a fetch row that pooling needs. */
export interface PoolInput {
  queryId: string;
  query: string;
  provider: Provider;
  sources: Source[];
}

function textOf(s: Source): string {
  return s.content ?? s.snippet ?? "";
}

/**
 * Collapse per-provider fetch results into unique question-and-page pairs.
 * Deterministic: pages come out grouped by query in first-seen order, and
 * `returned_by` in first-seen provider order.
 */
export function buildPool(rows: PoolInput[]): PooledPage[] {
  const pool = new Map<string, PooledPage>();
  for (const row of rows) {
    for (const source of row.sources) {
      const url = normalizeUrl(source.url);
      if (!url) continue;
      const key = pairKey(row.queryId, url);
      const existing = pool.get(key);
      if (!existing) {
        pool.set(key, {
          queryId: row.queryId,
          query: row.query,
          url,
          title: source.title,
          domain: source.domain,
          published: source.published,
          content: textOf(source),
          content_from: row.provider,
          returned_by: [row.provider],
        });
        continue;
      }
      if (!existing.returned_by.includes(row.provider)) {
        existing.returned_by.push(row.provider);
      }
      if (textOf(source).length > existing.content.length) {
        existing.content = textOf(source);
        existing.content_from = row.provider;
      }
      if (!existing.published && source.published) {
        existing.published = source.published;
      }
    }
  }
  return [...pool.values()];
}

/**
 * The normalized URLs a provider returned for a query, deduped, order kept.
 * This is the provider's "returned set" that scoring runs over — it is derived
 * here so scoring and pooling can never disagree about what counts as a page.
 */
export function returnedUrls(sources: Source[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of sources) {
    const url = normalizeUrl(s.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}
