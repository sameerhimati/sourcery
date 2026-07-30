# Providers

Every retrieval provider in sourcery is an **adapter**: a function from
`(query, config)` to `{ sources, context }`, plus enough metadata to tell a user
why it isn't working. That's the whole interface. Adding one is a single file and
a single registry entry — see [Writing an adapter](#writing-an-adapter).

```bash
sourcery providers          # what's registered, and which keys you're missing
sourcery providers --check  # ...and whether the account will actually serve a run
```

A set key is not the same as a usable account. `--check` calls each adapter's
optional `health()` probe — quota-neutral by contract — because an exhausted
balance is indistinguishable from a healthy one until arms start failing.

---

## The registered adapters

| id | Status | Keys needed | Discovery | Extraction |
|---|---|---|---|---|
| `bright_data` | **measured** — 240 arms | `BRIGHTDATA_API_TOKEN`, `BRIGHTDATA_SERP_ZONE`, `BRIGHTDATA_UNLOCKER_ZONE` | Google SERP via proxy | separate Web Unlocker call per URL |
| `firecrawl` | **measured** — 240 arms | `FIRECRAWL_API_KEY` | its own search endpoint | same call, via `scrapeOptions` |
| `tavily` | **measured** — 18 arms | `TAVILY_API_KEY` | its own index, RAG-tuned | same call, via `include_raw_content` |
| `exa` | **measured** — 18 arms | `EXA_API_KEY` | its own neural index | same call, via `contents.text` |
| `plain` | *baseline only* | *none* | keyless SERP (Mojeek) | bare `fetch()` + regex de-tagging |

**What the statuses mean, because the distinction is the point of this tool:**

- **measured** — this adapter has been run against the live API, and the arm count
  says how far. The distinction inside that word matters:
  - **240 arms** (`bright_data`, `firecrawl`) — the full 48-query credibility set,
    5 repeats, two-judge panel. This is what supports the confidence intervals in
    the README.
  - **18 arms** (`tavily`, `exa`) — 6 queries, one per category, 3 repeats, single
    judge. Enough to confirm the adapter works against the live API and returns
    plausible sources. **Not enough to rank it against anything.** Treat any
    ordering that includes these two as an anecdote.
- **baseline only** — works, but not something to benchmark against. See
  [`plain`](#plain--the-free-baseline) below for why.

The arm count is published rather than collapsed into a checkmark because the gap
between 240 and 18 is exactly the gap this tool exists to make visible. **`--values
tavily,exa` is a working comparison, but an underpowered one** — if you need a real
answer for those two, run the full set yourself and you'll have it.

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

**Credit math, because it bit me.** Unit rates:

- search — **2 credits**, per source type, per 10 results
- scrape — **1 credit per page**

The trap is the *per source type* clause. `fetchFirecrawl` requests
`sources: ["web", "news"]` — news is where the native `publishedDate` values come
from, and the freshness metric leans on them. But asking for two source types
buys **two searches and two sets of scrapes.** So one arm at `num_sources: 8`
with extraction on is:

```
2 searches × 2 credits  +  16 pages × 1 credit  =  20 credits
```

not the 10 this doc and `firecrawl.ts` both claimed for months.

**Measured, 2026-07-29.** Three controlled `/v2/search` calls at `limit: 8`,
diffing `remainingCredits` before and after each:

| Request | Cost | What it isolates |
|---|---:|---|
| `sources: ["web"]`, no `scrapeOptions` | **2** | search alone |
| `sources: ["web"]` + markdown scrapes | **10** | +8 → 1 credit per page |
| `sources: ["web","news"]` + scrapes | **20** | +10 → a second search *and* 8 more scrapes |

The third row is exactly what the adapter sends. Cross-checked against the
account's activity log, where real arms billed **20 to 65** credits — 20 is the
floor, and it climbs when a query surfaces pages Firecrawl has to escalate to a
heavier browser path to read (government statistics sites were the worst). Cost
is a property of the *targets a query happens to surface*, not of the query.

So the real budget, at `num_sources: 8`:

| Run | Firecrawl arms | ≈ credits (floor) | hard targets (~3×) |
|---|---:|---:|---:|
| `run` (one query, one arm) | 1 | 20 | 60 |
| `batch` (48 queries) | 48 | ~960 | ~2,900 |
| `credibility --seeds 5` | 240 | **~4,800** | ~14,400 |

Plans are Free 1,000/mo · Hobby $16/mo 5,000 · Standard $83/mo 100,000.

**This is where a 5,000/mo plan went.** A full 5-seed credibility run costs
~4,800 at the floor — it consumes an entire Hobby month by itself, and it does
not fit the free tier at any seed count above 2. The old flat estimate of 10
reported *twice* the runway that existed, so `providers --check` said "≈ 500
arms" on a balance that covered 250. The failure mode is ugly: the API returns
`402 Insufficient credits` per request, so a 480-arm run grinds for hours
producing nothing but errors. `sourcery credibility` now aborts once a provider
fails its first arms with zero successes.

Two ways to cut the bill, if you need to:

- **`extraction: "raw"`** drops the scrapes entirely — 20 → 4 credits per arm.
  You lose the extracted page text, so `retrieval_score` gets thinner evidence.
- **Dropping `"news"`** from `sources` halves it — 20 → 10. But that's where the
  reliable publish dates live, so the freshness numbers degrade to the date
  ladder used by the other adapters. Not recommended for a run you intend to
  publish; reasonable while iterating.

Check the balance before a long run — it now quotes a range, because the
optimistic end is the only thing a floor-cost estimate can honestly promise:

```bash
sourcery providers --check   # → "932 credits of 5000/mo ≈ 15-46 arms at 20+/arm"
```

Better, price the specific run you're about to start. `batch` and `credibility`
both cost themselves up front against the live balance:

```bash
sourcery batch --per-type 1 --providers firecrawl,tavily,exa --dry-run
#   firecrawl       6 arms  120-360 credits  932 left
#   tavily          6 arms  unmetered (own quota / free)
#   exa             6 arms  unmetered (own quota / free)
#                total: 120-360 credits
```

`--max-credits <n>` refuses to start when the run *could* exceed `n`. It checks
the **pessimistic** end deliberately: a run that only fits if every page scrapes
cleanly is a run that strands itself on the first hard target, which is exactly
how the credit overrun above happened. `--dry-run` costs it and exits; `--yes`
skips the confirmation. Only Firecrawl reports a number — Bright Data bills
bandwidth, Tavily and Exa meter their own quotas, and `plain` is free, so they
show as *unmetered* rather than being guessed at.

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
2. **It gets blocked, and the block compounds.** Measured behaviour: roughly ten
   queries in quick succession earns a captcha page (HTTP 200 with no results —
   not a 429), and requests made *during* the block escalate it to an outright
   403. Retrying into a block extends it, which is why the adapter retries
   exactly once and then gives up rather than digging.

   **Recovery is not quick and not guaranteed.** Measured over one session: an
   early block lifted after ~4 idle minutes, but after further probing a block
   survived **15 minutes of complete silence** and had not lifted. Assume a
   block can outlast whatever you were about to do.

   The practical consequence: this arm is *deliberately not in any default arm
   set*. It is a zero-setup way to try the tool on a handful of queries, not a
   provider to benchmark at 480 arms. And it's a finding in its own right — the
   free option isn't merely lower quality, its **availability is
   non-deterministic**. Reliable access under sustained automated load is a
   large part of what a paid retrieval provider actually sells.
3. **It ignores the `freshness` knob.** The keyless endpoint has no dependable
   `tbs` equivalent, so a `--variable freshness` sweep yields *identical* arms
   for this provider and a difference of exactly zero — which reads like a
   finding and isn't one. Don't sweep freshness against `plain`. (That you
   can't ask the free option for recency at all is, separately, a real cost.)
4. **Its 1,600-char excerpt is mostly page chrome.** Every arm truncates each
   source to ~1,600 characters via `cleanMarkdown`, whose boilerplate filter
   drops lines that are *markdown* links — effective on the markdown the paid
   providers return, and a complete no-op on the plain text `stripTags` produces.
   So where a paid arm spends its budget on article prose, `plain` often spends
   it on the nav menu. That is a fair depiction of naive extraction, but it means
   part of the measured gap is the truncation interacting badly with untidied
   text, not retrieval quality alone. Don't attribute the whole gap to the
   provider.
5. **Its failures bias it upward.** Arms that error are excluded from the
   aggregates, so a blocked `plain` arm silently disappears rather than scoring
   0. Its mean therefore reflects only the queries it *managed* to serve. Report
   its error rate alongside its score or the number flatters it.

That last point is the general lesson, not a `plain` quirk: **an eval that drops
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
