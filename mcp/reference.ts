import { bestPerType, type TypeCell, type TypeRouting } from "@core/routing";
// IMPORTED, not read from disk: package.json ships `files: ["dist"]`, so
// docs/ is not in the npm tarball. The import makes tsup inline these numbers
// into the bundle; a readFileSync would crash on every installed copy.
import s2 from "../docs/s2-summary.json";

// ─── The fallback routing table ───
// A first-time user has no .sourcery/runs.jsonl, and "no data" is a useless
// answer. We ship the S2 credibility run's per-type numbers as a starting
// point — clearly labelled as ours, not theirs.

// by_type is already the (type × provider) aggregate shape the router wants;
// the cast is only because JSON import widens `type` to string.
const summary = s2 as unknown as {
  by_type: TypeCell[];
  n_rows: number;
  providers: string[];
};

export const REFERENCE_ROUTING: TypeRouting[] = bestPerType(summary.by_type);

// Sorted so the wording is stable regardless of the order the run recorded its
// providers in.
export const REFERENCE_CAVEAT =
  `based on our ${summary.n_rows}-arm ` +
  `${[...summary.providers].sort().join("-vs-")} run, not your data — ` +
  "run `sourcery batch` to make this yours.";
