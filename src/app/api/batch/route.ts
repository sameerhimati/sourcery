import { NextRequest, NextResponse } from "next/server";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { runBatch, selectQueries } from "@/lib/batch";

// Batch is slow + credit-heavy (every query × both providers × extraction), so
// it runs offline and commits its output; the Scorecard reads the JSON. This
// endpoint regenerates on demand. `?perType=N` caps queries per type for a
// quick pass; omit for the full dataset.
export const maxDuration = 800;

export async function POST(req: NextRequest) {
  try {
    const perType = Number(new URL(req.url).searchParams.get("perType") ?? "0");
    const queries = selectQueries(Number.isFinite(perType) ? perType : 0);
    const out = await runBatch(queries);

    const dir = path.join(process.cwd(), "src", "lib");
    // heatmap-data.json = aggregates for the grid; batch-rows.json = raw per-query rows.
    await Promise.all([
      writeFile(
        path.join(dir, "heatmap-data.json"),
        JSON.stringify(
          {
            generated_at: out.generated_at,
            runs_per_cell: out.runs_per_cell,
            heatmap: out.heatmap,
          },
          null,
          2,
        ),
      ),
      writeFile(
        path.join(dir, "batch-rows.json"),
        JSON.stringify({ generated_at: out.generated_at, rows: out.rows }, null, 2),
      ),
    ]);

    return NextResponse.json({
      ok: true,
      queries: queries.length,
      arms: out.rows.length,
      runs_per_cell: out.runs_per_cell,
      heatmap: out.heatmap,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "batch failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
