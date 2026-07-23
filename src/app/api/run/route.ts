import { NextRequest, NextResponse } from "next/server";
import { runEval } from "@core/orchestrator";
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
    return NextResponse.json(run);
  } catch (e) {
    const message = e instanceof Error ? e.message : "internal error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
