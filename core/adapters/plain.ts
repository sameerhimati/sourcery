// The control arm: what you get for $0, with no account anywhere.
//
// A keyless SERP (Mojeek — an independent crawler that still serves plain HTML
// to plain clients) plus `fetch()` and a regex de-tagger. No proxy rotation, no
// JS rendering, no boilerplate stripping beyond the obvious. Every paid provider
// in this eval should beat it; the interesting number is BY HOW MUCH, because
// that gap is what the money actually buys.
//
// Read the caveat in docs/providers.md before quoting this arm: it differs from
// the Google-backed providers on TWO axes (different index AND naive extraction),
// so it's a floor to clear, not a controlled one-variable ablation.

import { ArmConfig, FetchResult, Source } from "../types";
import { host, toContext } from "./util";
import { cleanMarkdown, mapWithConcurrency } from "../extract";
import { dateFromSnippet, dateFromUrl, dateFromContent, parsePublished } from "../date";

const SERP = "https://www.mojeek.com/search";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const PER_URL_TIMEOUT_MS = 12000;
const FETCH_CONCURRENCY = 4;
// Keyless search rate-limits hard: hammer it and you get a captcha page (HTTP
// 200, no results) rather than a 429. Back off and retry a few times. This is
// the unglamorous work a paid SERP API is doing on your behalf.
// Measured, not guessed: ~10 queries in quick succession earns a captcha page,
// and further requests during the block escalate it to an outright 403 that
// outlives several minutes of quiet. Crucially, retrying INTO a block extends it
// — so this retries once and gives up, rather than digging. `plain` is therefore
// deliberately NOT in any default arm set: it is a zero-setup way to try the
// tool on a handful of queries, not a provider to benchmark at 480 arms.
const SERP_ATTEMPTS = 2;
const SERP_BACKOFF_MS = 6000;

interface SerpHit {
  url: string;
  title: string;
  snippet: string;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e: string) => {
      if (e[0] === "#") {
        const code = e[1] === "x" || e[1] === "X"
          ? parseInt(e.slice(2), 16)
          : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      const named: Record<string, string> = {
        amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
        rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
        mdash: "—", ndash: "–", hellip: "…", rsaquo: "›",
      };
      return named[e] ?? m;
    });
}

/** Strip tags → text. Exported for tests; this crudeness is the point. */
export function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|svg|head)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<\/(p|div|li|h[1-6]|tr|section|article|br)\s*>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Pull organic results out of a Mojeek SERP page. Exported for tests. */
export function parseSerp(html: string): SerpHit[] {
  const hits: SerpHit[] = [];
  // Mojeek delimits each organic result with <!--rs--> … <!--re-->, and inside
  // it: <h2><a class="title" href=URL>TITLE</a></h2> then <p class="s">SNIPPET</p>.
  const blocks = html.split("<!--rs-->").slice(1);
  for (const block of blocks) {
    const body = block.split("<!--re-->")[0];
    const link = /<h2>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(body);
    if (!link) continue;
    const url = decodeEntities(link[1]);
    if (!/^https?:\/\//i.test(url)) continue;
    const snip = /<p class="s">([\s\S]*?)<\/p>/i.exec(body);
    hits.push({
      url,
      title: stripTags(link[2]) || url,
      snippet: snip ? stripTags(snip[1]) : "",
    });
  }
  return hits;
}

/** A naive impl would still read the obvious meta tags — so this one does. */
function dateFromHtml(html: string, now: number): string | null {
  const patterns = [
    /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["'](?:date|pubdate|publish-date|dc\.date)["'][^>]+content=["']([^"']+)["']/i,
    /"datePublished"\s*:\s*"([^"]+)"/i,
    /<time[^>]+datetime=["']([^"']+)["']/i,
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    const iso = m ? parsePublished(m[1], now) : null;
    if (iso) return iso;
  }
  return null;
}

async function getPage(url: string): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PER_URL_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,*/*" },
      signal: ctrl.signal,
    });
    // No retries, no proxy rotation, no unblocking — a 403 is just a miss. That
    // failure rate is a headline number for this arm, so don't paper over it.
    if (!res.ok) return null;
    const type = res.headers.get("content-type") ?? "";
    if (!/html|text/i.test(type)) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A captcha interstitial comes back as a normal 200, so sniff for it. */
function isChallenge(html: string): boolean {
  return /<title>\s*Captcha/i.test(html) || !html.includes("results-standard");
}

async function searchWithRetry(query: string): Promise<SerpHit[]> {
  let last = "";
  for (let attempt = 0; attempt < SERP_ATTEMPTS; attempt++) {
    if (attempt) await sleep(SERP_BACKOFF_MS * 2 ** (attempt - 1));
    const res = await fetch(`${SERP}?q=${encodeURIComponent(query)}`, {
      headers: { "User-Agent": UA, Accept: "text/html" },
    });
    if (!res.ok) {
      last = `HTTP ${res.status}`;
      continue;
    }
    const html = await res.text();
    if (isChallenge(html)) {
      last = "captcha/rate-limited";
      continue;
    }
    const hits = parseSerp(html);
    if (hits.length) return hits;
    last = "no parseable results";
  }
  throw new Error(
    `Plain SERP failed after ${SERP_ATTEMPTS} attempts (${last}). Keyless search ` +
      `blocks sustained automated use, and the block extends while you retry — ` +
      `wait a few minutes, or use a provider with an API key for real runs.`,
  );
}

export async function fetchPlain(
  query: string,
  config: ArmConfig,
): Promise<FetchResult> {
  // NOTE: `config.freshness` is deliberately ignored — the keyless endpoint has
  // no dependable equivalent of Google's `tbs`. That means a `--variable
  // freshness` sweep produces IDENTICAL arms for this provider and a difference
  // of exactly zero, which reads like a finding and isn't one. Don't sweep
  // freshness against `plain`; not being able to ask for recency is itself part
  // of what the free option costs you.
  const hits = (await searchWithRetry(query)).slice(0, config.num_sources);

  const now = Date.now();
  const pages =
    config.extraction === "clean"
      ? await mapWithConcurrency(hits, FETCH_CONCURRENCY, (h) => getPage(h.url))
      : hits.map(() => null);

  const sources: Source[] = hits.map((h, i) => {
    const html = pages[i];
    const text = html ? cleanMarkdown(stripTags(html)) : undefined;
    return {
      title: h.title,
      url: h.url,
      published:
        (html ? dateFromHtml(html, now) : null) ??
        dateFromSnippet(h.snippet, now) ??
        dateFromContent(text, now) ??
        dateFromUrl(h.url),
      domain: host(h.url),
      snippet: h.snippet,
      content: text && text.length > 40 ? text : undefined,
    };
  });

  return { sources, context: toContext(sources) };
}
