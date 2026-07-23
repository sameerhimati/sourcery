import OpenAI from "openai";

// Lazily constructed so that importing the engine (e.g. `sourcery --help`, or a
// run whose arms never reach the model) does not require OPENAI_API_KEY — only
// actually calling the model does. The CLI loads .env before the first call, so
// eager construction at import time would read the env too early and crash.
// MODEL and the held-constant prompts/params live in controls.ts (single source
// of truth, shared with the UI's Controls tab).
let client: OpenAI | null = null;

/** Memoized OpenAI client; reads OPENAI_API_KEY on first use. */
export function getOpenAI(): OpenAI {
  if (!client) client = new OpenAI();
  return client;
}
