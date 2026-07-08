import OpenAI from "openai";

// Reads OPENAI_API_KEY from the environment (.env.local, server-side only).
export const openai = new OpenAI();

// MODEL and the held-constant prompts/params live in controls.ts (single
// source of truth, shared with the UI's Controls tab).
