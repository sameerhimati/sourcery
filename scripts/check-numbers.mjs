#!/usr/bin/env node
// Fail the build if the published page states a number that no data file backs.
//
// The failure this catches is the one nobody notices: a figure typed into a
// sentence during a rewrite, correct on the day and quietly wrong after the next
// run. Charts and tables cannot drift, because scripts/build-report.mjs draws
// them straight from docs/report-data.json — running prose could, and did.
//
// So every number in the page's text has to be one of three things: a value
// present in report-data.json (in any of the shapes the page renders it in), a
// number the page itself explains rather than measures, or an entry in the
// allowlist below with a reason beside it. Anything else is an orphan and stops
// the build.
//
// Scope matters more than it looks. The check reads TEXT ONLY: <svg> elements
// are cut out whole and every attribute is dropped before scanning. A naive grep
// over the built HTML matches path coordinates, viewBox numbers, hex colours and
// font weights, and the allowlist needed to silence those would be longer than
// the page — which is the same as having no check at all.
//
// Usage: node scripts/check-numbers.mjs [page.html] [data.json]
// With no page argument it checks every report page, so a page added to the
// site cannot silently fall out of the check.

import fs from "node:fs";

const PAGES = process.argv[2] ? [process.argv[2]] : ["docs/index.html", "docs/methodology/index.html"];
const DATA = process.argv[3] ?? "docs/report-data.json";

// ── numbers the page is allowed to say without a data file behind them ───────
// Each one needs a reason. A number that cannot be given a reason here is
// exactly the number this script exists to find.
const ALLOWED = new Map([
  ["0", "a point on the 0–3 scale, defined in the rubric"],
  ["1", "a point on the 0–3 scale"],
  ["2", "a point on the 0–3 scale"],
  ["3", "a point on the 0–3 scale"],
  ["95", "the confidence level, a property of the method rather than the run"],
  ["100", "a percentage denominator in prose"],
  ["2026", "the year"],
  ["5", "a small count in prose (5.6, 5.2 model names are handled separately)"],
  // Run 1's shape and its one surviving finding. They are the reason run 2 is
  // built the way it is, and no run-2 log can produce them — the data file
  // behind this page only knows about run 2.
  ["48", "run 1's question count, cited as the design this run reacted to"],
  ["0.16", "run 1's source-quality to answer-quality correlation, the finding run 2 is built on"],
]);

// Model names carry digits and are not measurements.
const NOT_NUMBERS = [
  /GPT-5\.6/g,
  /GLM 5\.2/g,
  /Sonnet 5/g,
  /Claude Sonnet 5/g,
  /v2 \//g,
  /0&ndash;3/g,
  /0–3/g,
];

// ── every shape report-data.json's values legitimately appear in ─────────────
function renderings(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return [];
  const out = new Set();
  const push = (s) => s !== undefined && out.add(String(s));
  push(n);
  for (let d = 0; d <= 4; d++) push(n.toFixed(d));
  push(Math.round(n));
  push(Math.abs(n));
  push(n.toLocaleString("en-US"));
  push(Math.round(n).toLocaleString("en-US"));
  // Shares are stored as fractions and printed as percents, and the other way
  // round for the ones already stored as percents.
  push((n * 100).toFixed(0));
  push((n * 100).toFixed(1));
  push((n / 100).toFixed(3));
  // Money drops trailing zeroes on the page.
  push(`${n.toFixed(4)}`.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, ""));
  push(n.toFixed(2));
  return [...out];
}

const known = new Set();
(function walk(v) {
  if (v === null || v === undefined) return;
  if (typeof v === "number") return renderings(v).forEach((s) => known.add(s));
  if (Array.isArray(v)) return v.forEach(walk);
  if (typeof v === "object") return Object.values(v).forEach(walk);
  // Strings in the data file can carry numbers too — the corrections block
  // quotes the values it is correcting, and the page may quote them back.
  if (typeof v === "string") (v.match(/\d[\d,.]*/g) ?? []).forEach((s) => known.add(s.replace(/[.,]$/, "")));
})(JSON.parse(fs.readFileSync(DATA, "utf8")));

// Derived figures the page states that the data file holds only the parts of.
const data = JSON.parse(fs.readFileSync(DATA, "utf8"));
for (const p of Object.values(data.providers ?? {})) {
  // "a fifty-fourth of the cost", "86-fold spread" — ratios between two stored
  // numbers are still traceable to the file, so admit them.
  for (const q of Object.values(data.providers ?? {})) {
    if (p?.cost?.per_query_usd && q?.cost?.per_query_usd) {
      known.add(String(Math.round(p.cost.per_query_usd / q.cost.per_query_usd)));
    }
  }
}
// Latency is stored in milliseconds and printed in seconds, because a reader
// should not have to divide to see that a search took half a minute. Admit the
// seconds form of every stored duration, and the ratios between the medians —
// "about 59 times the wait" is two stored numbers and a division.
for (const l of Object.values(data.latency ?? {})) {
  for (const ms of [l.p50_ms, l.p90_ms, l.max_ms]) {
    if (typeof ms !== "number") continue;
    known.add((ms / 1000).toFixed(0));
    known.add((ms / 1000).toFixed(1));
  }
}
for (const a of Object.values(data.latency ?? {})) {
  for (const b of Object.values(data.latency ?? {})) {
    if (a?.p50_ms && b?.p50_ms) known.add(String(Math.round(a.p50_ms / b.p50_ms)));
  }
}

const fc = data.recorded?.firecrawl_credits;
if (fc) known.add(String(Math.round((fc.value / fc.monthly_allowance) * 100)));
if (data.overlap) known.add(String(Math.round((data.overlap.from_two_or_more / data.overlap.n_pages) * 100)));

function checkPage(PAGE) {
  // ── every table row has to fill every column ───────────────────────────────
  // A column added to a template's <thead> whose <td> never got added to the row
  // builder renders as a header over eight blank cells. Nothing else here catches
  // it: no number is wrong, there is simply no number. This did happen.
  const rawPage = fs.readFileSync(PAGE, "utf8");
  const tableFaults = [];
  for (const [, table] of rawPage.matchAll(/<table>([\s\S]*?)<\/table>/g)) {
    const headRow = table.match(/<thead>[\s\S]*?<tr>([\s\S]*?)<\/tr>[\s\S]*?<\/thead>/);
    if (!headRow) continue;
    const nCols = (headRow[1].match(/<th\b/g) ?? []).length;
    const body = table.match(/<tbody>([\s\S]*?)<\/tbody>/);
    if (!body) continue;
    for (const [, row] of body[1].matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
      const nCells = (row.match(/<t[hd]\b/g) ?? []).length;
      if (nCells !== nCols) {
        const name = (row.match(/<th[^>]*>([^<]*)</) ?? [, "?"])[1];
        tableFaults.push(`row "${name}" has ${nCells} cells against ${nCols} column headers`);
      }
    }
  }
  if (tableFaults.length) {
    console.error(`\n${PAGE}: table columns and cells disagree.\n`);
    for (const f of [...new Set(tableFaults)]) console.error(`  ${f}`);
    console.error(`\nA header was probably added to the template without its cell in the row builder.\n`);
    process.exit(1);
  }

  // ── the page, as text ──────────────────────────────────────────────────────
  let html = rawPage;
  html = html.replace(/<svg[\s\S]*?<\/svg>/g, " "); // charts are generated; they cannot drift
  html = html.replace(/<style[\s\S]*?<\/style>/g, " ");
  html = html.replace(/<!--[\s\S]*?-->/g, " ");
  html = html.replace(/<[a-zA-Z/][^>]*>/g, " "); // tags, and with them every attribute
  for (const re of NOT_NUMBERS) html = html.replace(re, " ");
  // Numeric character references before named ones: &#8599; is an arrow glyph,
  // and left in place it reads as the number 8599.
  html = html.replace(/&#x?[0-9a-fA-F]+;/g, " ");
  html = html.replace(/&[a-z]+;/g, " ");

  // A number is a run of digits with optional thousands separators and decimals.
  const found = new Map();
  for (const m of html.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const raw = m[0].replace(/[.,]$/, "");
    if (!found.has(raw)) {
      const at = Math.max(0, m.index - 60);
      found.set(raw, html.slice(at, m.index + 60).replace(/\s+/g, " ").trim());
    }
  }

  const orphans = [];
  for (const [n, context] of found) {
    if (known.has(n) || known.has(n.replace(/,/g, "")) || ALLOWED.has(n)) continue;
    orphans.push({ n, context });
  }

  if (orphans.length) {
    console.error(`\n${PAGE}: ${orphans.length} number${orphans.length === 1 ? "" : "s"} the data file does not back.\n`);
    for (const { n, context } of orphans) console.error(`  ${n.padEnd(12)} …${context}…`);
    console.error(
      `\nEach one is either a figure that should be derived in scripts/build-report-data.mjs\n` +
        `and templated in, or a number the page explains rather than measures — in which case\n` +
        `add it to ALLOWED in this file with the reason.\n`,
    );
    process.exit(1);
  }

  console.log(`${PAGE}: ${found.size} numbers, every one traceable to ${DATA}.`);
}

for (const page of PAGES) checkPage(page);
