// Concatenate run 2's three question files into the single file the run fetches
// against.
//
// `--queries` takes one file, and run 2 has to be one snapshot: every arm
// fetching every question on the same day. Two invocations would be two
// snapshots, and the whole comparison rests on them being one.
//
// The three sets stay separate on disk because they are edited separately and
// the published 96 is frozen. This file is derived, never edited by hand — the
// set a question belongs to is recoverable from its id prefix (r2-, r2h-, r2u-),
// which is how the analysis re-splits them afterwards.

import { readFileSync, writeFileSync } from "node:fs";

const SETS = [
  { file: "datasets/run2-questions.json", prefix: "r2-", count: 96 },
  { file: "datasets/run2-hard.json", prefix: "r2h-", count: 96 },
  { file: "datasets/run2-unanswerable.json", prefix: "r2u-", count: 12 },
];

const all = [];
for (const { file, prefix, count } of SETS) {
  const rows = JSON.parse(readFileSync(file, "utf8"));
  if (rows.length !== count) throw new Error(`${file}: expected ${count} questions, found ${rows.length}`);
  for (const row of rows) {
    if (!row.id?.startsWith(prefix)) throw new Error(`${file}: id ${row.id} does not start with ${prefix}`);
  }
  all.push(...rows);
}

// Ids key the run log. Two questions sharing one would merge into a single row
// and nothing downstream would say so.
const ids = new Set(all.map((q) => q.id));
if (ids.size !== all.length) throw new Error(`duplicate id across sets: ${all.length - ids.size} collision(s)`);

writeFileSync("datasets/run2-all.json", JSON.stringify(all, null, 2) + "\n");
console.log(`datasets/run2-all.json: ${all.length} questions (${SETS.map((s) => s.count).join(" + ")})`);
