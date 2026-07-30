// Pure presentation helpers ported verbatim from the designer's DC mockup
// (oklch color scales, age/median formatting). Kept null-safe: real runs have
// sources with unknown publish dates, which the mockup's hardcoded data never
// did. `null` age = "unknown" → neutral dot, sorted last, excluded from medians.

const NEUTRAL_DOT = "oklch(0.72 0.02 90)"; // warm grey for unknown-date sources

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

export function freshDot(days: number | null): string {
  if (days === null) return NEUTRAL_DOT;
  if (days <= 30) return "oklch(0.6 0.16 150)";
  if (days <= 180) return "oklch(0.65 0.15 75)";
  return "oklch(0.58 0.2 28)";
}

/** Median of known ages only; null if none are dated. */
export function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

// Midpoint of every score scale. 5/10 is "middling" and should look middling —
// amber. This used to be 7 for the heatmap, which made everything below it red:
// on real data (scores cluster between 1 and 7) that rendered the entire grid as
// one alarming block, so a 5 and a 1 were indistinguishable and the eye had
// nothing to compare. A scale that flags everything flags nothing.
const MID_SCORE = 5;

/** Score 0–10 → red→green oklch text color. */
export function scoreText(s: number): string {
  const t = Math.max(0, Math.min(1, (s - MID_SCORE) / MID_SCORE));
  const hue = 28 + t * (150 - 28);
  return `oklch(0.5 0.15 ${hue})`;
}

/** Heatmap cell background: red (0) → amber (5) → green (10). */
export function heatColor(s: number): string {
  const clamped = Math.max(0, Math.min(10, s));
  // Hue ramps red(30) → amber(85) → green(150). Chroma dips at the midpoint so
  // amber reads as neutral rather than as a third alarming colour.
  const t = clamped / 10;
  const hue = clamped <= MID_SCORE
    ? 30 + (clamped / MID_SCORE) * (85 - 30)
    : 85 + ((clamped - MID_SCORE) / (10 - MID_SCORE)) * (150 - 85);
  const distanceFromMid = Math.abs(t - 0.5) * 2; // 0 at amber, 1 at either end
  return `oklch(${0.95 - distanceFromMid * 0.05} ${0.045 + distanceFromMid * 0.085} ${hue})`;
}

export function heatText(): string {
  return "#2a2620";
}

export function heatBadge(s: number): string {
  return s >= MID_SCORE ? "oklch(0.5 0.14 150)" : "oklch(0.55 0.18 30)";
}

// Provider identity (colors + labels), ported from the mockup.
//
// Deliberately duplicates the labels in the adapter registry rather than
// importing it: this module is safe to import client-side, and core/adapters
// pulls every provider's network code in with it. Keep the labels in step with
// `ADAPTERS` in core/adapters/index.ts — an unknown id degrades to its raw id
// and a neutral grey, so a missed entry is cosmetic, not broken.
export const PROVIDERS: Record<string, { label: string; color: string }> = {
  bright_data: { label: "Bright Data", color: "oklch(0.5 0.14 250)" },
  firecrawl: { label: "Firecrawl", color: "oklch(0.55 0.16 50)" },
  tavily: { label: "Tavily", color: "oklch(0.52 0.14 160)" },
  exa: { label: "Exa", color: "oklch(0.5 0.15 300)" },
  // Grey on purpose — the baseline shouldn't read as a peer of the paid arms.
  plain: { label: "Plain fetch", color: "oklch(0.55 0.03 90)" },
};

export function providerMeta(provider: string): { label: string; color: string } {
  return PROVIDERS[provider] ?? { label: provider, color: "oklch(0.5 0.02 90)" };
}
