#!/usr/bin/env node
// Re-derive every number the run-2 report cites into one small JSON.
//
// The report has tables, and the report will have charts. If the chart is drawn
// from one computation and the sentence beside it was typed from another, they
// drift, and the first person to notice is a reader who now distrusts both. So
// there is exactly one file — docs/report-data.json — and prose and charts both
// read it.
//
// Where .sourcery/pooled-summary.json already holds a number, it is passed
// through rather than recomputed. Recomputing an aggregate that already exists
// is how two versions of it come to exist.
//
// The script checks itself. Every number it emits is compared against the
// numbers printed in docs/run-2-findings.md, and it exits non-zero if one
// moved. A mismatch means the draft is wrong or this script is, and either way
// somebody has to look.
//
// Run it with tsx, not node: it imports `normalizeUrl` from core/pool.ts so the
// page join uses the exact function that produced the urls in the judgement
// log. A second copy of that function in this file would work today and drift
// the first time the real one changes, and the drift would show up as pages
// quietly failing to match.
//
// Usage: npx tsx scripts/build-report-data.mjs [outfile]

import fs from "node:fs";
import { normalizeUrl } from "../core/pool.ts";

const OUT = process.argv[2] ?? "docs/report-data.json";
const F = {
  fetches: ".sourcery/pooled-fetches.jsonl",
  judgements: ".sourcery/pooled-judgements.jsonl",
  sets: ".sourcery/pooled-set-verdicts.jsonl",
  summary: ".sourcery/pooled-summary.json",
  costs: "datasets/provider-costs.json",
  base: "datasets/run2-questions.json",
  hard: "datasets/run2-hard.json",
  unanswerable: "datasets/run2-unanswerable.json",
};

const readJsonl = (p) =>
  fs.existsSync(p)
    ? fs
        .readFileSync(p, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean)
    : [];

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

const fetches = readJsonl(F.fetches);
const judgements = readJsonl(F.judgements);
const setVerdicts = readJsonl(F.sets);
const summary = readJson(F.summary);
const costs = readJson(F.costs).providers;

if (!fetches.length || !judgements.length) {
  console.error(`Need ${F.fetches} and ${F.judgements}; one of them is missing or empty.`);
  process.exit(1);
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round = (x, n = 3) => (x === null || x === undefined ? null : Number(x.toFixed(n)));
const pct = (part, whole) => (whole ? Number(((part / whole) * 100).toFixed(1)) : null);

// Keyless SERP is captcha-blocked after a handful of queries: 8 consecutive
// failures, zero successes. It left its 8 rows on disk and run 2 is eight arms,
// not nine. It is a demonstration of the free floor, never a measured provider.
const NOT_AN_ARM = new Set(["plain"]);

// ─── Which questions are which ───
//
// base / hard / unanswerable is not in the summary, so the split comes from the
// frozen dataset files rather than from parsing an id prefix. An id scheme is a
// convention; the dataset files are the definition.
const idsIn = (p) => new Set(readJson(p).map((q) => q.id));
const GROUPS = { base: idsIn(F.base), hard: idsIn(F.hard), unanswerable: idsIn(F.unanswerable) };
const groupOf = (queryId) =>
  GROUPS.base.has(queryId) ? "base" : GROUPS.hard.has(queryId) ? "hard" : GROUPS.unanswerable.has(queryId) ? "unanswerable" : null;

// ─── The fetch rows ───
//
// A question can have more than one row per arm: a repair pass re-fetched what
// an arm still owed. A clean row always beats an errored one; among clean rows
// the newest wins. This is the row set the run's own summary counts, so it is
// what the counts and the per-page-text tables are built from.
const better = (incoming, existing) => {
  if (!existing) return true;
  if (Boolean(existing.error) !== Boolean(incoming.error)) return !incoming.error;
  return (incoming.fetched_at ?? "") >= (existing.fetched_at ?? "");
};
const bestRow = new Map();
for (const f of fetches) {
  if (NOT_AN_ARM.has(f.provider)) continue;
  const k = `${f.queryId} ${f.provider}`;
  if (better(f, bestRow.get(k))) bestRow.set(k, f);
}
const searches = [...bestRow.values()].filter((f) => !f.error);

// Every clean row the log holds, repair-pass duplicates included. The published
// per-page tables were computed over this, so reproducing them means using it —
// see the `bright_data_double_counted` caveat, which is the one place it bites.
const allCleanRows = fetches.filter((f) => !NOT_AN_ARM.has(f.provider) && !f.error);

// ─── The page ratings ───
//
// The log is append-only and resume retries failures, so a page a judge errored
// on and then succeeded on has two rows. One judge rated one page once: keyed by
// question, url AND judge, last good row wins. Without this the same judge is
// counted twice in every mean.
const latest = new Map();
for (const j of judgements) {
  // A judgement that threw is a retry, not a rating. Counting it as a rating
  // reads a transport failure as a judge's opinion of the page.
  if (j.error || j.rung === null) continue;
  latest.set(`${j.queryId} ${j.url} ${j.judge}`, j);
}
const rungs = new Map(); // "queryId normalizedUrl" -> { judge: rung }
for (const j of latest.values()) {
  const k = `${j.queryId} ${normalizeUrl(j.url)}`;
  if (!rungs.has(k)) rungs.set(k, {});
  rungs.get(k)[j.judge] = j.rung;
}
const N_JUDGES = summary.judges.length;

// The set verdicts, deduped the same way. Only the count is needed here — the
// per-provider set averages come from the summary — but the count is worth
// having, because the run's summary counts a verdict the judge returned with no
// score and the findings draft counts only the ones that carry a score. Both
// numbers appear in the draft and they are 5 apart.
const latestSet = new Map();
for (const s of setVerdicts) {
  if (s.error || s.score === null) continue;
  latestSet.set(`${s.queryId} ${s.provider} ${s.judge}`, s);
}
const usableRatings = latest.size;

// The pages one provider returned that carry a rating from all three judges.
//
// Both sides of the join are normalized with the run's own `normalizeUrl`. The
// judgement log stores the pooled url; a fetch row stores the url the provider
// returned, and the two differ by a trailing slash or a tracking parameter often
// enough that joining them as-is loses 40% of some arms' pages. Normalizing both
// sides matches every page for seven arms and 99.9% for the eighth, so the
// average is over what a provider actually returned rather than over the subset
// whose urls happened to need no cleaning.
//
// Deduping by the normalized url also settles the repair-pass problem on its
// own: an arm that was re-fetched has the same page under one key, so no
// question is weighted twice, and no arm needs special-casing.
//
// A page rated by two judges instead of three is left out, so no provider's mean
// is nudged by a page one judge happened to error on.
const ratedPages = (provider, rows) => {
  const seen = new Set();
  const out = [];
  let returned = 0;
  let matched = 0;
  for (const f of rows) {
    if (f.provider !== provider) continue;
    for (const s of f.sources ?? []) {
      const key = `${f.queryId} ${normalizeUrl(s.url)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      returned += 1;
      const r = rungs.get(key);
      if (!r) continue;
      matched += 1;
      const vals = Object.values(r);
      if (vals.length !== N_JUDGES) continue;
      out.push({ queryId: f.queryId, rungs: vals });
    }
  }
  return { pages: out, returned, matched };
};

const pageMean = (pages, group) => {
  const flat = pages.filter((p) => !group || groupOf(p.queryId) === group).flatMap((p) => p.rungs);
  return flat.length ? mean(flat) : null;
};

// ─── The page text tables ───
//
// What a provider calls "page content" varies enough that the word stops
// meaning anything, and none of it shows up in a relevance score. These are
// crude presence tests over the text the provider itself returned — is there a
// heading in it, is there a link — not a judgement about extraction quality.
//
// The denominator is pages that came back with any text at all. Firecrawl and
// Bright Data both return empty text for some pages, and dividing by every page
// would answer "how often did extraction succeed", which is a different
// question from "when text comes back, what shape is it".
const HAS = {
  // A markdown link, heading, bold run or list item: any sign the text was
  // meant to be read as markup rather than as a paragraph.
  markdown: (t) => /^#{1,6}\s/m.test(t) || /\[[^\]]+\]\([^)]+\)/.test(t) || /\*\*[^*]+\*\*/.test(t) || /^[-*] /m.test(t),
  headings: (t) => /^#{1,6}\s/m.test(t),
  // Requires a label and a target, so a truncation that cut a link in half does
  // not count as one.
  links: (t) => /\[[^\]]+\]\([^)]+\)/.test(t),
  // The image marker alone. Alt text and target are often cut by the 1,600-char
  // limit, and a half-written image is still an image the provider kept.
  images: (t) => /!\[/.test(t),
  // A table's separator row. Matching a line with pipes in it counts prose
  // containing a pipe, which overstated every arm by roughly 10 points.
  tables: (t) => /^\|[\s:|-]+\|\s*$/m.test(t),
};
// Every source is cut to 1,600 characters before a judge sees it, and the cut
// leaves an ellipsis. A provider that returned 40KB and one that returned
// stitched snippets reach the judge the same size, so this is the measure of how
// blind the run is to extraction depth.
const TRUNCATION_LIMIT_CHARS = 1600;
const wasTruncated = (t) => t.endsWith("…");

const textsOf = (provider, rows) => {
  const out = [];
  for (const f of rows) {
    if (f.provider !== provider) continue;
    for (const s of f.sources ?? []) {
      const c = s.content ?? "";
      if (c.length) out.push(c);
    }
  }
  return out;
};

// ─── Provider overlap ───
//
// The same page comes back from several providers, is rated once, and the rating
// counts for everyone who returned it. How much that pooling is doing is a fact
// about the indexes, so it gets reported rather than assumed.
//
// Grouped by the pooled url, because that is the grouping the judges actually
// worked in: two arms that returned the same page with different tracking
// parameters returned the same page, and counting them as two hides exactly the
// overlap this is trying to measure.
const groupPages = (keyOf) => {
  const byUrl = new Map();
  for (const f of searches) {
    for (const s of f.sources ?? []) {
      const k = `${f.queryId} ${keyOf(s.url)}`;
      if (!byUrl.has(k)) byUrl.set(k, new Set());
      byUrl.get(k).add(f.provider);
    }
  }
  return [...byUrl.values()].map((s) => s.size);
};
const overlapCounts = groupPages(normalizeUrl);
const overlapRawCounts = groupPages((u) => u);
const nProviders = summary.providers.length;
const overlapShape = (counts) => ({
  n_pages: counts.length,
  from_one_provider: counts.filter((c) => c === 1).length,
  from_one_provider_pct: pct(counts.filter((c) => c === 1).length, counts.length),
  from_two_or_more: counts.filter((c) => c >= 2).length,
  from_all_providers: counts.filter((c) => c === nProviders).length,
  by_provider_count: Object.fromEntries(
    Array.from({ length: nProviders }, (_, i) => [i + 1, counts.filter((c) => c === i + 1).length]),
  ),
});

// ─── Assemble ───

const bySet = new Map(summary.by_provider_set.map((r) => [r.provider, r]));
const providerOrder = [...bySet.values()].sort((a, b) => b.mean_score - a.mean_score).map((r) => r.provider);

const providers = {};
// Best-minus-worst is a difference of two averages, so it is taken before
// rounding. Differencing the rounded numbers moves the third decimal.
const exact = {};
for (const p of providerOrder) {
  // One fetch row per question per provider. A repair pass re-fetched what an
  // arm still owed, and a re-fetch is the same question asked again, not a
  // second question — counting both would weight those questions twice.
  const { pages, returned, matched } = ratedPages(p, searches);
  // The text tables run over every clean row instead, repair rows included.
  // They describe what a provider's extractor emits, and a page it returned on
  // a second attempt is another real observation of that. See the
  // `text_tables_row_set` correction for the two cells where it shows.
  const texts = textsOf(p, allCleanRows);
  const set = bySet.get(p);
  const page = pageMean(pages);
  const base = pageMean(pages, "base");
  const hard = pageMean(pages, "hard");
  const perPage = pages.map((x) => mean(x.rungs));
  const cost = costs[p] ?? {};
  exact[p] = { base, hard };

  providers[p] = {
    // The headline. Give a judge all eight pages one provider returned and ask
    // whether someone could answer from those alone; ci95 is the half-width of
    // the 95% interval, so two providers whose intervals overlap are not
    // separated by this run. Straight from the run's own summary.
    set: { mean: set.mean_score, ci95: set.mean_score_ci95, n_queries: set.n_queries },
    // The mechanism underneath: how good the average page was on its own, and
    // how much more the whole set answers than its average page suggests.
    page: {
      mean: round(page),
      lift: round(set.mean_score - page),
      n_pages: pages.length,
      // How much of what this arm returned carries a rating. It is the health of
      // the join, and it is here because the published draft was built on a join
      // that silently ran at 57–99% and read like a finished number.
      join_match_pct: pct(matched, returned),
    },
    // 96 questions written to be answerable, 96 written to be hard on purpose.
    // The gap between providers is supposed to widen on the hard half; whether
    // it does is the check on whether the questions did anything.
    difficulty: { base: round(base), hard: round(hard), delta: round(hard - base) },
    // The 0-3 rubric could be the thing that invented the gap, so score it as
    // "a page either counts or it does not" at both thresholds. A page counts
    // when its average rung across the three judges clears the bar.
    binary: {
      rung3_pct: pct(perPage.filter((m) => m >= 2.5).length, perPage.length),
      rung2_or_3_pct: pct(perPage.filter((m) => m >= 1.5).length, perPage.length),
    },
    // Twelve questions have no answer anywhere. A LOW score is the good outcome:
    // a high one means the provider found a convincing near-miss and the judge
    // took it.
    unanswerable: { mean: round(pageMean(pages, "unanswerable")), n_questions: GROUPS.unanswerable.size },
    structure: {
      n_pages_with_text: texts.length,
      markdown_pct: pct(texts.filter(HAS.markdown).length, texts.length),
      headings_pct: pct(texts.filter(HAS.headings).length, texts.length),
      links_pct: pct(texts.filter(HAS.links).length, texts.length),
      images_pct: pct(texts.filter(HAS.images).length, texts.length),
      tables_pct: pct(texts.filter(HAS.tables).length, texts.length),
    },
    truncation: { pct: pct(texts.filter(wasTruncated).length, texts.length), limit_chars: TRUNCATION_LIMIT_CHARS },
    // Priced at the pay-as-you-go rate off the author's own billing pages, not
    // at what came out of pocket. `is_estimate` is true wherever the per-unit
    // rate is confirmed but the usage count is ours — carried through because a
    // reader deciding what to buy needs to know which prices are guesses.
    cost: {
      per_query_usd: cost.usd_per_query ?? null,
      run_total_usd: cost.usd_for_run ?? null,
      calls: cost.calls ?? null,
      confidence: cost.confidence ?? "unknown",
      is_estimate: cost.confidence !== "billed",
    },
  };

}

const best = providerOrder[0];
const worst = providerOrder[providerOrder.length - 1];
const spreadBase = exact[best].base - exact[worst].base;
const spreadHard = exact[best].hard - exact[worst].hard;

const payload = {
  generated_at: new Date().toISOString(),
  run: "run 2",
  source: "derived by scripts/build-report-data.mjs from .sourcery/pooled-*.jsonl and pooled-summary.json",
  judges: summary.judges.map((j) => j.split("/").pop()),
  provider_order: providerOrder,

  counts: {
    questions: summary.n_queries,
    base: GROUPS.base.size,
    hard: GROUPS.hard.size,
    unanswerable: GROUPS.unanswerable.size,
    providers: nProviders,
    judges: N_JUDGES,
    searches: searches.length,
    // Question-page pairs before pooling: every page every arm returned.
    pairs: searches.reduce((n, f) => n + (f.sources?.length ?? 0), 0),
    // After pooling, because several arms return the same page.
    unique_pairs: summary.n_pairs,
    // As the run's summary counts them: a judge that answered, including the
    // few that came back with no rung.
    page_ratings: summary.n_judgements,
    set_verdicts: summary.n_set_verdicts,
    // The ones that actually carry a number, which is what every average here
    // is built from.
    page_ratings_scored: usableRatings,
    set_verdicts_scored: latestSet.size,
    unjudged_pairs: summary.n_unjudged_pairs,
  },

  // Best minus worst on the answerable half versus the hard half. Easy
  // questions make providers look alike; this is by how much.
  spread: {
    base: round(spreadBase),
    hard: round(spreadHard),
    widened_pct: Math.round((spreadHard / spreadBase - 1) * 100),
    best,
    worst,
  },

  // How much of the variation in ratings each thing explains. Which judge you
  // picked explains a fortieth of what varies; which provider you picked
  // explains ten times that. Straight from the run's own summary.
  variance_shares: summary.variance_shares,

  // How often two judges gave the same page the same rung, corrected for the
  // agreement you would get by chance (that correction is what kappa is).
  agreement: summary.agreement,
  rung_distribution: summary.rung_distribution,

  overlap: {
    ...overlapShape(overlapCounts),
    grouped_by: "pooled url — the same page under two urls counts once, matching how it was judged",
  },
  // The same counts grouped by the raw url each provider returned, kept only
  // because the findings draft's overlap sentence was computed this way. Its
  // denominator is 7,877 pages, not the 7,496 the judges rated.
  overlap_by_raw_url: {
    ...overlapShape(overlapRawCounts),
    grouped_by: "the url as each provider returned it — a page under two urls counts twice",
  },

  cost_total_usd: round(
    Object.values(providers).reduce((a, p) => a + (p.cost.run_total_usd ?? 0), 0),
    2,
  ),

  providers,

  // What was rebuilt after the draft was written, and what moved. Somebody will
  // hold the published draft next to this file and needs the answer here rather
  // than in a commit message.
  corrections: {
    page_join_rebuilt:
      "The draft's page-level tables attached a rating to a provider by matching the url the provider returned against the url the judgement log stores, which is the pooled one. A page whose url needed normalizing to pool — a trailing slash, a tracking parameter — therefore had no rating attached, and the arms lost between 1% and 43% of their pages to it. Everything downstream of that join has been rebuilt here with core/pool.ts's own normalizeUrl on both sides, which matches 100% of every arm's pages. The page averages, base and hard averages, both binary thresholds, lift, the spread and the unanswerable scores all moved; every one of them is now over the whole of what a provider returned rather than over the subset whose urls happened to need no cleaning. The draft's numbers should be replaced, not reconciled.",
    bright_data_double_count_gone:
      "Bright Data throttles above one concurrent request and needed a slower repair pass, which left some questions with two clean fetch rows, and the draft's page numbers counted both. Deduping pages by question and pooled url fixes this as a side effect — the same page under one key — so no arm needs special-casing any more.",
    ordering_held_except_two:
      "The ranking is unchanged on the set score, the page score, both binary thresholds, the base half and lift. Two orderings did move. On the hard half Serper and Tavily swapped, on a gap of 0.001 that was never a real ordering either way. On the twelve questions with no answer the ranking reshuffled substantially, and the change is described in `unanswerable_ranking_moved`.",
    unanswerable_ranking_moved:
      "Scoring low is the good outcome on the twelve questions with no answer, and the corrected join changes who is restrained. Perplexity moves from sixth to worst at 0.816, which sharpens the draft's point that the best finder is also the readiest to hand you a convincing near-miss. But Exa moves the other way, from 0.559 to 0.681, and is no longer the most restrained of the four arms that rank well — Parallel is, at 0.643. The draft's sentence naming Exa needs rewriting. Bright Data and Firecrawl also swap at the good end.",
    lift_recomputed:
      "Lift is the set score minus the page score and nothing else. The draft's lift table subtracted a set average of 2.548 for Exa and 2.063 for Firecrawl while its own headline table printed 2.549 and 2.064 for the same arms — the average over verdicts against the average over questions. This file uses the published headline figure throughout, and lift is recomputed from the corrected page score, so every value in that table changes.",
    text_tables_row_set:
      "The page text and truncation tables run over every clean fetch row, repair rows included, while the ratings run over one row per question per arm. They are answering different questions: an average must not weight one question twice, but a description of what an extractor emits treats every page it returned as another real observation. It shows only in Bright Data, whose headings and links read 69% and 90% here and 70% and 91% over the deduped rows.",
    counts_unchanged:
      "Structure, truncation, cost, the variance shares, the three kappas, the rung distribution and every count are untouched by the join and still reproduce the draft exactly.",
  },
};

fs.mkdirSync(OUT.replace(/\/[^/]+$/, ""), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(payload, null, 1));
const kb = (fs.statSync(OUT).size / 1024).toFixed(1);

// ─── Check ───
//
// Every number above, against the number the findings draft prints and against
// the run's own summary. This exists because the failure it catches is silent:
// a chart that disagrees with the sentence beside it looks fine to whoever drew
// it. If a row fails, either the draft is wrong or this script is — do not move
// the expectation to match the output.
// The expectation is the corrected derivation, not the draft. The draft is what
// this is correcting, so `DRAFT_SAID` carries its old value beside every number
// that moved — that column is the edit list for docs/run-2-findings.md.
const EXPECTED = {
  //             set    ci95   page   base   hard   r3    r2+3  unans  md  head link img tbl trunc  $/q     run$
  perplexity: [2.768, 0.068, 2.259, 2.367, 2.332, 49.9, 82.6, 0.816, 63, 24, 1, 0, 15, 40, 0.005, 1.02],
  brave: [2.611, 0.081, 1.997, 2.117, 2.037, 34.8, 73.7, 0.726, 1, 1, 0, 0, 0, 77, 0.005, 1.02],
  parallel: [2.556, 0.088, 1.86, 1.928, 1.929, 29.3, 67.3, 0.643, 91, 89, 36, 0, 2, 43, 0.005, 1.02],
  exa: [2.549, 0.086, 1.966, 2.13, 1.96, 32.2, 71.7, 0.681, 91, 89, 7, 3, 14, 93, 0.0141, 2.88],
  tavily: [2.149, 0.109, 1.487, 1.685, 1.419, 20.2, 50.5, 0.447, 98, 87, 91, 73, 7, 99, 0.054, 13.83],
  serper: [2.123, 0.104, 1.45, 1.603, 1.42, 17.8, 48.6, 0.454, null, null, null, null, null, null, 0.001, 0.2],
  firecrawl: [2.064, 0.112, 1.348, 1.533, 1.283, 15.6, 43.8, 0.404, 99, 82, 90, 65, 9, 98, 0.0856, 17.47],
  bright_data: [1.95, 0.105, 1.319, 1.488, 1.262, 14.9, 42.5, 0.422, 92, 69, 90, 78, 0, 92, 0.0129, 2.64],
};
// null means the draft printed the same number; "—" means it printed none.
const DRAFT_SAID = {
  perplexity: [null, null, 2.226, 2.331, 2.329, 48.3, 81.8, 0.646, null, null, null, null, null, null, null, null],
  brave: [null, null, 1.967, 2.088, 2.019, 33.9, 72.8, 0.678, null, null, null, null, null, null, null, null],
  parallel: [null, null, 1.864, 1.929, 1.923, 29.4, 67.7, 0.647, null, null, null, null, null, null, null, null],
  exa: [null, null, 1.938, 2.097, 1.948, 30.3, 70.9, 0.559, null, null, null, null, null, null, null, null],
  tavily: [null, null, "—", 1.682, null, null, null, null, null, null, null, null, null, null, null, null],
  serper: [null, null, "—", 1.59, 1.418, 17.3, 48.5, 0.466, null, null, null, null, null, null, null, null],
  firecrawl: [null, null, 1.361, 1.56, 1.304, 15.9, 44.6, 0.406, null, null, null, null, null, null, null, null],
  bright_data: [null, null, "—", 1.482, 1.285, 15.5, 43.2, 0.37, null, null, null, null, null, null, null, null],
};
const FIELDS = [
  ["set.mean", (r) => r.set.mean, 0],
  ["set.ci95", (r) => r.set.ci95, 0],
  ["page.mean", (r) => r.page.mean, 0],
  ["base", (r) => r.difficulty.base, 0],
  ["hard", (r) => r.difficulty.hard, 0],
  ["binary.rung3", (r) => r.binary.rung3_pct, 0],
  ["binary.rung2_3", (r) => r.binary.rung2_or_3_pct, 0],
  ["unanswerable", (r) => r.unanswerable.mean, 0],
  // The structure and truncation shares are printed to whole percents in the
  // draft, so a value at a .5 boundary can round either way. Anything past one
  // point apart is a real disagreement.
  ["structure.markdown", (r) => r.structure.markdown_pct, 0.6],
  ["structure.headings", (r) => r.structure.headings_pct, 0.6],
  ["structure.links", (r) => r.structure.links_pct, 0.6],
  ["structure.images", (r) => r.structure.images_pct, 0.6],
  ["structure.tables", (r) => r.structure.tables_pct, 0.6],
  ["truncation", (r) => r.truncation.pct, 0.6],
  ["cost.per_query", (r) => r.cost.per_query_usd, 0],
  ["cost.run_total", (r) => r.cost.run_total_usd, 0],
];

const results = [];
const check = (label, got, want, tol = 0, draft = null) => {
  if (want === null || want === undefined) return;
  const ok = got !== null && got !== undefined && Math.abs(got - want) <= tol + 1e-9;
  // A share carried to one decimal is not expected to equal a whole percent.
  // Only flag it when it rounds to something other than what is printed, since
  // that is the case where a reader would see two different numbers. A
  // tolerance check against a target that is not a whole percent — the summary
  // rungs below — is just a bound, and passing it is passing.
  const rounds = tol > 0 ? !Number.isInteger(want) || Math.round(got) === want : got === want;
  results.push({ label, got, want, draft, ok, state: ok ? (rounds ? "PASS" : "PASS~") : "FAIL" });
};

for (const p of providerOrder) {
  const want = EXPECTED[p];
  const said = DRAFT_SAID[p];
  FIELDS.forEach(([name, get, tol], i) => check(`${p}.${name}`, get(providers[p]), want[i], tol, said[i]));
}
check("counts.questions", payload.counts.questions, 204);
check("counts.searches", payload.counts.searches, 1631);
check("counts.pairs", payload.counts.pairs, 12954);
check("counts.unique_pairs", payload.counts.unique_pairs, 7496);
check("counts.page_ratings", payload.counts.page_ratings, 22488);
check("counts.set_verdicts", payload.counts.set_verdicts, 4891);
check("counts.page_ratings_scored", payload.counts.page_ratings_scored, 22457);
check("counts.set_verdicts_scored", payload.counts.set_verdicts_scored, 4886);
check("counts.unjudged_pairs", payload.counts.unjudged_pairs, 0);
check("counts.base", payload.counts.base, 96);
check("counts.hard", payload.counts.hard, 96);
check("counts.unanswerable", payload.counts.unanswerable, 12);
check("spread.base", payload.spread.base, 0.879, 0, 0.85);
check("spread.hard", payload.spread.hard, 1.07, 0, 1.043);
check("spread.widened_pct", payload.spread.widened_pct, 22, 0, 23);
check("variance.provider", payload.variance_shares.provider, 0.231);
check("variance.query", payload.variance_shares.query, 0.457);
check("variance.judge", payload.variance_shares.judge, 0.022);
check("variance.provider_by_query", payload.variance_shares.provider_by_query, 0.214);
check("variance.residual", payload.variance_shares.residual, 0.076);
payload.agreement.forEach((a, i) => check(`agreement.kappa[${a.judge_a}/${a.judge_b}]`, a.kappa, [0.509, 0.55, 0.535][i]));
check("overlap.n_pages", payload.overlap.n_pages, summary.n_pairs);
check("overlap.from_one_provider_pct", payload.overlap.from_one_provider_pct, 66.8, 0, "~70 (seven in ten)");
check("overlap.from_all_providers", payload.overlap.from_all_providers, 24, 0, 15);
check("overlap.from_two_or_more", payload.overlap.from_two_or_more, 2485, 0, 2406);
check("cost_total_usd", payload.cost_total_usd, 40.08);
// Lift is a subtraction, not a third measurement, so it has to be the two
// numbers printed beside it. This catches the drift the draft's own lift table
// has, where the set average came from a different computation.
for (const p of providerOrder) check(`${p}.page.lift`, providers[p].page.lift, round(providers[p].set.mean - providers[p].page.mean));
// Firecrawl timed out at 300 seconds on one question and has 203, not 204. The
// gap is the point: it must survive into the published table.
check("firecrawl.set.n_queries", providers.firecrawl.set.n_queries, 203);
// Every other provider answered all 204.
for (const p of providerOrder) if (p !== "firecrawl") check(`${p}.set.n_queries`, providers[p].set.n_queries, 204);
// The join is the thing that was wrong before, so assert it rather than trust
// it: every page a provider returned has to find its rating.
for (const p of providerOrder) check(`${p}.page.join_match_pct`, providers[p].page.join_match_pct, 100);
// And against the run's own summary, so a summary regenerated tomorrow cannot
// quietly disagree with this file.
for (const r of summary.by_provider_set) check(`summary.set[${r.provider}]`, providers[r.provider].set.mean, r.mean_score);
// The summary averages each question first and then the questions; this file
// averages the ratings. They are two weightings of the same data, not two
// findings, and they have to stay within a hair of each other — if they ever
// drift further apart than this, one of them has stopped describing the run.
for (const r of summary.by_provider)
  check(`summary.mean_rung[${r.provider}] within 0.015`, providers[r.provider].page.mean, r.mean_rung, 0.015);

const failed = results.filter((r) => !r.ok);
const near = results.filter((r) => r.state === "PASS~");
const changed = results.filter((r) => r.draft !== null && r.draft !== undefined);
const w = Math.max(...results.map((r) => r.label.length));
console.log(`\n${OUT}: ${kb} KB\n`);
console.log(`${"check".padEnd(w)}  ${"got".padStart(9)}  ${"expected".padStart(9)}  ${"draft said".padStart(18)}  state`);
for (const r of results) {
  const said = r.draft === null || r.draft === undefined ? "" : String(r.draft);
  console.log(
    `${r.label.padEnd(w)}  ${String(r.got).padStart(9)}  ${String(r.want).padStart(9)}  ${said.padStart(18)}  ${r.state}`,
  );
}
console.log(
  `\n${results.length - failed.length}/${results.length} pass, ${changed.length} of them changed from the draft` +
    (near.length ? ` (${near.length} within tolerance, marked PASS~)` : "") +
    (failed.length ? `, ${failed.length} FAILED` : "") +
    ".",
);
if (near.length) {
  console.log("\nWithin a point but rounding the other way from what the draft prints:");
  for (const r of near) console.log(`  ${r.label}: ${r.got} rounds to ${Math.round(r.got)}, draft prints ${r.want}`);
}
// Did the ranking move? The draft's whole argument is that the ordering is
// robust, so a rebuilt join that reordered anyone is a finding, not a detail.
// Only the columns the draft printed for all eight arms can be compared.
// Best first, which on the unanswerable questions means lowest first.
const rankBy = (values, bestIsLow) =>
  providerOrder
    .slice()
    .sort((a, b) => (bestIsLow ? values[a] - values[b] : values[b] - values[a]))
    .join(" > ");
const ORDERED_COLUMNS = [
  ["base", 3, false],
  ["hard", 4, false],
  ["binary rung 3", 5, false],
  ["binary rung 2 or 3", 6, false],
  ["unanswerable (low is good)", 7, true],
];
console.log("\nRanking, corrected against what the draft printed:");
for (const [name, i, bestIsLow] of ORDERED_COLUMNS) {
  const now = {};
  const then = {};
  for (const p of providerOrder) {
    now[p] = EXPECTED[p][i];
    then[p] = DRAFT_SAID[p][i] ?? EXPECTED[p][i];
  }
  const a = rankBy(now, bestIsLow);
  const b = rankBy(then, bestIsLow);
  console.log(`  ${name}: ${a === b ? "unchanged" : "MOVED"}`);
  if (a !== b) {
    console.log(`    draft: ${b}`);
    console.log(`    now:   ${a}`);
  }
}

if (changed.length) {
  console.log(`\n${changed.length} numbers to edit in docs/run-2-findings.md:`);
  for (const r of changed) console.log(`  ${r.label}: ${r.draft} -> ${r.got}`);
}

if (failed.length) {
  console.log("\nThese did not reproduce. Either the draft is wrong or this script is; do not move the expectation.");
  for (const r of failed) console.log(`  ${r.label}: got ${r.got}, draft says ${r.want}`);
  process.exit(1);
}
