// Parallel: a web index built for agents rather than people. One POST returns
// ranked URLs plus "excerpts" — relevance-selected passages of each page, already
// compressed for a model to read — and a native publish date.
//
// Parallel sells several products and only this one belongs in the eval. Their
// Task / Deep Research API is an asynchronous agent that returns a written,
// cited answer: pointing an arm at it would have the provider do the job we are
// grading the model on, and would measure a submit-and-poll wait instead of a
// search. `/v1/search` is a single synchronous call (~3s on the `advanced` tier),
// so the latency this arm records is comparable to every other arm's.
//
// Two caveats to quote alongside its numbers. Excerpts are passages, not whole
// pages — full-page markdown is a separate Extract product this adapter does not
// call — so the "clean" arm gets dense partial text where Firecrawl and Tavily
// get the whole document. And there is no way to switch excerpts off, so the
// "raw" arm here is not the snippet-only baseline it is everywhere else. The
// extraction axis says less about this provider than about the others.
//
// Like Exa it reports a real `publish_date`, so its freshness comes from the
// provider rather than the date ladder, and its recency knob is a hard filter
// rather than Google's soft `tbs` bias — a tight window can legitimately return
// fewer sources than asked for instead of drifting older.

import { ArmConfig, FetchResult, Source } from "../types";
import { host, toContext } from "./util";
import { cleanMarkdown } from "../extract";
import { dateFromSnippet, dateFromUrl, dateFromContent, parsePublished } from "../date";

const ENDPOINT = "https://api.parallel.ai/v1/search";

// Same window→cutoff shape as Exa, with one honest gap: `after_date` is a
// calendar day (YYYY-MM-DD), not an instant, so "24h" can only be expressed as
// "published yesterday or later". This arm's 24h window is really 24–48h wide.
const WINDOW_MS: Record<string, number | undefined> = {
  "24h": 86400000,
  "30d": 30 * 86400000,
  "1y": 365 * 86400000,
  all: undefined,
};

// Excerpts arrive with section headings and site chrome that `cleanMarkdown`
// strips before truncating to its own budget. Ask for several times that budget
// so the cleaning still has something left to hand the answering model.
const EXCERPT_CHARS = 6000;

interface ParallelResult {
  url: string;
  title?: string | null;
  publish_date?: string | null;
  excerpts?: string[];
}

export async function fetchParallel(
  query: string,
  config: ArmConfig,
  now: number = Date.now(),
): Promise<FetchResult> {
  const key = process.env.PARALLEL_API_KEY;
  if (!key) throw new Error("PARALLEL_API_KEY not set");

  const advanced: Record<string, unknown> = {
    // Capped at 20 server-side; above that the API trims and attaches a warning
    // rather than failing, so there is nothing to clamp here.
    max_results: config.num_sources,
  };
  if (config.extraction === "clean") {
    advanced.excerpt_settings = { max_chars_per_result: EXCERPT_CHARS };
  }
  const window = WINDOW_MS[config.freshness];
  if (window) {
    advanced.source_policy = {
      after_date: new Date(now - window).toISOString().slice(0, 10),
    };
  }

  const body = {
    // Parallel takes a natural-language goal AND keyword queries. Every other
    // provider gets exactly one string, so this one gets that same string twice
    // rather than a hand-written objective — a better-phrased goal would be an
    // advantage we granted the provider, not one it earned.
    objective: query,
    search_queries: [query],
    // Their highest-quality tier, matching the choice made for Tavily's
    // `search_depth`. It is also the current default, stated anyway so that
    // Parallel changing that default cannot silently change what an arm measured.
    mode: "advanced",
    // Left alone deliberately: no `fetch_policy`, so results come from Parallel's
    // index rather than a live re-fetch. That is the product's default, and
    // paying extra latency for fresher pages here would flatter this arm on the
    // freshness metric in a way no other adapter is doing.
    advanced_settings: advanced,
  };

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "x-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Parallel ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = (await res.json()) as { results?: ParallelResult[] };

  const sources: Source[] = (data.results ?? [])
    .filter((r) => Boolean(r.url))
    .slice(0, config.num_sources)
    .map((r) => {
      const text = r.excerpts?.length
        ? cleanMarkdown(r.excerpts.join("\n\n"))
        : undefined;
      // Under "raw" the excerpts still arrive — they cannot be turned off — so
      // they land as the snippet instead of as extracted body text. That is the
      // closest this provider gets to a snippet-only arm.
      const content = config.extraction === "clean" ? text : undefined;
      const snippet = content ? content.slice(0, 300) : (text ?? "");
      return {
        title: r.title ?? r.url,
        url: r.url,
        // Native date first — Parallel reports one, so the ladder below only
        // runs for the results where it doesn't.
        published:
          parsePublished(r.publish_date, now) ??
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
