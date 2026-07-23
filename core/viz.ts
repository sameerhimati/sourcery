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

/** Score 0–10 → red→green oklch text color. */
export function scoreText(s: number): string {
  const t = Math.max(0, Math.min(1, (s - 5) / 5));
  const hue = 28 + t * (150 - 28);
  return `oklch(0.5 0.15 ${hue})`;
}

/** Heatmap cell background. */
export function heatColor(s: number): string {
  const mid = 7;
  if (s >= mid) {
    const t = (s - mid) / (10 - mid);
    return `oklch(${0.94 - t * 0.07} ${0.05 + t * 0.09} 150)`;
  }
  const t = (mid - s) / mid;
  return `oklch(${0.94 - t * 0.03} ${0.05 + t * 0.1} 30)`;
}

export function heatText(): string {
  return "#2a2620";
}

export function heatBadge(s: number): string {
  return s >= 7 ? "oklch(0.5 0.14 150)" : "oklch(0.55 0.18 30)";
}

// Provider identity (colors + labels), ported from the mockup.
export const PROVIDERS: Record<string, { label: string; color: string }> = {
  bright_data: { label: "Bright Data", color: "oklch(0.5 0.14 250)" },
  firecrawl: { label: "Firecrawl", color: "oklch(0.55 0.16 50)" },
};

export function providerMeta(provider: string): { label: string; color: string } {
  return PROVIDERS[provider] ?? { label: provider, color: "oklch(0.5 0.02 90)" };
}
