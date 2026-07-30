import { getAdapter } from "./adapters";
import type { ArmConfig } from "./types";

// ─── pre-flight cost estimate ───
// The failure this exists to prevent, in full: a 240-arm run started against a
// gauge that reported twice the runway it had, ground for two hours, and turned
// into 402s partway through. Nothing warned, because nothing was asked to.
//
// So before a long run: say what it will cost, against what is actually left,
// and stop if that exceeds what the caller said they were willing to spend.
// Firecrawl's own Agent API ships the same idea as `maxCredits`, which is a
// reasonable signal that unbounded metered spend is a real pain and not a
// hypothetical one.
//
// Only providers with a countable, exhaustible balance can answer this — today
// just Firecrawl. The rest report `null` and are shown as unmetered rather than
// guessed at, because a confident wrong number is worse than an honest gap.

export interface CostLine {
  provider: string;
  arms: number;
  /** Floor cost, and the pessimistic end for hard-to-scrape targets. */
  min: number | null;
  max: number | null;
  /** Live balance, or null when the provider exposes none. */
  remaining: number | null;
  unit: string | null;
}

export interface Estimate {
  lines: CostLine[];
  /** Summed floor and pessimistic cost across metered providers. */
  totalMin: number;
  totalMax: number;
  /** Providers whose pessimistic cost exceeds their live balance. */
  overBalance: string[];
}

/**
 * Cost one run. `armsPerProvider` is a flat count, or a per-provider map when
 * they differ — which they do under `credibility --resume`, where arms already
 * on disk cost nothing to replay. The caller knows its own shape, so this stays
 * arithmetic and does no I/O beyond the balance probes.
 */
export async function estimate(
  providers: string[],
  armsPerProvider: number | Record<string, number>,
  config: Pick<ArmConfig, "num_sources" | "extraction">,
): Promise<Estimate> {
  const armsFor = (p: string): number =>
    typeof armsPerProvider === "number" ? armsPerProvider : (armsPerProvider[p] ?? 0);

  const lines = await Promise.all(
    providers.map(async (provider): Promise<CostLine> => {
      const arms = armsFor(provider);
      const cost = getAdapter(provider).cost;
      if (!cost) {
        return { provider, arms, min: null, max: null, remaining: null, unit: null };
      }
      const per = cost.perArm(config);
      return {
        provider,
        arms,
        min: per * arms,
        max: per * cost.hardTargetMultiplier * arms,
        remaining: await cost.balance(),
        unit: cost.unit,
      };
    }),
  );

  return {
    lines,
    totalMin: lines.reduce((s, l) => s + (l.min ?? 0), 0),
    totalMax: lines.reduce((s, l) => s + (l.max ?? 0), 0),
    // Compared against the PESSIMISTIC end deliberately. A run that fits only if
    // every page scrapes cleanly is a run that strands itself on the first hard
    // target, which is the exact scenario that burned a month of credits.
    overBalance: lines
      .filter((l) => l.max !== null && l.remaining !== null && l.max > l.remaining)
      .map((l) => l.provider),
  };
}

/** The block, if this run should not start. Null means go ahead. */
export function budgetBlock(est: Estimate, maxCredits?: number): string | null {
  if (maxCredits === undefined) return null;
  if (est.totalMax <= maxCredits) return null;
  // The pessimistic end is the one checked: --max-credits is a ceiling the run
  // must not be ABLE to cross, not a figure it probably won't reach.
  return (
    `Refusing to start: this run could cost up to ${est.totalMax} credits, ` +
    `over the --max-credits ${maxCredits} ceiling.\n` +
    `Its floor cost is ${est.totalMin}. Lower the arm count (--per-type), drop a ` +
    `metered provider, or raise --max-credits if you meant to spend it.`
  );
}

export function renderEstimate(est: Estimate): string {
  const w = Math.max(8, ...est.lines.map((l) => l.provider.length));
  const cost = (l: CostLine): string =>
    l.min === null ? "" : `${l.min === l.max ? l.min : `${l.min}-${l.max}`} ${l.unit}`;
  // Width from the actual contents, not a guessed constant: a 5-figure estimate
  // ("4800-14400 credits") is exactly as wide as a hardcoded 18 and ran straight
  // into the balance beside it.
  const wCost = Math.max(...est.lines.map((l) => cost(l).length));

  const rows = est.lines.map((l) => {
    const head = `  ${l.provider.padEnd(w)}  ${String(l.arms).padStart(4)} arms  `;
    if (l.min === null) return `${head}unmetered (own quota / free)`;
    const bal =
      l.remaining === null
        ? "balance unknown"
        : `${l.remaining} left${l.max !== null && l.max > l.remaining ? "  ⚠ MAY NOT FINISH" : ""}`;
    return `${head}${cost(l).padEnd(wCost)}  ${bal}`;
  });

  const metered = est.lines.some((l) => l.min !== null);
  return [
    "Pre-flight estimate:",
    ...rows,
    ...(metered
      ? [
          `  ${"".padEnd(w)}  total: ${est.totalMin}-${est.totalMax} credits ` +
            `(the range is how hard the pages a query surfaces are to scrape)`,
        ]
      : []),
  ].join("\n");
}
