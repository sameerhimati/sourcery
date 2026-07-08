import OpenAI from "openai";

// Reads OPENAI_API_KEY from the environment (.env.local, server-side only).
export const openai = new OpenAI();

// SAME model for answer + judge across every arm — a held-constant control.
export const MODEL = "gpt-4o-mini";
