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

// What this table CANNOT say matters more to a caller than how big it is. The
// shipped reference run covers two providers, so no other provider can ever win
// here however good it is, and an agent reading a bare recommendation has no way
// to know that. Naming the covered set is the honest version; the arm count only
// told it how confident to be about a choice it was never offered.
//
// Derived from the summary, not written out, so re-running the reference against
// more providers updates this for free. Sorted for stable wording regardless of
// the order the run recorded them in.
export const REFERENCE_CAVEAT =
  `reference data from my own run, not yours. It only covers ` +
  `${[...summary.providers].sort().join(" and ")}, so no other provider can ` +
  "appear here whatever it would score. Run `sourcery batch` with your own " +
  "providers to replace it.";
