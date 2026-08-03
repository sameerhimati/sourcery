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
  anthropic: {
    baseURL: "https://api.anthropic.com/v1/",
    envKey: "ANTHROPIC_API_KEY",
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
        `Set it in .env.local (see .env.example).`,
    );
  }
  const client = getClient(spec.baseURL, apiKey);
  const res = await client.chat.completions.create({
    model: modelId,
    ...(temperature !== undefined ? { temperature } : {}),
    ...(jsonMode ? { response_format: { type: "json_object" as const } } : {}),
    messages,
  });
  return res.choices[0]?.message?.content?.trim() ?? "";
}
