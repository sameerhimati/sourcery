// Does Exa return a publishedDate, and do we parse it when it does?
//
// Run 1 published the claim that Exa is "the only one with reliable native
// publish dates". Run 2 measures 54% coverage, behind four other arms. Before
// that goes anywhere near a writeup — least of all to someone who works at Exa —
// it has to be clear whether the gap is theirs or ours.
//
//   npx tsx scripts/probe-exa-dates.ts

import fs from "node:fs";
import { loadEnv } from "../cli/env";
import { parsePublished } from "../core/date";

loadEnv();

const key = process.env.EXA_API_KEY?.trim();
if (!key) {
  console.error("EXA_API_KEY missing");
  process.exit(1);
}

// Real questions from the run, so the comparison is like for like.
const queries = fs
  .readFileSync(".sourcery/pooled-fetches.jsonl", "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l) as { provider: string; error?: string; query: string; queryId: string })
  .filter((r) => r.provider === "exa" && !r.error)
  .slice(0, 5);

async function main(): Promise<void> {
let total = 0;
let native = 0;
let weParsed = 0;
const missing: string[] = [];

for (const q of queries) {
  const res = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key as string },
    body: JSON.stringify({ query: q.query, numResults: 8, contents: { text: true } }),
  });
  if (!res.ok) {
    console.error(`exa ${res.status}: ${(await res.text()).slice(0, 200)}`);
    process.exit(1);
  }
  const body = (await res.json()) as {
    results: { url: string; publishedDate?: string; title?: string }[];
  };

  console.log(`\n${q.queryId}: ${q.query.slice(0, 78)}`);
  for (const r of body.results) {
    total++;
    const raw = r.publishedDate;
    if (raw) native++;
    const parsed = raw ? parsePublished(raw, Date.now()) : null;
    if (parsed) weParsed++;
    if (raw && !parsed) missing.push(`${raw}  ${r.url.slice(0, 60)}`);
    console.log(
      `  ${(raw ?? "— no publishedDate —").padEnd(28)} parsed: ${(parsed ?? "—").padEnd(12)} ${r.url.slice(0, 52)}`,
    );
  }
}

console.log(`\n${total} results across ${queries.length} queries`);
console.log(`  Exa returned a publishedDate on ${native} (${Math.round((100 * native) / total)}%)`);
console.log(`  we parsed a date from ${weParsed} (${Math.round((100 * weParsed) / total)}%)`);
if (missing.length) {
  console.log(`\n  ${missing.length} date(s) Exa sent that we FAILED to parse — that would be our bug:`);
  for (const m of missing.slice(0, 10)) console.log(`    ${m}`);
} else {
  console.log(`\n  Every date Exa sent, we parsed. The gap is coverage on their side, not parsing on ours.`);
}
}

void main();
