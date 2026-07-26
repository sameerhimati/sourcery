import { NextResponse } from "next/server";
import { deriveHeatmap, runsPerCell } from "@core/batch";
import { readRecords, RUNS_PATH } from "@core/records";

// The dashboard is a view over the CLI's contract file, never a second source of
// truth. Every request re-reads .sourcery/runs.jsonl, so a `sourcery batch`
// finishing in another terminal shows up on the next refresh — no rebuild, no
// generated JSON checked into src/.
export async function GET() {
  try {
    const records = readRecords();
    const rows = records.flatMap((r) => (r.mode === "batch" ? [r.row] : []));
    const heatmap = deriveHeatmap(rows);
    return NextResponse.json({
      path: RUNS_PATH,
      records: records.length, // includes single-query runs the grid doesn't plot
      rows,
      heatmap,
      runs_per_cell: runsPerCell(heatmap),
    });
  } catch (e) {
    // A hand-edited / truncated JSONL line lands here — say so rather than
    // rendering an empty scorecard that looks like "you never ran anything".
    const message = e instanceof Error ? e.message : `could not read ${RUNS_PATH}`;
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
