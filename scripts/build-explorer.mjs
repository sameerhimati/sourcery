#!/usr/bin/env node
// Write the explorer page, and tell it where to fetch the run's data.
//
// The data used to be pasted straight into the page, which made a twelve
// megabyte HTML file: on a phone that is several seconds of blank screen before
// anything at all appears. The page now downloads the JSON from alongside
// itself, so the markup ships in tens of kilobytes and the payload arrives as
// one request the browser can cache. Both files therefore have to land in the
// same directory, and the page asks for the data by relative name so it works
// wherever it is published, subpath and all.
//
// Template and data are still kept apart so the page can be rebuilt against a
// newer run without touching the markup, and so the markup can be edited
// without regenerating eight megabytes of JSON to see the change.
//
// Usage: node scripts/build-explorer.mjs [data.json] [out.html]

import fs from "node:fs";
import path from "node:path";
// The nav bar and its styles come from the same module the report build uses,
// so the two pages carry one bar rather than two copies that drift.
import { fetchedRange, navHtml, NAV_CSS } from "./nav.mjs";

const DATA = process.argv[2] ?? "docs/explorer/data.json";
const OUT = process.argv[3] ?? "docs/explorer/index.html";
const TEMPLATE = "docs/explorer/template.html";
// Read only for the nav's run stamp; the explorer's own data is DATA above.
const REPORT_DATA = "docs/report-data.json";

const template = fs.readFileSync(TEMPLATE, "utf8");

for (const ph of ["__SOURCERY_META__", "__NAV__", "__NAV_STYLE__"]) {
  if (!template.includes(ph)) {
    console.error(`${TEMPLATE} has no ${ph} placeholder.`);
    process.exit(1);
  }
}

if (path.dirname(path.resolve(DATA)) !== path.dirname(path.resolve(OUT))) {
  console.error(`${OUT} fetches ${path.basename(DATA)} from its own directory, so the two have to be written side by side.`);
  process.exit(1);
}

const raw = fs.readFileSync(DATA, "utf8");

// Parsing here means a broken data file fails at build, in a terminal, rather
// than in a reader's browser where the only symptom is a page that never fills.
let data;
try {
  data = JSON.parse(raw);
} catch (err) {
  console.error(`${DATA} is not valid JSON, so the page would never fill: ${err.message}`);
  process.exit(1);
}

// All the page knows before its download finishes: where the data is, and how
// long the wait is likely to be, so it can say so instead of spinning silently.
const meta = {
  url: path.basename(DATA),
  bytes: Buffer.byteLength(raw),
  ratings: data.n_ratings ?? 0,
  questions: data.n_questions ?? 0
};

// This block still rides inside a <script type="application/json">, and the one
// sequence that can break out of it is a literal "</script>". The eleven
// megabytes of judge rationales no longer travel this way, but the data file's
// name does, so escaping the slash stays — it keeps the JSON identical while
// making the closing tag unmatchable.
const safe = JSON.stringify(meta).replace(/<\//g, "<\\/");

const report = JSON.parse(fs.readFileSync(REPORT_DATA, "utf8"));
const nav = navHtml("explorer", {
  fetched: fetchedRange(report.run_window),
  sha: report.code_sha ?? "unreleased",
});

// The replacement is a function because a plain string would have "$&" and its
// relatives read as backreferences, quietly corrupting whatever contained them.
fs.writeFileSync(
  OUT,
  template
    .replace("__SOURCERY_META__", () => safe)
    .replace("__NAV__", () => nav)
    .replace("__NAV_STYLE__", () => NAV_CSS),
);

const pageKb = (fs.statSync(OUT).size / 1e3).toFixed(1);
console.log(`${OUT}: ${pageKb} KB, fetching ${meta.url} (${(meta.bytes / 1e6).toFixed(1)} MB) at load`);
