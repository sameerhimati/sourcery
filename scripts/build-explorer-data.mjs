#!/usr/bin/env node
// Join the run's files into the one payload the results explorer reads.
//
// The explorer's promise is that you can open a question and see what every
// provider actually returned, and what every judge actually said about each
// page. So the join keeps every rating and every rationale — the rationale is
// what makes a rating checkable instead of something to take on faith — and
// leaves the page text out, because it is most of the bytes and nobody reads
// 1,600 characters inside a table cell.
//
// Usage: node scripts/build-explorer-data.mjs [outfile]

import fs from "node:fs";

const OUT = process.argv[2] ?? "docs/explorer/data.json";
const F = {
  fetches: ".sourcery/pooled-fetches.jsonl",
  judgements: ".sourcery/pooled-judgements.jsonl",
  sets: ".sourcery/pooled-set-verdicts.jsonl",
  summary: ".sourcery/pooled-summary.json",
  costs: "datasets/provider-costs.json",
  noSearch: ".sourcery/no-search.jsonl",
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

const fetches = readJsonl(F.fetches);
const judgements = readJsonl(F.judgements);
const setVerdicts = readJsonl(F.sets);
const noSearch = readJsonl(F.noSearch);
const summary = fs.existsSync(F.summary) ? JSON.parse(fs.readFileSync(F.summary, "utf8")) : null;
const costs = JSON.parse(fs.readFileSync(F.costs, "utf8")).providers;

if (!fetches.length) {
  console.error(`No fetches at ${F.fetches}, so there is nothing to build.`);
  process.exit(1);
}

// Ratings are keyed the way the run keys them: question, url, judge. A page
// four providers returned was judged once and the verdict reused, which is what
// lets 22,000 judgements cover eight arms. The explorer has to show that same
// rating under each provider that returned the page rather than implying each
// one got its own reading.
const ratings = new Map();
for (const j of judgements) {
  const k = `${j.queryId} ${j.url}`;
  if (!ratings.has(k)) ratings.set(k, []);
  ratings.get(k).push({ judge: j.judge, rung: j.rung, rationale: j.rationale ?? "" });
}

const sets = new Map();
for (const s of setVerdicts) {
  const k = `${s.queryId} ${s.provider}`;
  if (!sets.has(k)) sets.set(k, []);
  sets.get(k).push({ judge: s.judge, score: s.score, rationale: s.rationale ?? "" });
}

// The no-search baseline hangs off the question, not off any provider: it
// answers "could this question separate providers at all", and it is the reason
// a question with a flat leaderboard might not be a tie.
const baseline = new Map();
for (const r of noSearch) {
  if (!r.verdict) continue;
  if (!baseline.has(r.queryId)) baseline.set(r.queryId, []);
  baseline.get(r.queryId).push({ grader: r.grader, verdict: r.verdict, rationale: r.rationale ?? "" });
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round = (x, n = 3) => (x === null || x === undefined ? null : Number(x.toFixed(n)));

// Keyless SERP is captcha-blocked after a handful of queries: 8 consecutive
// failures, zero successes, and fail-fast correctly killed the attempt. It left
// its 8 rows on disk, and run 2 is eight arms, not nine. It stays out of the
// explorer because it is a demonstration of the free floor, never a measured
// provider, and a ninth column of nothing but errors reads as one.
const NOT_AN_ARM = new Set(["plain"]);

// A question can have more than one row per arm: a repair pass re-fetches what
// an arm still owed. Plain last-write-wins is wrong for that, because one
// bright_data question came back clean and then errored on a later attempt, and
// taking the later row would publish a failure for a fetch we actually have.
// A clean row always beats an errored one; among clean rows the newest wins.
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

// Which provider's text a page was actually judged on.
//
// buildPool keeps the LONGEST extraction across every provider that returned a
// url, because the pair is judged once and one text has to stand for the page.
// That is the right call for the judge and a trap for the reader: a page serper
// found with no text at all is judged on firecrawl's markdown, and both arms
// are credited for the rating. The explorer has to be able to say so, so the
// pool is rebuilt here the same way.
//
// `snippet` is deliberately not text. Serper returns links and snippets and
// never page content, and folding the two together would erase the one
// integration difference that survives the 1,600-character cap.
const textOf = (s) => s.content ?? "";
const pooledText = new Map();
for (const f of bestRow.values()) {
  if (f.error) continue;
  for (const s of f.sources ?? []) {
    const k = `${f.queryId} ${s.url}`;
    const t = textOf(s);
    const cur = pooledText.get(k);
    if (!cur || t.length > cur.chars) pooledText.set(k, { chars: t.length, from: f.provider });
  }
}

const questions = new Map();
for (const f of bestRow.values()) {
  if (!questions.has(f.queryId)) {
    questions.set(f.queryId, {
      id: f.queryId,
      query: f.query,
      type: f.type ?? null,
      genre: f.genre ?? null,
      sharpness: f.sharpness ?? null,
      baseline: baseline.get(f.queryId) ?? [],
      providers: {},
    });
  }
  const q = questions.get(f.queryId);

  const pages = (f.sources ?? []).map((s) => {
    const rs = ratings.get(`${f.queryId} ${s.url}`) ?? [];
    const rungs = rs.map((r) => r.rung).filter((r) => typeof r === "number");
    return {
      url: s.url,
      title: s.title ?? "",
      domain: s.domain ?? "",
      published: s.published ?? null,
      // What this arm extracted itself, and what the judge actually read. They
      // differ exactly when another arm returned the same url with more text.
      own_chars: textOf(s).length,
      judged_chars: pooledText.get(`${f.queryId} ${s.url}`)?.chars ?? 0,
      judged_from: pooledText.get(`${f.queryId} ${s.url}`)?.from ?? null,
      ratings: rs,
      mean_rung: round(mean(rungs)),
      // Spread is what surfaces a split panel: three rungs apart means two
      // judges read the same page and disagreed about nearly everything.
      spread: rungs.length > 1 ? Math.max(...rungs) - Math.min(...rungs) : 0,
    };
  });

  const pageMeans = pages.map((p) => p.mean_rung).filter((m) => m !== null);
  const setRows = sets.get(`${f.queryId} ${f.provider}`) ?? [];
  const setScores = setRows.map((r) => r.score).filter((s) => typeof s === "number");

  q.providers[f.provider] = {
    error: f.error ?? null,
    error_stage: f.error_stage ?? null,
    fetch_ms: f.fetch_ms ?? null,
    num_sources: f.num_sources ?? pages.length,
    num_extracted: f.num_extracted ?? null,
    fetched_at: f.fetched_at ?? null,
    pages,
    mean_rung: round(mean(pageMeans)),
    set: setRows,
    set_mean: round(mean(setScores)),
    usd: costs[f.provider]?.usd_per_query ?? null,
  };
}

const judges = [...new Set(judgements.map((j) => j.judge))].sort();
const providers = [...new Set([...bestRow.values()].map((f) => f.provider))].sort();

// The fetch date is a control: comparing an arm fetched today against one
// fetched last week measures the week, not the provider. A repair pass that
// runs past midnight makes this two dates, which is fine and has to be said
// rather than rounded off.
const fetchDates = [...new Set([...bestRow.values()].map((f) => (f.fetched_at ?? "").slice(0, 10)).filter(Boolean))].sort();

// Counted from the rows that survived the clean-beats-errored pick, so this is
// what the explorer actually shows rather than what the raw log implies.
const completeness = providers.map((p) => {
  const rows = [...bestRow.values()].filter((f) => f.provider === p);
  return {
    provider: p,
    clean: rows.filter((f) => !f.error).length,
    failed: rows.filter((f) => f.error).length,
    // Which step failed, never the provider by default: a failure we cannot
    // place is attributed to nobody.
    failed_by_stage: rows
      .filter((f) => f.error)
      .reduce((acc, f) => ({ ...acc, [f.error_stage ?? "unknown"]: (acc[f.error_stage ?? "unknown"] ?? 0) + 1 }), {}),
  };
});

const payload = {
  generated_at: new Date().toISOString(),
  run: "run 2",
  judges,
  providers,
  fetch_dates: fetchDates,
  completeness,
  costs,
  summary,
  n_questions: questions.size,
  n_pairs: ratings.size,
  n_ratings: judgements.length,
  n_set_verdicts: setVerdicts.length,
  questions: [...questions.values()],
};

fs.mkdirSync(OUT.replace(/\/[^/]+$/, ""), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(payload));
const mb = (fs.statSync(OUT).size / 1e6).toFixed(2);
console.log(
  `${OUT}: ${mb} MB, ${questions.size} questions, ${providers.length} providers, ` +
    `${judges.length} judges, ${ratings.size} unique pairs, ${judgements.length} ratings, ` +
    `${setVerdicts.length} set verdicts.`,
);
const unpriced = providers.filter((p) => costs[p]?.usd_per_query == null);
if (unpriced.length) {
  console.log(`No measured price yet for ${unpriced.join(", ")}. The explorer shows those as "not measured".`);
}
