// Pure presentation helpers ported verbatim from the designer's DC mockup
// (oklch color scales, age/median formatting). Kept null-safe: real runs have
// sources with unknown publish dates, which the mockup's hardcoded data never
// did. `null` age = "unknown" → neutral dot, sorted last, excluded from medians.

/** Whole-day age of an ISO date vs `now` (ms). null in → null out. */
export function ageDays(published: string | null | undefined, now: number): number | null {
  if (!published) return null;
  const t = new Date(published).getTime();
  if (Number.isNaN(t)) return null;
  return Math.round((now - t) / 86400000);
}

export function ageLabel(days: number | null): string {
  if (days === null) return "undated";
  if (days < 1) return "today";
  if (days < 60) return days + "d ago";
  return Math.round(days / 30) + "mo ago";
}

export function medLabel(days: number | null): string {
  if (days === null) return "—";
  if (days < 60) return days + "d";
  return Math.round(days / 30) + "mo";
}

/** Median of known ages only; null if none are dated. */
export function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

// ─── Score → magnitude ramp ───
//
// A 0–10 quality score encodes MAGNITUDE, not polarity: there is no meaningful
// neutral at 5, only "less good" and "more good". So this is a *sequential*
// ramp — one hue, light→dark — and not the red→amber→green it used to be.
//
// Red/amber/green was wrong twice over. It put a third hue at the midpoint of a
// scale with no midpoint to mark, and it spent the loudest colour in the palette
// on the most common value: real scores cluster between 1 and 7, so a warning
// ramp painted almost every cell as an alarm. A scale that flags everything
// flags nothing. It also failed red/green colour-blind readers outright, which
// a single-hue ramp cannot.
//
// Steps are the validated blue scale, monotonic in lightness. `SCORE_STEPS` is
// indexed by the rounded score, so index 0 sits nearest the page and 10 is the
// deepest. Cells emit `heat-N` classes rather than inline colours, which lets
// the dark theme restate the whole ramp against a dark surface in CSS instead of
// flipping the light one (an auto-flip is not a dark palette).
export const SCORE_STEPS_LIGHT = [
  "#f2f7fe", "#e2edfd", "#cde2fb", "#b7d3f6", "#9ec5f4", "#86b6ef",
  "#6da7ec", "#5598e7", "#3987e5", "#256abf", "#184f95",
] as const;

export const SCORE_STEPS_DARK = [
  "#11213a", "#122a4d", "#12325f", "#104281", "#154e96", "#1c5cab",
  "#256abf", "#2a78d6", "#3987e5", "#5598e7", "#86b6ef",
] as const;

/** Index into the score ramp. Clamped, rounded, safe on NaN/undefined. */
export function scoreStep(s: number): number {
  if (!Number.isFinite(s)) return 0;
  return Math.max(0, Math.min(10, Math.round(s)));
}

/** Ink that stays legible on `SCORE_STEPS_LIGHT[i]`. Flips once the ramp goes dark. */
export function scoreInkLight(i: number): string {
  return i >= 8 ? "#ffffff" : "#0b0b0b";
}

/** Ink for `SCORE_STEPS_DARK[i]`. Flips the other way: the ramp lightens with score. */
export function scoreInkDark(i: number): string {
  return i >= 9 ? "#0b0b0b" : "#ffffff";
}

// ─── Status tokens ───
//
// Reserved for state (a failed arm, a stale source) and never reused as a
// series colour. Shipped with a label or icon in every use, never colour alone.
export const STATUS = {
  good: { light: "#1a7f4b", dark: "#3fae76" },
  warning: { light: "#a76a00", dark: "#d99a2b" },
  critical: { light: "#b3261e", dark: "#e88b85" },
  neutral: { light: "#6b6a66", dark: "#9b9a94" },
} as const;

export function freshStatus(days: number | null): keyof typeof STATUS {
  if (days === null) return "neutral";
  if (days <= 30) return "good";
  if (days <= 180) return "warning";
  return "critical";
}

// ─── Provider identity ───
//
// Categorical: colour means *which provider*, never how well it did. Slots are
// assigned in a fixed order and never recycled by rank, so a reader who learns
// "Firecrawl is orange" keeps that when a filter changes the set on screen.
//
// Each hue clears the CVD and normal-vision floors in both light and dark,
// checked against its neighbours in the order they render. Eight is the ceiling
// and this set is at it: every pair of neighbours is far enough apart, but not
// every pair in the whole set is — that was already true of the original four
// (amber and orange are close), and adding four more only tightened it. Colour
// is a redundant channel here, never the only one. A ninth provider needs a
// different answer than a ninth hue. Blue is deliberately absent: it is the
// magnitude ramp above, and a hue that means "which provider" in one mark and
// "how good" in the next is the ambiguity the whole scheme exists to prevent.
// Two of the light steps sit under 3:1 against the page, so every use of a
// provider colour must carry its visible label — which the report does, making
// colour a redundant channel rather than the only one.
//
// Deliberately duplicates the labels in the adapter registry rather than
// importing it: this module is safe to import client-side, and core/adapters
// pulls every provider's network code in with it. Keep the labels in step with
// `ADAPTERS` in core/adapters/index.ts — an unknown id degrades to its raw id
// and a neutral grey, so a missed entry is cosmetic, not broken.
export const PROVIDERS: Record<string, { label: string; color: string; dark: string }> = {
  bright_data: { label: "Bright Data", color: "#4a3aa7", dark: "#9085e9" },
  firecrawl: { label: "Firecrawl", color: "#eb6834", dark: "#d95926" },
  tavily: { label: "Tavily", color: "#1baf7a", dark: "#199e70" },
  exa: { label: "Exa", color: "#eda100", dark: "#c98500" },
  brave: { label: "Brave", color: "#0a8f9e", dark: "#189eb0" },
  serper: { label: "Serper", color: "#a83a3a", dark: "#c9564f" },
  perplexity: { label: "Perplexity", color: "#b02a9e", dark: "#b94fb2" },
  parallel: { label: "Parallel", color: "#5a7d2a", dark: "#7d9435" },
  // Grey on purpose — the baseline shouldn't read as a peer of the paid arms.
  plain: { label: "Plain fetch", color: "#6b6a66", dark: "#9b9a94" },
};

const UNKNOWN_PROVIDER = { label: "", color: "#6b6a66", dark: "#9b9a94" };

export function providerMeta(provider: string): { label: string; color: string; dark: string } {
  return PROVIDERS[provider] ?? { ...UNKNOWN_PROVIDER, label: provider };
}
