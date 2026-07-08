"use client";

import { useState } from "react";
import type { Axis, Run } from "@/lib/types";

const AXES: { value: Axis; label: string }[] = [
  { value: "provider", label: "provider" },
  { value: "freshness", label: "freshness" },
  { value: "num_sources", label: "num_sources" },
  { value: "extraction", label: "extraction" },
];

const PROVIDER_STYLES: Record<string, { badge: string; ring: string }> = {
  bright_data: {
    badge: "bg-amber-500/15 text-amber-300 border-amber-500/30",
    ring: "ring-amber-500/40",
  },
  firecrawl: {
    badge: "bg-orange-600/15 text-orange-300 border-orange-600/30",
    ring: "ring-orange-600/40",
  },
};

function providerStyle(provider: string) {
  return (
    PROVIDER_STYLES[provider] ?? {
      badge: "bg-zinc-500/15 text-zinc-300 border-zinc-500/30",
      ring: "ring-zinc-500/40",
    }
  );
}

function formatLatency(ms: number) {
  return `${(ms / 1000).toFixed(1)}s`;
}

export default function Home() {
  const [query, setQuery] = useState(
    "What are the newest changes to the H-1B visa lottery?"
  );
  const [axis, setAxis] = useState<Axis>("provider");
  const [loading, setLoading] = useState(false);
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleRun() {
    if (!query.trim() || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, variable: axis }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? "Something went wrong.");
        setRun(null);
      } else {
        setRun(data as Run);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error.");
      setRun(null);
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") handleRun();
  }

  const columnCount = run?.arms.length ?? (loading ? 2 : 0);

  return (
    <div className="flex flex-col flex-1 bg-zinc-950 text-zinc-100 font-mono">
      <main className="flex-1 w-full max-w-7xl mx-auto px-6 py-10 flex flex-col gap-8">
        {/* Header */}
        <header className="flex flex-col gap-1">
          <h1 className="text-3xl font-bold tracking-tight text-zinc-50">
            Sourcery
          </h1>
          <p className="text-sm text-zinc-400">
            Everyone evals the model. We eval the retrieval.
          </p>
        </header>

        {/* Controls */}
        <div className="flex flex-col sm:flex-row gap-3">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask something time-sensitive..."
            className="flex-1 rounded-md border border-zinc-800 bg-zinc-900 px-4 py-2.5 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-emerald-500/60 focus:ring-1 focus:ring-emerald-500/40 transition-colors"
          />
          <select
            value={axis}
            onChange={(e) => setAxis(e.target.value as Axis)}
            className="rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-emerald-500/60 focus:ring-1 focus:ring-emerald-500/40 transition-colors"
          >
            {AXES.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
          <button
            onClick={handleRun}
            disabled={loading || !query.trim()}
            className="rounded-md bg-emerald-600 px-6 py-2.5 text-sm font-semibold text-zinc-950 transition-colors hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
          >
            {loading ? "Running…" : "Run"}
          </button>
        </div>

        {/* Error banner */}
        {error && (
          <div className="rounded-md border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            {error}
          </div>
        )}

        {/* Loading skeleton */}
        {loading && (
          <div
            className="grid gap-4"
            style={{
              gridTemplateColumns: `repeat(${columnCount}, minmax(280px, 1fr))`,
            }}
          >
            {Array.from({ length: columnCount }).map((_, i) => (
              <div
                key={i}
                className="animate-pulse rounded-lg border border-zinc-800 bg-zinc-900/50 p-4 flex flex-col gap-3"
              >
                <div className="h-5 w-24 rounded bg-zinc-800" />
                <div className="h-4 w-full rounded bg-zinc-800" />
                <div className="h-8 w-16 rounded bg-zinc-800" />
                <div className="h-24 w-full rounded bg-zinc-800" />
                <div className="h-4 w-32 rounded bg-zinc-800" />
              </div>
            ))}
          </div>
        )}

        {/* Results */}
        {!loading && run && (
          <div className="flex flex-col gap-4">
            <div className="text-xs text-zinc-500">
              query:{" "}
              <span className="text-zinc-300">&ldquo;{run.query}&rdquo;</span>{" "}
              · axis: <span className="text-zinc-300">{run.variable}</span>
            </div>
            <div
              className="grid gap-4"
              style={{
                gridTemplateColumns: `repeat(${Math.max(
                  run.arms.length,
                  1
                )}, minmax(280px, 1fr))`,
              }}
            >
              {run.arms.map((arm) => {
                const isWinner = run.winner === arm.id;
                const style = providerStyle(arm.provider);
                const failed = !!arm.error;

                return (
                  <div
                    key={arm.id}
                    className={`flex flex-col gap-3 rounded-lg border p-4 ${
                      failed
                        ? "border-zinc-800 bg-zinc-900/30 opacity-60"
                        : isWinner
                        ? `border-zinc-700 bg-zinc-900 ring-2 ${style.ring}`
                        : "border-zinc-800 bg-zinc-900"
                    }`}
                  >
                    {/* Top row: arm id + winner pill */}
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-zinc-500">
                        Arm {arm.id}
                      </span>
                      {isWinner && !failed && (
                        <span className="rounded-full bg-emerald-500/20 border border-emerald-500/40 px-2 py-0.5 text-[10px] font-bold tracking-wide text-emerald-300">
                          WINNER
                        </span>
                      )}
                    </div>

                    {/* Provider badge */}
                    <span
                      className={`self-start rounded border px-2 py-0.5 text-xs font-semibold ${style.badge}`}
                    >
                      {arm.provider}
                    </span>

                    {/* Config chips */}
                    <div className="flex flex-wrap gap-1.5">
                      <span className="rounded bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-400">
                        freshness: {arm.config.freshness}
                      </span>
                      <span className="rounded bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-400">
                        num_sources: {arm.config.num_sources}
                      </span>
                      <span className="rounded bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-400">
                        extraction: {arm.config.extraction}
                      </span>
                    </div>

                    {failed ? (
                      <div className="rounded-md border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-300">
                        {arm.error}
                      </div>
                    ) : (
                      <>
                        {/* Score */}
                        <div className="flex items-baseline gap-1">
                          <span className="text-3xl font-bold text-zinc-50">
                            {arm.score}
                          </span>
                          <span className="text-sm text-zinc-500">/10</span>
                        </div>

                        {/* Answer */}
                        <p className="text-sm leading-relaxed text-zinc-200 whitespace-pre-wrap">
                          {arm.answer}
                        </p>

                        {/* Rationale */}
                        <p className="text-xs italic text-zinc-500">
                          Judge: {arm.rationale}
                        </p>

                        {/* Sources */}
                        <details className="rounded-md border border-zinc-800 bg-zinc-950/50 open:pb-2">
                          <summary className="cursor-pointer select-none px-3 py-2 text-xs font-semibold text-zinc-400 hover:text-zinc-200">
                            Sources ({arm.sources.length})
                          </summary>
                          <ul className="flex flex-col gap-2 px-3 pt-1">
                            {arm.sources.map((s, i) => (
                              <li
                                key={i}
                                className="border-t border-zinc-800/60 pt-2 first:border-t-0 first:pt-0"
                              >
                                <a
                                  href={s.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-xs font-medium text-emerald-400 hover:underline"
                                >
                                  {s.title}
                                </a>
                                <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-zinc-500">
                                  <span>{s.domain}</span>
                                  {s.published && (
                                    <>
                                      <span>·</span>
                                      <span>{s.published}</span>
                                    </>
                                  )}
                                </div>
                                {s.snippet && (
                                  <p className="mt-1 text-[11px] leading-snug text-zinc-400">
                                    {s.snippet}
                                  </p>
                                )}
                              </li>
                            ))}
                          </ul>
                        </details>
                      </>
                    )}

                    {/* Latency */}
                    <span className="mt-auto text-[10px] text-zinc-600">
                      {formatLatency(arm.latency_ms)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Empty state */}
        {!loading && !run && !error && (
          <div className="flex flex-1 items-center justify-center py-24 text-sm text-zinc-600">
            Enter a query and hit Run to compare retrieval providers.
          </div>
        )}
      </main>
    </div>
  );
}
