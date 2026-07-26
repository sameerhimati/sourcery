import { NextRequest, NextResponse } from "next/server";
import { runEval } from "@core/orchestrator";
import { appendRecords, toRunRecord, RUNS_PATH } from "@core/records";
import { RunRequest } from "@core/types";

// Arms run fetch -> answer -> judge; give them room on slow SERP calls.
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as RunRequest;
    if (!body?.query?.trim()) {
      return NextResponse.json({ error: "query is required" }, { status: 400 });
    }
    const run = await runEval(body);

    // Same append path and id scheme as `sourcery run`, so a run started from
    // the dashboard is a first-class record — it shows up in `sourcery report`
    // and the scorecard. A failed write must not swallow a run the user just
    // paid credits for, so it degrades to a warning.
    try {
      appendRecords([
        toRunRecord(run, `run_${Date.now().toString(36)}`, new Date().toISOString()),
      ]);
    } catch (e) {
      console.warn(`could not append to ${RUNS_PATH}:`, e);
    }

    return NextResponse.json(run);
  } catch (e) {
    const message = e instanceof Error ? e.message : "internal error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
