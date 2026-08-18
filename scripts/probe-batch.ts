// Prove a batch actually completes end to end, against the real API, before
// committing thousands of requests to it.
//
// Run 2 lost every one of gpt-5.6-terra's 7,496 verdicts to a batch that was
// accepted and then failed during validation, and half of claude-sonnet-5's to
// a batch that was rejected on submit. Both were the same bug — a custom_id
// over the 64-character cap — and neither `--dry-run` nor reading the code
// found it, because neither one talks to the batch API. This does.
//
// Ten requests per lab, real judge prompts, real pages, and deliberately the
// same over-length resume keys that broke it.
//
//   npx tsx scripts/probe-batch.ts anthropic/claude-sonnet-5 gpt-5.6-terra

import fs from "node:fs";
import { loadEnv } from "../cli/env";
import { completeBatch, supportsBatch } from "../core/llm/batch";
import { judgementKey } from "../core/pooled";
import { relevanceMessages, parseRungVerdict } from "../core/relevanceJudge";
import type { PooledPage } from "../core/pool";
import { RELEVANCE_JUDGE_TEMP } from "../core/controls";

loadEnv();

const argv = process.argv.slice(2);
// --chunk forces a tiny token ceiling so ten requests split into several
// batches, which exercises the multi-batch path against the real queue rather
// than against a mock.
const forceChunk = argv.includes("--chunk");
const models = argv.filter((a) => !a.startsWith("--"));
const N = 10;
if (!models.length) {
  console.error("usage: npx tsx scripts/probe-batch.ts <model-ref> [<model-ref>...]");
  process.exit(1);
}

// Real pages from the run, so the payload size is the payload size.
const rows = fs
  .readFileSync(".sourcery/pooled-fetches.jsonl", "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l))
  .filter((r) => !r.error && (r.sources ?? []).some((s: { content?: string }) => s.content));

const pairs: PooledPage[] = [];
for (const r of rows) {
  for (const s of r.sources ?? []) {
    if (!s.content || pairs.length >= N) continue;
    if (pairs.some((p) => p.url === s.url)) continue;
    pairs.push({
      queryId: r.queryId,
      query: r.query,
      url: s.url,
      title: s.title ?? "",
      domain: s.domain ?? "",
      published: s.published ?? null,
      content: s.content,
      content_from: r.provider,
      returned_by: [r.provider],
    });
  }
  if (pairs.length >= N) break;
}

let bad = 0;

async function main(): Promise<void> {
  for (const model of models) {
    console.log(`\n─── ${model} ${supportsBatch(model) ? "(batch API)" : "(no batch API — runs synchronously)"}`);

    const reqs = pairs.map((p) => ({
      customId: judgementKey(p.queryId, p.url, model),
      args: {
        model,
        temperature: RELEVANCE_JUDGE_TEMP,
        jsonMode: true,
        messages: relevanceMessages(p),
      },
    }));

    const maxLen = Math.max(...reqs.map((r) => r.customId.length));
    console.log(`  resume keys: longest is ${maxLen} chars, and the cap on the wire is 64`);

    const started = Date.now();
    const out = await completeBatch(reqs, {
      pollMs: 5_000,
      timeoutMs: 15 * 60 * 1000,
      ...(forceChunk ? { maxBatchTokens: 4_000, maxBatchRequests: 4 } : {}),
      onProgress: (msg) => console.log("   ", msg),
    });
    const secs = ((Date.now() - started) / 1000).toFixed(0);

    const errored = out.filter((o) => o.error);
    const keyed = out.filter((o) => reqs.some((r) => r.customId === o.customId)).length;
    const parsed = out.filter((o) => o.text !== undefined && parseRungVerdict(o.text).rung !== null).length;

    console.log(
      `  ${out.length} back in ${secs}s · ${keyed}/${out.length} keyed to the real resume key · ${parsed} parsed to a rung`,
    );
    for (const e of errored.slice(0, 3)) console.log(`    ${String(e.error).slice(0, 160)}`);

    const ok = out.length === N && keyed === N && parsed === N && errored.length === 0;
    console.log(`  ${ok ? "PASS" : "FAIL"}`);
    if (!ok) bad++;
  }

  console.log(bad ? `\n${bad} model(s) failed the probe. Do not run at scale.` : "\nAll probes passed.");
  process.exit(bad ? 1 : 0);
}

void main();
