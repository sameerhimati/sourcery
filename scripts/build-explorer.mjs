#!/usr/bin/env node
// Inject the run's data into the explorer template and write the page.
//
// Template and data are kept apart so the page can be rebuilt against a newer
// run without touching the markup, and so the markup can be edited without
// regenerating eight megabytes of JSON to see the change.
//
// Usage: node scripts/build-explorer.mjs [data.json] [out.html]

import fs from "node:fs";

const DATA = process.argv[2] ?? "docs/explorer/data.json";
const OUT = process.argv[3] ?? "docs/explorer/index.html";
const TEMPLATE = "docs/explorer/template.html";

const template = fs.readFileSync(TEMPLATE, "utf8");
const data = fs.readFileSync(DATA, "utf8");

// The payload rides inside a <script type="application/json"> block, so the one
// sequence that can break out of it is a literal "</script>". A url or a judge's
// rationale is free to contain one, and escaping the slash keeps the JSON
// identical while making the closing tag unmatchable.
const safe = data.replace(/<\//g, "<\\/");

if (!template.includes("__SOURCERY_DATA__")) {
  console.error(`${TEMPLATE} has no __SOURCERY_DATA__ placeholder.`);
  process.exit(1);
}

fs.writeFileSync(OUT, template.replace("__SOURCERY_DATA__", safe));
console.log(`${OUT}: ${(fs.statSync(OUT).size / 1e6).toFixed(2)} MB`);
