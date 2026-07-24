# Providers

Every retrieval provider in sourcery is an **adapter**: a function from
`(query, config)` to `{ sources, context }`, plus enough metadata to tell a user
why it isn't working. That's the whole interface. Adding one is a single file and
a single registry entry — see [Writing an adapter](#writing-an-adapter).

```bash
sourcery providers          # what's registered, and which keys you're missing
```

---

## The registered adapters

| id | Keys needed | Discovery | Extraction |
|---|---|---|---|
| `bright_data` | `BRIGHTDATA_API_TOKEN`, `BRIGHTDATA_SERP_ZONE`, `BRIGHTDATA_UNLOCKER_ZONE` | Google SERP via proxy | separate Web Unlocker call per URL |
| `firecrawl` | `FIRECRAWL_API_KEY` | its own search endpoint | same call, via `scrapeOptions` |
| `tavily` | `TAVILY_API_KEY` | its own index, RAG-tuned | same call, via `include_raw_content` |
| `exa` | `EXA_API_KEY` | its own neural index | same call, via `contents.text` |
| `plain` | *none* | keyless SERP (Mojeek) | bare `fetch()` + regex de-tagging |

`tavily` and `exa` are written against each provider's current published request
shape but **have not been exercised against the live APIs** — there were no keys
on hand when they were written. Treat the first run of either as a smoke test.

---

## Bright Data

Bright Data is two products stitched together, which is why it needs three env
vars and why it's the slowest arm.

**Zone setup.** In the Bright Data dashboard create two zones:

1. A **SERP API** zone → `BRIGHTDATA_SERP_ZONE`. This is what turns a query into
   a ranked list of URLs.
2. A **Web Unlocker** zone → `BRIGHTDATA_UNLOCKER_ZONE`. This is what fetches
   each of those URLs through unblocking infrastructure and returns markdown.

Both authenticate with the same `BRIGHTDATA_API_TOKEN`. The zone *names* are
account-specific strings you choose at creation time — there are no defaults to
fall back on, and a wrong name fails at request time, not at startup.

**Known flakiness — and why there's no blocklist.** A SERP request occasionally
lands on a bad proxy exit and returns a *dictionary or definition page* for a
one-word token in the query (searching a phrase containing "battery" once came
back with the definition of "battery"). The retry loop accepts any response with
a non-empty `organic` array, so a garbage-but-well-formed SERP gets through.

This was investigated and deliberately left alone. The eval's own
`retrieval_score` graded that arm **0/10** — the system caught its own bad
retrieval, which is what it's for. A dictionary-domain blocklist would suppress
exactly the signal the eval exists to measure. One transient outlier across
hundreds of arms is absorbed by the confidence intervals.

**Cost shape.** One SERP call plus *N* Unlocker calls per arm, where N is
`num_sources`. Extraction dominates both the latency and the bill.

---

## Firecrawl

One call does discovery and extraction together — `scrapeOptions` on the search
request returns each result's markdown inline. That's the pitch, and it's why
this arm is roughly half the latency of Bright Data.

**Credit math, because it will bite you.** Published rates:

- search — **2 credits per 10 results**
- scrape — **1 credit per page**

So one arm at `num_sources: 8` with extraction on costs about **10 credits**
(2 for the search, 8 for the scrapes). Which means:

| Run | Firecrawl arms | ≈ credits |
|---|---:|---:|
| `run` (one query, one arm) | 1 | 10 |
| `batch` (48 queries) | 48 | ~480 |
| `credibility --seeds 5` | 240 | **~2,400** |

Plans are Free 1,000/mo · Hobby $16/mo 5,000 · Standard $83/mo 100,000.

**A full 5-seed credibility run does not fit in the free tier and never did** —
2,400 needed against 1,000 available. A 2-seed run (~960) technically fits a
fresh month with no margin for a retry. This is worth internalizing before
planning a big run, because the failure mode is ugly: the API returns
`402 Insufficient credits` per request, so without the circuit breaker a 480-arm
run grinds for hours producing nothing but errors. `sourcery credibility` now
aborts once a provider fails its first arms with zero successes.

Check the balance before a long run:

```bash
curl -s https://api.firecrawl.dev/v2/team/credit-usage \
  -H "Authorization: Bearer $FIRECRAWL_API_KEY"
```

---

## Tavily

Built for RAG, so the default response is already snippet-shaped;
`include_raw_content: "markdown"` adds full page text. Freshness maps onto its
`time_range` enum (`day` / `month` / `year`).

**Eval caveat:** Tavily returns **no per-result publish date**. Every date for
this arm is inferred by the date ladder (snippet → body text → URL path), which
is strictly worse than a native date. Don't compare its median-source-age number
against Exa's without saying so.

## Exa

Neural search over its own crawled index rather than a Google proxy.

Two differences that matter for the eval, both by design rather than defect:

- It reports a real `publishedDate`, making it the **cleanest date signal** of
  any adapter here.
- Its freshness knob is a hard `startPublishedDate` filter, not Google's soft
  `tbs` recency bias. A `24h` arm can legitimately return **fewer sources than
  requested** rather than silently drifting older. If you're comparing source
  counts across arms with freshness on, that's why.

---

## `plain` — the free baseline

The control arm: what you get for $0 with no account anywhere. A keyless SERP,
`fetch()`, and a regex de-tagger. No proxy rotation, no JS rendering, no
boilerplate stripping. It exists for two reasons: `sourcery run` works with zero
keys, and the paid providers have a floor to clear.

**Read this before quoting it.**

1. **It is not a controlled ablation.** It differs from the Google-backed
   providers on *two* axes at once — a different (smaller, independent) search
   index **and** naive extraction. So it's a floor, not a one-variable
   comparison. If you want to isolate the value of the extraction layer
   specifically, hold discovery constant instead: same SERP, swap only how pages
   are fetched.
2. **It rate-limits, hard.** Roughly ten queries in quick succession earns a
   captcha page (HTTP 200 with no results, not a 429), and continuing earns a
   403 that persists for minutes. The adapter retries with 5s→40s backoff and
   sniffs for the captcha interstitial, but this arm is *deliberately not in any
   default arm set*. It is a zero-setup way to try the tool, not a provider to
   benchmark at 480 arms.
3. **Its failures bias it upward.** Arms that error are excluded from the
   aggregates, so a blocked `plain` arm silently disappears rather than scoring
   0. Its mean therefore reflects only the queries it *managed* to serve. Report
   its error rate alongside its score or the number flatters it.

That third point is the general lesson, not a `plain` quirk: **an eval that drops
failures measures the happy path.** Check `n_errors` before believing any mean.

---

## Writing an adapter

The contract, in full:

```ts
(query: string, config: ArmConfig) => Promise<{ sources: Source[]; context: string }>
```

`ArmConfig` carries the three knobs the eval sweeps — `freshness`,
`num_sources`, `extraction`. A `Source` is `{ title, url, published, domain,
snippet?, content? }`, where `published` is an ISO date or `null`.

A complete adapter, start to finish:

```ts
import { ArmConfig, FetchResult, Source } from "../types";
import { host, toContext } from "./util";
import { cleanMarkdown } from "../extract";
import { dateFromSnippet, dateFromUrl, parsePublished } from "../date";

export async function fetchAcme(
  query: string,
  config: ArmConfig,
): Promise<FetchResult> {
  const key = process.env.ACME_API_KEY;
  if (!key) throw new Error("ACME_API_KEY not set");

  const res = await fetch("https://api.acme.dev/search", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ q: query, n: config.num_sources }),
  });
  // Put the provider's own error text in the message — it's what you'll debug from.
  if (!res.ok) throw new Error(`Acme ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const { results = [] } = await res.json();
  const now = Date.now();

  const sources: Source[] = results.slice(0, config.num_sources).map((r) => ({
    title: r.title ?? r.url,
    url: r.url,
    published: parsePublished(r.date, now) ?? dateFromSnippet(r.summary, now) ?? dateFromUrl(r.url),
    domain: host(r.url),
    snippet: r.summary ?? "",
    content: r.body ? cleanMarkdown(r.body) : undefined,
  }));

  return { sources, context: toContext(sources) };
}
```

Then register it in `core/adapters/index.ts`:

```ts
acme: {
  id: "acme",
  label: "Acme",
  requiredEnv: ["ACME_API_KEY"],
  blurb: "One line, shown by `sourcery providers`.",
  fetch: fetchAcme,
},
```

That's it — `sourcery run "…" --values acme,firecrawl` now works.

### Five things that decide whether your numbers mean anything

1. **Throw, don't return empty.** A thrown error becomes a recorded arm error. A
   silent empty result becomes a *legitimate-looking score of zero* and quietly
   drags the provider's mean down.
2. **Respect `config.extraction`.** When it's `"raw"`, skip page extraction
   entirely and leave `content` undefined — the eval falls back to snippets.
   Fetching anyway makes the `extraction` axis measure nothing.
3. **Fill `published` as well as you honestly can, and no better.** Median source
   age is a headline metric. Prefer a provider-native date; fall back through the
   ladder in `core/date.ts`. Never invent one — `null` is a real answer.
4. **Truncate with `cleanMarkdown`.** It strips nav-link spam and caps length, so
   every arm hands the answer model a comparable amount of context. Skipping it
   means your arm wins on context volume rather than quality.
5. **Map freshness to the closest thing your provider has, and document the
   mismatch.** A hard publish-date filter and a soft recency bias are not the
   same knob, and the difference shows up in source counts.
