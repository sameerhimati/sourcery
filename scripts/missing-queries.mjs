// Write a query file containing only the questions an arm still owes.
//
//   node scripts/missing-queries.mjs bright_data .sourcery/missing.json
//
// Exists because `--resume` and a throttled arm don't mix. Resume skips every
// row on disk except transport and account failures, and a throttle is recorded
// as a provider failure — correctly, since we can't prove from the message alone
// whether the vendor or our request rate caused it. So resuming a throttled arm
// silently leaves its gaps, and re-running without resume re-fetches the whole
// 204 including everything that already worked.
//
// This is the third option: fetch exactly the gaps, no reclassification, no
// re-spending on rows that succeeded. Point `--queries` at the file it writes
// and leave `--resume` off.

import { readFileSync, writeFileSync } from "node:fs";

const [provider, out = ".sourcery/missing.json"] = process.argv.slice(2);
if (!provider) {
  console.error("usage: node scripts/missing-queries.mjs <provider> [outfile]");
  process.exit(1);
}

const queries = JSON.parse(readFileSync("datasets/run2-all.json", "utf8"));

// Last write wins per question+arm, matching dedupeFetchRows: a later success
// supersedes an earlier failure, which is the whole point of a repair pass.
const latest = new Map();
for (const line of readFileSync(".sourcery/pooled-fetches.jsonl", "utf8").split("\n")) {
  if (!line.trim()) continue;
  const row = JSON.parse(line);
  if (row.provider === provider) latest.set(row.queryId, row);
}

const missing = queries.filter((q) => {
  const row = latest.get(q.id);
  return !row || row.error;
});

writeFileSync(out, JSON.stringify(missing, null, 2) + "\n");
console.log(
  `${out}: ${missing.length} of ${queries.length} questions still owed by ${provider}` +
    ` (${queries.length - missing.length} already fetched cleanly)`,
);
