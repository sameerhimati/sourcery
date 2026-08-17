import OpenAI from "openai";
import { getClient } from "./openai-compat";
import {
  complete,
  explainLlmError,
  modelRejectsTemperature,
  parseModelRef,
  PROVIDERS,
  unfenceJson,
  type ChatMessage,
  type CompleteArgs,
} from "./index";

// ─── Bulk judging through the providers' batch APIs ───
//
// Judging is the one part of this project that is perfectly suited to batching:
// tens of thousands of independent calls, no user waiting on any of them, and a
// result that is written to an append-only log rather than shown on a screen.
// Both labs charge half price for exactly that trade, so the run's largest
// line item halves.
//
// The reason this fits without disturbing the rest of the design is that the
// resume keys already are the identity of a request. judgementKey(),
// setVerdictKey() and noSearchKey() each name one unit of work, uniquely, and a
// batch result comes back labelled with whatever id you sent — so results map
// straight back onto the same logs and `--resume` needs no changes at all.
//
// Not batched, deliberately:
//   * the fetch phase — provider credits, not tokens, with its own failure
//     semantics and its own idea of what a retry means.
//   * calibration, smoke runs and the anchor checks — they need an answer now,
//     and a 24-hour ceiling is intolerable when someone is watching.

/** Anthropic requires max_tokens; the judges emit one short JSON object. */
const ANTHROPIC_MAX_TOKENS = 1024;
const DEFAULT_POLL_MS = 10_000;
/** Both labs quote most batches finishing well inside an hour, with 24h the
 *  hard ceiling. Stopping earlier is safe: unfinished work simply isn't written,
 *  and the next `--resume` picks it up. */
const DEFAULT_TIMEOUT_MS = 6 * 60 * 60 * 1000;

export interface BatchRequest {
  /** The caller's own resume key. Comes back verbatim — never rely on order. */
  customId: string;
  args: CompleteArgs;
}

export interface BatchOutcome {
  customId: string;
  text?: string;
  error?: string;
}

export interface BatchOpts {
  pollMs?: number;
  timeoutMs?: number;
  onProgress?: (status: string) => void;
}

/** Providers with a batch API wired up here. Everything else runs synchronously,
 *  which is a fallback rather than a failure — see completeBatch. */
export function supportsBatch(modelRef: string): boolean {
  const { provider } = parseModelRef(modelRef);
  return provider === "openai" || provider === "anthropic";
}

function apiKeyFor(provider: string, modelRef: string): string {
  const spec = PROVIDERS[provider];
  const key = process.env[spec.envKey]?.trim();
  if (!key) {
    throw new Error(
      `Missing ${spec.envKey} for model "${modelRef}" (provider "${provider}"). ` +
        `Set it in .env.local, or run \`sourcery init\` to write one.`,
    );
  }
  return key;
}

/**
 * Find out whether a model accepts `temperature` BEFORE building a batch.
 *
 * The synchronous path learns this from a 400 and retries, which costs one
 * wasted call. A batch cannot do that: the whole submission would fail, and it
 * would fail an hour later rather than immediately. So one tiny real call per
 * model per run buys the answer up front — far cheaper than discovering it
 * after the batch has been queued.
 */
async function probeTemperature(modelRef: string, temperature: number): Promise<void> {
  if (modelRejectsTemperature(modelRef)) return;
  try {
    await complete({
      model: modelRef,
      temperature,
      messages: [{ role: "user", content: "Reply with the single character: x" }],
    });
  } catch {
    // A probe failure that isn't about temperature (a bad key, a rate limit)
    // is left for the real request to report properly, with its own context.
  }
}

/** Split our system+user messages into Anthropic's native shape, where the
 *  system prompt is a top-level parameter rather than a message. */
export function toAnthropicParams(
  messages: ChatMessage[],
): { system?: string; messages: { role: "user" | "assistant"; content: string }[] } {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const rest = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
  return { ...(system ? { system } : {}), messages: rest };
}

// ─── OpenAI ───

async function runOpenAiBatch(reqs: BatchRequest[], opts: BatchOpts): Promise<BatchOutcome[]> {
  const apiKey = apiKeyFor("openai", reqs[0].args.model);
  const client = getClient(undefined, apiKey);

  const jsonl = reqs
    .map((r) => {
      const { model } = parseModelRef(r.args.model);
      const withTemp = r.args.temperature !== undefined && !modelRejectsTemperature(r.args.model);
      return JSON.stringify({
        custom_id: r.customId,
        method: "POST",
        url: "/v1/chat/completions",
        body: {
          model,
          messages: r.args.messages,
          ...(withTemp ? { temperature: r.args.temperature } : {}),
          ...(r.args.jsonMode ? { response_format: { type: "json_object" } } : {}),
        },
      });
    })
    .join("\n");

  const file = await client.files.create({
    file: await OpenAI.toFile(Buffer.from(jsonl, "utf8"), "sourcery-batch.jsonl"),
    purpose: "batch",
  });
  let batch = await client.batches.create({
    input_file_id: file.id,
    endpoint: "/v1/chat/completions",
    completion_window: "24h",
  });
  opts.onProgress?.(`openai batch ${batch.id} submitted (${reqs.length} requests)`);

  const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  while (!["completed", "failed", "expired", "cancelled"].includes(batch.status)) {
    if (Date.now() > deadline) {
      return reqs.map((r) => ({
        customId: r.customId,
        error: `openai batch ${batch.id} still ${batch.status} after the wait ceiling — resume will retry`,
      }));
    }
    await new Promise((r) => setTimeout(r, opts.pollMs ?? DEFAULT_POLL_MS));
    batch = await client.batches.retrieve(batch.id);
    const c = batch.request_counts;
    opts.onProgress?.(
      `openai batch ${batch.id}: ${batch.status}` +
        (c ? ` (${c.completed}/${c.total} done, ${c.failed} failed)` : ""),
    );
  }

  const outcomes = new Map<string, BatchOutcome>();
  for (const fileId of [batch.output_file_id, batch.error_file_id]) {
    if (!fileId) continue;
    const body = await (await client.files.content(fileId)).text();
    for (const line of body.split("\n").filter(Boolean)) {
      const row = JSON.parse(line) as {
        custom_id: string;
        response?: { status_code?: number; body?: unknown };
        error?: unknown;
      };
      const b = row.response?.body as
        | { choices?: { message?: { content?: string } }[]; error?: { message?: string } }
        | undefined;
      const text = b?.choices?.[0]?.message?.content?.trim();
      if (row.response?.status_code === 200 && text !== undefined) {
        outcomes.set(row.custom_id, { customId: row.custom_id, text });
      } else {
        const msg = b?.error?.message ?? JSON.stringify(row.error ?? row.response ?? {}).slice(0, 200);
        outcomes.set(row.custom_id, { customId: row.custom_id, error: msg });
      }
    }
  }

  // A request that appears in neither file is not silently dropped — an unwritten
  // row is a row `--resume` will retry, but only if it is reported as failed.
  return reqs.map(
    (r) =>
      outcomes.get(r.customId) ?? {
        customId: r.customId,
        error: `openai batch ${batch.id} returned no result for this request (batch ${batch.status})`,
      },
  );
}

// ─── Anthropic ───
// Reached by raw fetch rather than a second SDK. Batches live on the native
// Messages API, not the OpenAI-compatible layer the rest of this file uses, and
// pulling in @anthropic-ai/sdk for one endpoint would cost more than it saves.

const ANTHROPIC_BASE = "https://api.anthropic.com/v1";

async function anthropicFetch(path: string, apiKey: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${ANTHROPIC_BASE}${path}`, {
    ...init,
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new Error(`anthropic batch ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
}

async function runAnthropicBatch(reqs: BatchRequest[], opts: BatchOpts): Promise<BatchOutcome[]> {
  const apiKey = apiKeyFor("anthropic", reqs[0].args.model);

  const created = (await anthropicFetch("/messages/batches", apiKey, {
    method: "POST",
    body: JSON.stringify({
      requests: reqs.map((r) => {
        const { model } = parseModelRef(r.args.model);
        const withTemp = r.args.temperature !== undefined && !modelRejectsTemperature(r.args.model);
        return {
          custom_id: r.customId,
          params: {
            model,
            max_tokens: ANTHROPIC_MAX_TOKENS,
            ...toAnthropicParams(r.args.messages),
            ...(withTemp ? { temperature: r.args.temperature } : {}),
          },
        };
      }),
    }),
  })) as { id: string; processing_status: string };

  opts.onProgress?.(`anthropic batch ${created.id} submitted (${reqs.length} requests)`);

  const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let status = created.processing_status;
  let results_url: string | undefined;
  while (status !== "ended") {
    if (Date.now() > deadline) {
      return reqs.map((r) => ({
        customId: r.customId,
        error: `anthropic batch ${created.id} still ${status} after the wait ceiling — resume will retry`,
      }));
    }
    await new Promise((r) => setTimeout(r, opts.pollMs ?? DEFAULT_POLL_MS));
    const got = (await anthropicFetch(`/messages/batches/${created.id}`, apiKey)) as {
      processing_status: string;
      results_url?: string;
      request_counts?: Record<string, number>;
    };
    status = got.processing_status;
    results_url = got.results_url;
    const c = got.request_counts;
    opts.onProgress?.(
      `anthropic batch ${created.id}: ${status}` +
        (c ? ` (${c.succeeded ?? 0} ok, ${c.errored ?? 0} errored, ${c.processing ?? 0} running)` : ""),
    );
  }

  const outcomes = new Map<string, BatchOutcome>();
  if (results_url) {
    const res = await fetch(results_url, {
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    });
    const body = await res.text();
    for (const line of body.split("\n").filter(Boolean)) {
      const row = JSON.parse(line) as {
        custom_id: string;
        result?: {
          type: string;
          message?: { content?: { type: string; text?: string }[] };
          error?: { message?: string; type?: string };
        };
      };
      if (row.result?.type === "succeeded") {
        const text = (row.result.message?.content ?? [])
          .filter((b) => b.type === "text")
          .map((b) => b.text ?? "")
          .join("")
          .trim();
        outcomes.set(row.custom_id, { customId: row.custom_id, text });
      } else {
        outcomes.set(row.custom_id, {
          customId: row.custom_id,
          error: row.result?.error?.message ?? row.result?.type ?? "anthropic batch request failed",
        });
      }
    }
  }

  return reqs.map(
    (r) =>
      outcomes.get(r.customId) ?? {
        customId: r.customId,
        error: `anthropic batch ${created.id} returned no result for this request`,
      },
  );
}

// ─── The entry point ───

/**
 * Run many completions through the providers' batch APIs, at half price.
 *
 * Groups by provider, because a batch belongs to one API. Anything whose
 * provider has no batch path here — Fireworks, Groq — is run synchronously
 * instead, and so is anything whose batch submission throws. That fallback is
 * the point rather than an afterthought: batching is an optimisation, and an
 * optimisation that can take a run down is not one.
 *
 * Text comes back unfenced for JSON callers, exactly as `complete()` returns it,
 * so a caller's parse function does not care which path produced the string.
 */
export async function completeBatch(
  reqs: BatchRequest[],
  opts: BatchOpts = {},
): Promise<BatchOutcome[]> {
  if (!reqs.length) return [];

  const groups = new Map<string, BatchRequest[]>();
  for (const r of reqs) {
    const key = supportsBatch(r.args.model) ? parseModelRef(r.args.model).provider : "__sync__";
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(r);
  }

  const runSync = async (group: BatchRequest[], why?: string): Promise<BatchOutcome[]> => {
    if (why) opts.onProgress?.(why);
    return Promise.all(
      group.map(async (r) => {
        try {
          return { customId: r.customId, text: await complete(r.args) };
        } catch (e) {
          return { customId: r.customId, error: e instanceof Error ? e.message : String(e) };
        }
      }),
    );
  };

  const out: BatchOutcome[] = [];
  for (const [provider, group] of groups) {
    if (provider === "__sync__") {
      out.push(...(await runSync(group, `${group.length} request(s) on a provider with no batch API — running synchronously`)));
      continue;
    }

    // One probe per distinct model, so the batch is built with the right
    // temperature rather than discovering the answer an hour in.
    for (const model of new Set(group.map((r) => r.args.model))) {
      const temp = group.find((r) => r.args.model === model)?.args.temperature;
      if (temp !== undefined) await probeTemperature(model, temp);
    }

    try {
      const raw =
        provider === "openai"
          ? await runOpenAiBatch(group, opts)
          : await runAnthropicBatch(group, opts);
      const wantsJson = new Map(group.map((r) => [r.customId, Boolean(r.args.jsonMode)]));
      out.push(
        ...raw.map((o) =>
          o.text !== undefined && wantsJson.get(o.customId)
            ? { ...o, text: unfenceJson(o.text) }
            : o,
        ),
      );
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      const spec = PROVIDERS[provider];
      out.push(
        ...(await runSync(
          group,
          `batch submission failed on ${provider}, falling back to synchronous: ` +
            explainLlmError(raw, provider, spec.envKey).slice(0, 200),
        )),
      );
    }
  }
  return out;
}
