import { getClient } from "./openai-compat";

// ─── Provider-agnostic LLM layer ───
// One seam, mirroring the retrieval-adapter seam (core/adapters/). Every arm's
// answer + both judges go through complete(); the model ref decides which
// OpenAI-compatible provider serves it. Fireworks-first because it serves the
// stale OSS models (Llama 3.1) the anti-cheat design needs, and the hackathon
// credits live there — but the seam is the product: new providers = one row.

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompleteArgs {
  /** "provider/model" ref, or a bare OpenAI model (back-compat). */
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  /** Request response_format: {type:"json_object"} — both judges need it. */
  jsonMode?: boolean;
}

/** An OpenAI-compatible provider. Adding Together/Groq/vLLM later = one row. */
export interface ProviderSpec {
  /** undefined = OpenAI SDK default (https://api.openai.com/v1). */
  baseURL?: string;
  envKey: string;
  /**
   * How this provider is asked for JSON, since "OpenAI-compatible" does not
   * extend to `response_format`. Default "object" sends
   * `{type:"json_object"}`. "prompt" sends nothing and leans on the system
   * prompt — every JSON caller here already ends with "Return JSON only:" and
   * the exact shape — because the provider rejects `json_object` outright.
   */
  jsonMode?: "object" | "prompt";
}

export const PROVIDERS: Record<string, ProviderSpec> = {
  openai: { envKey: "OPENAI_API_KEY" },
  fireworks: {
    baseURL: "https://api.fireworks.ai/inference/v1",
    envKey: "FIREWORKS_API_KEY",
  },
  // The free, fast way in: no credit card, and the quickest tokens/sec of any
  // free tier, which matters because every run is one answer call plus two
  // judge calls. That is most of the wall-clock that isn't retrieval.
  groq: {
    baseURL: "https://api.groq.com/openai/v1",
    envKey: "GROQ_API_KEY",
  },
  // Reached through Anthropic's OpenAI-compatible endpoint rather than its own
  // SDK, so it costs one row here instead of a second client. Anthropic frames
  // that layer as being for comparison rather than production, and it does not
  // support prompt caching — neither limitation binds here, since this makes
  // plain chat completions and caches nothing.
  //
  // Good as an ANSWER model, poor as the judge: the anti-cheat wants a judge
  // whose cutoff predates the queries, and a current Claude fails a correctly
  // sourced post-cutoff answer more often, not less.
  //
  // The compatibility layer takes `response_format` only as `json_schema`, and
  // answers `json_object` with a 400. Both judges and the MCP classifier ask for
  // JSON, so without "prompt" mode every Anthropic arm fails before it is scored.
  anthropic: {
    baseURL: "https://api.anthropic.com/v1/",
    envKey: "ANTHROPIC_API_KEY",
    jsonMode: "prompt",
  },
};

const DEFAULT_PROVIDER = "openai";

/**
 * Split a model ref into { provider, model }. Split on the FIRST "/" only:
 * Fireworks model ids themselves contain slashes
 * (fireworks/accounts/fireworks/models/kimi-k2-instruct → provider "fireworks",
 * model "accounts/fireworks/models/kimi-k2-instruct"). A ref whose prefix isn't
 * a known provider is treated as an OpenAI model — back-compat for existing
 * configs, `--model gpt-4o`, and the engine default `gpt-4o-mini`.
 */
export function parseModelRef(ref: string): { provider: string; model: string } {
  const slash = ref.indexOf("/");
  if (slash !== -1) {
    const prefix = ref.slice(0, slash);
    if (prefix in PROVIDERS) {
      return { provider: prefix, model: ref.slice(slash + 1) };
    }
  }
  return { provider: DEFAULT_PROVIDER, model: ref };
}

/** Deduped env keys that must be set for the given model refs to run. */
export function requiredEnvKeys(refs: string[]): string[] {
  const keys = new Set<string>();
  for (const ref of refs) {
    const { provider } = parseModelRef(ref);
    keys.add(PROVIDERS[provider].envKey);
  }
  return [...keys];
}

/**
 * Turn a provider's API error into something a person can act on.
 *
 * Groq is the path `init` recommends first and its free tier caps tokens per
 * minute; each arm is one answer call plus two judge calls with page content
 * inline, so a three-provider run trips it. The raw 429 mentions an org id and a
 * TPM budget and reads like a bug in the tool. The original is kept on the end —
 * this explains, it does not hide.
 */
export function explainLlmError(message: string, provider: string, envKey: string): string {
  if (/\b429\b|rate limit/i.test(message)) {
    const wait = message.match(/try again in ([\d.]+)\s*s/i)?.[1];
    return (
      `${provider} rate limit${wait ? ` — retry in ${Math.ceil(Number(wait))}s` : ""}. ` +
      `Free tiers cap tokens per minute, and every arm costs one answer call plus ` +
      `two judge calls, so comparing fewer providers at once stays under it. (${message})`
    );
  }
  if (/\b401\b|invalid.{0,20}api key|authentication/i.test(message)) {
    return `${provider} rejected the key — check ${envKey}. (${message})`;
  }
  return message;
}

/**
 * Recover the JSON object out of a response that wrapped it in something else.
 *
 * Nothing forces bare JSON on a provider in "prompt" mode, and Claude fences it
 * every time — 6 of 6 across both judge prompts and the classifier. Every JSON
 * caller then does a bare `JSON.parse`, and both judges turn a parse failure
 * into score 0 with "unparseable output": a silently wrong number rather than an
 * error, which is the worst way for this to fail.
 *
 * Two wrappers, both measured on real judge calls:
 *
 * 1. A markdown code fence around the whole object.
 * 2. A sentence of prose BEFORE the object — "This describes Flight 13 as the
 *    most recent…\n\n{"rung": 3, …}". Claude Sonnet 5 did this on 1 call in 12
 *    against real pages, and it cost that judge 11% of its verdicts in a live
 *    smoke run: dropped, counted as null, excluded from scoring. Loud rather
 *    than wrong, but a judge quietly missing an eighth of its ratings is not a
 *    judge you want on a five-model panel.
 *
 * Runs for every provider, not just the ones that wrap. Neither a fence nor a
 * preamble is valid JSON, so removing one cannot break a response that already
 * parsed — and a response that starts with `{` is returned untouched.
 */
export function unfenceJson(text: string): string {
  const fenced = text.trim().match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
  const body = (fenced ? fenced[1] : text).trim();
  if (body.startsWith("{")) return body;
  // First brace to last brace. The judges' shapes are flat objects whose only
  // string field is a one-sentence rationale, so the outermost pair is the
  // object even when the rationale itself contains a brace.
  const open = body.indexOf("{");
  const close = body.lastIndexOf("}");
  return open !== -1 && close > open ? body.slice(open, close + 1) : body;
}

/**
 * Models that reject an explicit `temperature`, learned at runtime.
 *
 * The newest generation on both labs dropped the knob: Claude Sonnet 5 and Opus
 * 5 answer "`temperature` is deprecated for this model", and GPT-5.5, the
 * GPT-5.6 family and o4-mini answer "does not support 0 … only the default (1)".
 * Both are 400s, so a judge that used to work now fails outright.
 *
 * Learned rather than listed on purpose. A hardcoded list of model names goes
 * stale the week after it is written, and the failure mode of a stale list is a
 * dead run. The API already tells us — this remembers what it said, so the cost
 * is one wasted call per model per process rather than a maintenance burden.
 *
 * This is not a loosening of the controls. Temperature 0 was only ever a means
 * to reproducible verdicts, and the models that reject it were measured on
 * 2026-08-17 to return identical rungs across five repetitions, including on a
 * deliberately borderline page. The control the run states is "each judge in its
 * most deterministic available configuration", which this implements.
 */
const rejectsTemperature = new Set<string>();

/** Has this model already told us it rejects an explicit temperature? Read by
 *  the batch path, which must know before it submits — see batch.ts. */
export function modelRejectsTemperature(modelRef: string): boolean {
  return rejectsTemperature.has(modelRef);
}

/** Does this 400 mean "you may not set temperature"? */
export function isTemperatureRejection(message: string): boolean {
  return /temperature/i.test(message) && /deprecat|does not support|unsupported|only the default/i.test(message);
}

/**
 * Single LLM entry point for the engine. Resolves the provider from the model
 * ref, fails with a friendly message (not a stack trace) when its key is
 * missing, and returns the completion text. Callers that want JSON parse the
 * returned string themselves.
 */
export async function complete({
  model,
  messages,
  temperature,
  jsonMode,
}: CompleteArgs): Promise<string> {
  const { provider, model: modelId } = parseModelRef(model);
  const spec = PROVIDERS[provider];
  const apiKey = process.env[spec.envKey]?.trim();
  if (!apiKey) {
    throw new Error(
      `Missing ${spec.envKey} for model "${model}" (provider "${provider}"). ` +
        // `.env.example` is not in the npm tarball, so naming it here sent npx
        // users to a file they don't have. `init` writes the real thing.
        `Set it in .env.local, or run \`sourcery init\` to write one.`,
    );
  }
  const client = getClient(spec.baseURL, apiKey);
  const sendResponseFormat = jsonMode && (spec.jsonMode ?? "object") === "object";
  const send = (withTemperature: boolean) =>
    client.chat.completions.create({
      model: modelId,
      ...(withTemperature && temperature !== undefined ? { temperature } : {}),
      ...(sendResponseFormat ? { response_format: { type: "json_object" as const } } : {}),
      messages,
    });

  let res;
  try {
    res = await send(!rejectsTemperature.has(model));
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    // One retry, only for the one error that a retry can fix. Deliberately NOT
    // conditioned on the model being absent from the set: judging runs many
    // calls at once, and the first four all fail before any of them has learned
    // anything. Gating the retry on "we haven't seen this yet" meant whichever
    // call lost the race retried, and every other in-flight call threw — one
    // arriving verdict and three dead ones, from an error every one of them
    // could have recovered from. The retry cannot loop: send(false) omits
    // temperature, so the same rejection cannot come back a second time.
    if (temperature !== undefined && isTemperatureRejection(raw)) {
      rejectsTemperature.add(model);
      try {
        res = await send(false);
      } catch (e2) {
        const raw2 = e2 instanceof Error ? e2.message : String(e2);
        throw new Error(explainLlmError(raw2, provider, spec.envKey));
      }
    } else {
      throw new Error(explainLlmError(raw, provider, spec.envKey));
    }
  }
  const text = res.choices[0]?.message?.content?.trim() ?? "";
  return jsonMode ? unfenceJson(text) : text;
}
