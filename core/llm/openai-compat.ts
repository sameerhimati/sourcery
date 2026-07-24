import OpenAI from "openai";

// The one adapter that covers every provider: the OpenAI SDK with a swappable
// baseURL. Fireworks, Together, Groq, vLLM, … all speak the OpenAI chat API, so
// pointing the SDK at their baseURL is the whole integration. Clients are
// memoized by baseURL (undefined = OpenAI's own api.openai.com) so we build one
// per provider, lazily, on first use — never at import time.
const clients = new Map<string, OpenAI>();

/** Memoized OpenAI-compatible client for a baseURL. Reads no env itself. */
export function getClient(baseURL: string | undefined, apiKey: string): OpenAI {
  const cacheKey = baseURL ?? "openai";
  let client = clients.get(cacheKey);
  if (!client) {
    client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
    clients.set(cacheKey, client);
  }
  return client;
}
