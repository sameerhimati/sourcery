"use client";

import { useMemo, useState } from "react";
import type { Arm, Axis, Extraction, Freshness, Run, Source } from "@core/types";
import type { BatchRow, HeatRow } from "@core/batch";
import {
  ageDays,
  ageLabel,
  freshDot,
  heatBadge,
  heatColor,
  heatText,
  medLabel,
  median,
  providerMeta,
  scoreText,
} from "@/lib/viz";
import {
  CONTROL_STAGES,
  EXTRACTION_OPTIONS,
  FRESHNESS_OPTIONS,
  MODEL,
  MODEL_OPTIONS,
  NUM_SOURCES,
} from "@core/controls";
import heatmapData from "@/lib/heatmap-data.json";
import batchData from "@/lib/batch-rows.json";

const HEATMAP = heatmapData.heatmap as HeatRow[];
const RUNS_PER_CELL = heatmapData.runs_per_cell as number;
const BATCH_ROWS = batchData.rows as BatchRow[];

// ─── palette (warm paper) ───
const C = {
  page: "#e9e5dc",
  text: "#26231d",
  surface: "#fbfaf7",
  surface2: "#f4f1ea",
  border: "#d8d2c5",
  border2: "#ded8cb",
  muted: "#8a8375",
  muted2: "#9b9385",
  faint: "#6f6858",
};
const MONO = "var(--font-ibm-plex-mono), monospace";
const WIN_GREEN = "oklch(0.42 0.12 155)";

// ─── enriched per-arm view model ───
interface SourceView extends Source {
  age: number | null;
  ageStr: string;
  dot: string;
}
interface ArmView {
  arm: Arm;
  label: string;
  color: string;
  isWinner: boolean;
  sources: SourceView[];
  medianDays: number | null;
  medianStr: string;
}

function enrichArm(arm: Arm, winner: string | null, now: number): ArmView {
  const { label, color } = providerMeta(arm.provider);
  const withAge = arm.sources.map((s) => {
    const age = ageDays(s.published, now);
    return { ...s, age, ageStr: ageLabel(age), dot: freshDot(age) };
  });
  // dated sources ascending by age, undated last
  const sorted = [...withAge].sort((a, b) => {
    if (a.age === null) return 1;
    if (b.age === null) return -1;
    return a.age - b.age;
  });
  const knownAges = withAge.map((s) => s.age).filter((d): d is number => d !== null);
  const medianDays = median(knownAges);
  return {
    arm,
    label,
    color,
    isWinner: winner === arm.id,
    sources: sorted,
    medianDays,
    medianStr: medLabel(medianDays),
  };
}

export default function Home() {
  const [view, setView] = useState<"compare" | "heatmap" | "controls">("compare");
  const [query, setQuery] = useState(
    "What is the most recent Claude model released by Anthropic, and what are its key capabilities?",
  );
  const [axis, setAxis] = useState<Extract<Axis, "provider" | "freshness">>("provider");
  const [loading, setLoading] = useState(false);
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  // ─── knobs (Controls tab) — the held-constant setup, now adjustable per run ───
  const [model, setModel] = useState<string>(MODEL);
  const [numSources, setNumSources] = useState<number>(NUM_SOURCES.default);
  const [freshness, setFreshness] = useState<Freshness>("all");
  const [extraction, setExtraction] = useState<Extraction>("clean");

  // Captured once at mount so age/freshness math stays stable across re-renders
  // (Date.now() during render is impure). Good enough — a session is short-lived.
  const [now] = useState(() => Date.now());

  async function handleRun() {
    if (!query.trim() || loading) return;
    setLoading(true);
    setError(null);
    setExpanded({});
    try {
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query,
          variable: axis,
          model,
          num_sources: numSources,
          freshness,
          extraction,
        }),
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

  const armViews = useMemo(
    () => (run ? run.arms.map((a) => enrichArm(a, run.winner, now)) : []),
    [run, now],
  );

  // ─── verdict (client-side, robust) ───
  const verdict = useMemo(() => {
    if (!run || !armViews.length) return null;
    if (run.winner === null) {
      return { failed: true as const };
    }
    const w = armViews.find((v) => v.isWinner);
    if (!w) return null;
    const others = armViews.filter((v) => !v.isWinner && !v.arm.error);
    const runnerUp = others.length
      ? others.reduce((b, v) => (v.arm.retrieval_score > b.arm.retrieval_score ? v : b))
      : null;
    const margin = runnerUp
      ? (w.arm.retrieval_score - runnerUp.arm.retrieval_score).toFixed(1)
      : w.arm.retrieval_score.toFixed(1);
    const bothDated = runnerUp && w.medianDays !== null && runnerUp.medianDays !== null;
    const reason = bothDated
      ? `${w.label} won on sourcing freshness — median source age ${w.medianStr} vs ${runnerUp!.medianStr}.`
      : `${w.label} won on retrieval quality — +${margin} retrieval score over the field.`;
    return {
      failed: false as const,
      name: w.label,
      color: w.color,
      margin: `+${margin}`,
      reason,
      rationale: w.arm.retrieval_rationale,
    };
  }, [run, armViews]);

  // Live run plan — updates as axis/knobs change, so the controls feel wired up.
  const planLine =
    axis === "provider"
      ? `arms: bright_data vs firecrawl · model ${model} · ${freshness} · ${numSources} src · ${extraction}`
      : `arms: freshness 24h vs all · provider bright_data · model ${model} · ${numSources} src · ${extraction}`;
  const metaLine = run
    ? `${run.arms
        .map((a) => `${a.provider} (${a.config.freshness})`)
        .join(" vs ")} · model ${run.arms[0]?.model ?? model} · retrieval judged 0–10 by AI`
    : planLine;

  const columnCount = run?.arms.length ?? (loading ? 2 : 2);

  return (
    <div style={{ minHeight: "100vh", background: C.page, color: C.text, padding: "26px 30px 70px", fontFamily: "var(--font-space-grotesk), sans-serif" }}>
      <div style={{ maxWidth: 1120, margin: "0 auto" }}>
        {/* ─── header ─── */}
        <header style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", paddingBottom: 22, marginBottom: 26, borderBottom: `1px solid ${C.border}` }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ width: 16, height: 16, borderRadius: 4, background: "linear-gradient(135deg,oklch(0.55 0.14 250),oklch(0.62 0.16 50))", boxShadow: "0 2px 8px oklch(0.55 0.14 250 / 0.3)" }} />
              <span style={{ fontSize: 20, fontWeight: 600, letterSpacing: "-0.02em", color: "#1c1a15" }}>Sourcery</span>
            </div>
            <span style={{ fontSize: 13, color: C.muted, letterSpacing: "0.01em" }}>Evals for the retrieval layer, not the model</span>
          </div>
          <div style={{ display: "flex", gap: 3, background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 10, padding: 3 }}>
            <TabButton active={view === "compare"} onClick={() => setView("compare")}>Comparison</TabButton>
            <TabButton active={view === "heatmap"} onClick={() => setView("heatmap")}>Scorecard</TabButton>
            <TabButton active={view === "controls"} onClick={() => setView("controls")}>Controls</TabButton>
          </div>
        </header>

        {view === "compare" ? (
          <>
            {/* ─── query bar ─── */}
            <div style={{ marginBottom: 20 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 11, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: "0 15px", height: 48, boxShadow: "0 1px 2px rgba(60,50,30,0.04)" }}>
                  <span style={{ fontFamily: MONO, fontSize: 15, color: "oklch(0.55 0.14 250)" }}>&gt;</span>
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") handleRun(); }}
                    placeholder="Ask a question to benchmark"
                    style={{ flex: 1, minWidth: 0, background: "transparent", border: "none", color: C.text, fontSize: 15, outline: "none", fontFamily: "inherit" }}
                  />
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                  <span style={{ fontSize: 12, color: C.muted }}>vary</span>
                  <div style={{ display: "flex", gap: 3, background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 9, padding: 3 }}>
                    <PillButton active={axis === "provider"} onClick={() => setAxis("provider")}>Provider</PillButton>
                    <PillButton active={axis === "freshness"} onClick={() => setAxis("freshness")}>Freshness</PillButton>
                  </div>
                </div>
                <button
                  onClick={handleRun}
                  disabled={loading || !query.trim()}
                  style={{ height: 48, padding: "0 24px", background: loading ? "#e4dfd4" : "#26231d", border: `1px solid ${loading ? C.border : "#26231d"}`, borderRadius: 10, color: loading ? C.muted2 : "#f4f1ea", fontSize: 14, fontWeight: 600, cursor: loading || !query.trim() ? "not-allowed" : "pointer", whiteSpace: "nowrap", boxShadow: "0 1px 2px rgba(60,50,30,0.12)", fontFamily: "inherit" }}
                >
                  {loading ? "⋯ Running" : "Run"}
                </button>
              </div>
              <div style={{ marginTop: 11, fontFamily: MONO, fontSize: 11.5, color: C.muted2, letterSpacing: "0.01em" }}>{metaLine}</div>
            </div>

            {/* ─── error banner ─── */}
            {error && (
              <div style={{ background: "oklch(0.72 0.13 28 / 0.12)", border: "1px solid oklch(0.6 0.16 28 / 0.35)", borderRadius: 12, padding: "14px 18px", marginBottom: 20, fontSize: 14, color: "oklch(0.42 0.16 28)" }}>
                Run failed: {error}
              </div>
            )}

            {/* ─── verdict ─── */}
            {!loading && verdict && (
              verdict.failed ? (
                <div style={{ background: "oklch(0.72 0.13 28 / 0.1)", border: "1px solid oklch(0.6 0.16 28 / 0.3)", borderLeft: "3px solid oklch(0.58 0.16 28)", borderRadius: 12, padding: "16px 20px", marginBottom: 20, fontSize: 14, color: "oklch(0.4 0.14 28)" }}>
                  <span style={{ fontFamily: MONO, fontSize: 10.5, letterSpacing: "0.14em", display: "block", marginBottom: 6 }}>VERDICT</span>
                  Every arm failed to retrieve — no winner. Check provider keys/quotas and retry.
                </div>
              ) : (
                <div style={{ display: "flex", alignItems: "stretch", gap: 22, background: "oklch(0.72 0.13 155 / 0.1)", border: "1px solid oklch(0.6 0.13 155 / 0.28)", borderLeft: "3px solid oklch(0.58 0.14 155)", borderRadius: 12, padding: "16px 20px", marginBottom: 20 }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, justifyContent: "center", minWidth: 210 }}>
                    <span style={{ fontFamily: MONO, fontSize: 10.5, letterSpacing: "0.14em", color: "oklch(0.5 0.1 155)" }}>VERDICT</span>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                      <span style={{ width: 9, height: 9, borderRadius: 2, background: verdict.color, alignSelf: "center" }} />
                      <span style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-0.01em", color: verdict.color }}>{verdict.name}</span>
                      <span style={{ fontFamily: MONO, fontSize: 13, fontWeight: 600, color: "oklch(0.45 0.13 155)", background: "oklch(0.7 0.13 155 / 0.2)", padding: "2px 8px", borderRadius: 6 }}>{verdict.margin}</span>
                    </div>
                  </div>
                  <div style={{ width: 1, background: C.border }} />
                  <div style={{ display: "flex", flexDirection: "column", gap: 5, justifyContent: "center", flex: 1 }}>
                    <span style={{ fontSize: 14, color: "#3a362d", lineHeight: 1.45 }}>{verdict.reason}</span>
                    <span style={{ fontSize: 12.5, color: C.muted, lineHeight: 1.4 }}>{verdict.rationale}</span>
                  </div>
                </div>
              )
            )}

            {/* ─── arm grid ─── */}
            <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.max(columnCount, 1)}, minmax(0, 1fr))`, gap: 18, alignItems: "stretch" }}>
              {loading
                ? Array.from({ length: columnCount }).map((_, i) => <SkeletonCard key={i} />)
                : armViews.map((v) => (
                    <ArmCard
                      key={v.arm.id}
                      view={v}
                      expanded={!!expanded[v.arm.id]}
                      onToggle={() => setExpanded((s) => ({ ...s, [v.arm.id]: !s[v.arm.id] }))}
                    />
                  ))}
            </div>

            {!loading && !run && !error && (
              <div style={{ display: "flex", justifyContent: "center", padding: "80px 0", fontSize: 14, color: C.muted }}>
                Enter a time-sensitive query and hit Run to benchmark the retrieval layer.
              </div>
            )}
          </>
        ) : view === "heatmap" ? (
          <Scorecard />
        ) : (
          <Controls
            model={model}
            setModel={setModel}
            numSources={numSources}
            setNumSources={setNumSources}
            freshness={freshness}
            setFreshness={setFreshness}
            extraction={extraction}
            setExtraction={setExtraction}
            onRun={() => { setView("compare"); handleRun(); }}
          />
        )}
      </div>
    </div>
  );
}

// ─── small controls ───
function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{ padding: "8px 16px", border: "none", borderRadius: 7, cursor: "pointer", fontSize: 13, fontWeight: 500, background: active ? "#ffffff" : "transparent", color: active ? "#1c1a15" : C.muted, transition: "all .15s", fontFamily: "inherit" }}>
      {children}
    </button>
  );
}
function PillButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{ padding: "8px 13px", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 12.5, background: active ? "#ffffff" : "transparent", color: active ? "#1c1a15" : C.muted, fontFamily: "inherit" }}>
      {children}
    </button>
  );
}

// ─── arm card ───
function ArmCard({ view, expanded, onToggle }: { view: ArmView; expanded: boolean; onToggle: () => void }) {
  const { arm, label, color, isWinner } = view;
  const failed = !!arm.error;
  const colBorder = isWinner ? "1px solid oklch(0.62 0.13 155 / 0.5)" : `1px solid ${C.border2}`;
  const colShadow = isWinner
    ? "0 0 0 1px oklch(0.62 0.13 155 / 0.28), 0 6px 26px oklch(0.6 0.13 155 / 0.12)"
    : "0 1px 3px rgba(60,50,30,0.05)";

  return (
    <div style={{ position: "relative", display: "flex", flexDirection: "column", background: isWinner ? "#fbfbf6" : C.surface, borderRadius: 13, border: colBorder, boxShadow: colShadow, animation: "scRise .35s ease both" }}>
      {/* header */}
      <div style={{ padding: "20px 22px 16px" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
              <span style={{ width: 9, height: 9, borderRadius: 2, background: color }} />
              <span style={{ fontSize: 17, fontWeight: 600, letterSpacing: "-0.01em", color }}>{label}</span>
              {isWinner && !failed && (
                <span style={{ fontSize: 11, fontWeight: 500, color: WIN_GREEN, background: "oklch(0.72 0.13 155 / 0.16)", border: "1px solid oklch(0.6 0.13 155 / 0.35)", padding: "2px 8px", borderRadius: 20 }}>Winner</span>
              )}
            </div>
            <span style={{ fontFamily: MONO, fontSize: 11.5, color: C.muted2, letterSpacing: "0.01em" }}>
              {arm.model} · {arm.config.freshness} · {arm.config.extraction} · {arm.config.num_sources} src · {(arm.latency_ms / 1000).toFixed(2)}s
            </span>
          </div>
          {!failed && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 3 }}>
                <span style={{ fontFamily: MONO, fontSize: 34, fontWeight: 600, lineHeight: 1, color: scoreText(arm.retrieval_score) }}>{arm.retrieval_score.toFixed(1)}</span>
                <span style={{ fontFamily: MONO, fontSize: 12, color: C.muted2 }}>/10</span>
              </div>
              <div style={{ width: 66, height: 3, borderRadius: 2, background: "#e4dfd4", overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${(arm.retrieval_score / 10) * 100}%`, background: scoreText(arm.retrieval_score), borderRadius: 2 }} />
              </div>
              <span style={{ fontFamily: MONO, fontSize: 10.5, color: C.muted2 }}>retrieval score</span>
            </div>
          )}
        </div>

        {failed ? (
          <div style={{ margin: "14px 0 0", background: "oklch(0.72 0.13 28 / 0.1)", border: "1px solid oklch(0.6 0.16 28 / 0.3)", borderRadius: 9, padding: "12px 14px", fontSize: 13, color: "oklch(0.42 0.16 28)" }}>
            <strong style={{ fontWeight: 600 }}>Arm failed.</strong> {arm.error}
          </div>
        ) : (
          <>
            <p style={{ margin: "14px 0 0", fontSize: 13, color: C.faint, lineHeight: 1.5, borderLeft: `2px solid ${C.border2}`, paddingLeft: 11 }}>{arm.retrieval_rationale}</p>
            <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 8, fontFamily: MONO, fontSize: 11.5, color: C.muted2 }}>
              <span style={{ color: C.muted }}>answer judge</span>
              <span style={{ color: scoreText(arm.score), fontWeight: 600 }}>{arm.score.toFixed(1)}/10</span>
              <span style={{ color: "#c3bba7" }}>(secondary)</span>
            </div>
          </>
        )}
      </div>

      {!failed && (
        <>
          <div style={{ padding: "0 22px 18px" }}>
            <p style={{ fontSize: 14, lineHeight: 1.62, color: "#3a362d", margin: 0 }}>{arm.answer}</p>
          </div>

          {/* sources */}
          <div style={{ padding: "0 22px 22px", marginTop: "auto" }}>
            <button onClick={onToggle} style={{ display: "flex", alignItems: "center", gap: 14, width: "100%", padding: "13px 15px", background: "#f6f3ec", border: `1px solid ${C.border2}`, borderRadius: 10, cursor: "pointer", color: C.text, fontFamily: "inherit" }}>
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontFamily: MONO, fontSize: 11, color: C.muted2, width: 9 }}>{expanded ? "▾" : "▸"}</span>
                <span style={{ fontSize: 13.5, fontWeight: 500 }}>Sources</span>
                <span style={{ fontFamily: MONO, fontSize: 12, color: C.muted2 }}>{view.sources.length}</span>
              </span>
              <span style={{ display: "flex", alignItems: "center", gap: 4, flex: 1 }}>
                {view.sources.map((s, i) => (
                  <span key={i} style={{ width: 7, height: 7, borderRadius: "50%", background: s.dot }} />
                ))}
              </span>
              <span style={{ fontFamily: MONO, fontSize: 11, color: C.muted, whiteSpace: "nowrap" }}>median {view.medianStr}</span>
            </button>
            {expanded && (
              <div style={{ border: `1px solid ${C.border2}`, borderRadius: 10, overflow: "hidden", marginTop: 8, background: C.surface, animation: "scRise .25s ease both" }}>
                {view.sources.map((s, i) => (
                  <SourceRow key={i} src={s} color={color} />
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function SourceRow({ src, color }: { src: SourceView; color: string }) {
  const [showContent, setShowContent] = useState(false);
  const hasContent = !!src.content;
  return (
    <div style={{ borderBottom: "1px solid #eee9df" }}>
      <div style={{ display: "flex", gap: 12, padding: "12px 15px" }}>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: src.dot, marginTop: 5, flexShrink: 0 }} />
        <span style={{ display: "flex", flexDirection: "column", gap: 5, minWidth: 0, flex: 1 }}>
          <a href={src.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13, color: C.text, lineHeight: 1.35 }}>{src.title}</a>
          <span style={{ display: "flex", gap: 12, fontFamily: MONO, fontSize: 11, flexWrap: "wrap" }}>
            <span style={{ color }}>{src.domain}</span>
            <span style={{ color: C.muted2 }}>{src.published ?? "undated"}</span>
            <span style={{ color: src.dot }}>{src.ageStr}</span>
            {hasContent && (
              <button onClick={() => setShowContent((v) => !v)} style={{ border: "none", background: "transparent", cursor: "pointer", fontFamily: MONO, fontSize: 11, color: "oklch(0.5 0.14 250)", padding: 0 }}>
                {showContent ? "hide extracted ▾" : "view extracted ▸"}
              </button>
            )}
          </span>
          {hasContent && showContent && (
            <pre style={{ margin: "4px 0 2px", padding: "10px 12px", background: C.surface2, border: `1px solid ${C.border2}`, borderRadius: 8, fontFamily: MONO, fontSize: 11, lineHeight: 1.5, color: C.faint, whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 220, overflow: "auto" }}>
              {src.content}
            </pre>
          )}
        </span>
        <a href={src.url} target="_blank" rel="noopener noreferrer" style={{ fontFamily: MONO, fontSize: 12, color: "#b8b0a0", alignSelf: "center" }}>↗</a>
      </div>
    </div>
  );
}

function SkeletonCard() {
  const pulse = { animation: "scPulse 1.2s ease-in-out infinite" } as const;
  return (
    <div style={{ background: C.surface, borderRadius: 13, border: `1px solid ${C.border2}`, boxShadow: "0 1px 3px rgba(60,50,30,0.05)" }}>
      <div style={{ padding: 22, display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <div style={{ height: 20, width: 130, borderRadius: 6, background: "#e4dfd4", ...pulse }} />
          <div style={{ height: 34, width: 52, borderRadius: 6, background: "#e4dfd4", ...pulse }} />
        </div>
        <div style={{ height: 12, width: "100%", borderRadius: 4, background: "#ece7dc", ...pulse }} />
        <div style={{ height: 12, width: "94%", borderRadius: 4, background: "#ece7dc", ...pulse }} />
        <div style={{ height: 12, width: "80%", borderRadius: 4, background: "#ece7dc", ...pulse }} />
        <div style={{ height: 44, width: "100%", borderRadius: 9, background: "#ece7dc", marginTop: 8, ...pulse }} />
        <div style={{ fontFamily: MONO, fontSize: 11, color: "#a8a294" }}>fetching · extracting · grading…</div>
      </div>
    </div>
  );
}

// ─── Scorecard (heatmap + per-query table) ───
interface QueryPivot {
  queryId: string;
  type: string;
  query: string;
  bd: number | null;
  fc: number | null;
  bdRow?: BatchRow;
  fcRow?: BatchRow;
}

function Scorecard() {
  const [sortKey, setSortKey] = useState<"type" | "bd" | "fc" | "delta">("type");

  const hasData = BATCH_ROWS.length > 0 && HEATMAP.some((h) => h.runs > 0);

  const bdVals = HEATMAP.map((r) => r.bright_data);
  const fcVals = HEATMAP.map((r) => r.firecrawl);
  const avg = (a: number[]) => (a.length ? (a.reduce((s, x) => s + x, 0) / a.length).toFixed(2) : "0.00");
  const bdWins = HEATMAP.filter((r) => r.bright_data > r.firecrawl).length;
  const fcWins = HEATMAP.filter((r) => r.firecrawl > r.bright_data).length;

  // pivot raw rows → one row per query with both providers' scores
  const pivots = useMemo<QueryPivot[]>(() => {
    const byQuery = new Map<string, QueryPivot>();
    for (const r of BATCH_ROWS) {
      let p = byQuery.get(r.queryId);
      if (!p) {
        p = { queryId: r.queryId, type: r.type, query: r.query, bd: null, fc: null };
        byQuery.set(r.queryId, p);
      }
      if (r.provider === "bright_data") { p.bd = r.error ? null : r.retrieval_score; p.bdRow = r; }
      else { p.fc = r.error ? null : r.retrieval_score; p.fcRow = r; }
    }
    const arr = [...byQuery.values()];
    const delta = (p: QueryPivot) => Math.abs((p.bd ?? 0) - (p.fc ?? 0));
    arr.sort((a, b) => {
      if (sortKey === "type") return a.type.localeCompare(b.type) || a.queryId.localeCompare(b.queryId);
      if (sortKey === "bd") return (b.bd ?? -1) - (a.bd ?? -1);
      if (sortKey === "fc") return (b.fc ?? -1) - (a.fc ?? -1);
      return delta(b) - delta(a);
    });
    return arr;
  }, [sortKey]);

  return (
    <div>
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 16, fontWeight: 600, color: "#1c1a15", marginBottom: 5 }}>Win / loss scorecard</div>
        <div style={{ fontSize: 13, color: C.muted }}>Average retrieval score by query type. Neither provider wins everything — that&apos;s the point.</div>
      </div>

      {!hasData && (
        <div style={{ background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 10, padding: "14px 18px", marginBottom: 20, fontSize: 13, color: C.faint, fontFamily: MONO }}>
          No batch data yet — run <span style={{ color: "oklch(0.5 0.14 250)" }}>POST /api/batch?perType=2</span> to populate the scorecard.
        </div>
      )}

      {/* heatmap */}
      <div style={{ display: "flex", flexDirection: "column", border: `1px solid ${C.border}`, borderRadius: 13, overflow: "hidden", maxWidth: 760, background: C.surface, boxShadow: "0 1px 3px rgba(60,50,30,0.05)" }}>
        <div style={{ display: "grid", gridTemplateColumns: "216px 1fr 1fr" }}>
          <div style={{ padding: "15px 18px", background: C.surface2, fontFamily: MONO, fontSize: 10.5, color: C.muted2, letterSpacing: "0.03em", display: "flex", alignItems: "center" }}>query type ↓</div>
          <HeatHeader color="oklch(0.55 0.14 250)" textColor="oklch(0.5 0.14 250)" label="Bright Data" />
          <HeatHeader color="oklch(0.62 0.16 50)" textColor="oklch(0.55 0.16 50)" label="Firecrawl" />
        </div>
        {HEATMAP.map((row) => {
          const bd = row.bright_data, fc = row.firecrawl;
          const delta = Math.abs(bd - fc).toFixed(1);
          return (
            <div key={row.type} style={{ display: "grid", gridTemplateColumns: "216px 1fr 1fr", borderTop: "1px solid #eee9df" }}>
              <div style={{ padding: "22px 18px", display: "flex", alignItems: "center", fontSize: 13.5, color: "#3a362d", background: "#f8f5ee" }}>{row.label}</div>
              <HeatCell score={bd} win={bd > fc} delta={delta} />
              <HeatCell score={fc} win={fc > bd} delta={delta} />
            </div>
          );
        })}
        <div style={{ display: "grid", gridTemplateColumns: "216px 1fr 1fr", borderTop: `1px solid ${C.border}` }}>
          <div style={{ padding: "15px 18px", display: "flex", alignItems: "center", fontFamily: MONO, fontSize: 11, color: C.muted2, background: C.surface2, letterSpacing: "0.03em" }}>avg · wins</div>
          <HeatFooterCell avg={avg(bdVals)} wins={bdWins} color="oklch(0.5 0.14 250)" />
          <HeatFooterCell avg={avg(fcVals)} wins={fcWins} color="oklch(0.55 0.16 50)" />
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 11, marginTop: 16, fontFamily: MONO, fontSize: 11, color: C.muted2 }}>
        <span>lower</span>
        <div style={{ height: 8, width: 190, borderRadius: 4, background: "linear-gradient(90deg,oklch(0.72 0.13 28),oklch(0.93 0.03 90),oklch(0.78 0.15 150))" }} />
        <span>higher</span>
        <span style={{ marginLeft: 10 }}>avg retrieval score · {RUNS_PER_CELL} run{RUNS_PER_CELL === 1 ? "" : "s"} per cell</span>
      </div>

      {/* per-query table */}
      {pivots.length > 0 && (
        <div style={{ marginTop: 40 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: "#1c1a15", marginBottom: 5 }}>Per-query drill-down</div>
          <div style={{ fontSize: 12.5, color: C.muted, marginBottom: 14 }}>Every query, each provider&apos;s retrieval score and the winner. Sort by any column.</div>
          <div style={{ border: `1px solid ${C.border}`, borderRadius: 13, overflow: "hidden", background: C.surface, boxShadow: "0 1px 3px rgba(60,50,30,0.05)" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 130px 110px 110px 90px", background: C.surface2, fontFamily: MONO, fontSize: 10.5, color: C.muted2, letterSpacing: "0.03em" }}>
              <ColHead onClick={() => setSortKey("type")} active={sortKey === "type"}>query · type ↓</ColHead>
              <ColHead onClick={() => setSortKey("type")} active={false} center>type</ColHead>
              <ColHead onClick={() => setSortKey("bd")} active={sortKey === "bd"} center>Bright Data</ColHead>
              <ColHead onClick={() => setSortKey("fc")} active={sortKey === "fc"} center>Firecrawl</ColHead>
              <ColHead onClick={() => setSortKey("delta")} active={sortKey === "delta"} center>winner</ColHead>
            </div>
            {pivots.map((p) => {
              const bdWin = (p.bd ?? -1) > (p.fc ?? -1);
              const fcWin = (p.fc ?? -1) > (p.bd ?? -1);
              const d = Math.abs((p.bd ?? 0) - (p.fc ?? 0)).toFixed(1);
              return (
                <div key={p.queryId} style={{ display: "grid", gridTemplateColumns: "1fr 130px 110px 110px 90px", borderTop: "1px solid #eee9df", alignItems: "center" }}>
                  <div style={{ padding: "12px 16px", fontSize: 13, color: "#3a362d", lineHeight: 1.4 }}>{p.query}</div>
                  <div style={{ padding: "12px 10px", textAlign: "center", fontFamily: MONO, fontSize: 11, color: C.muted2 }}>{p.type.replace(/_/g, " ")}</div>
                  <ScoreCell score={p.bd} win={bdWin} />
                  <ScoreCell score={p.fc} win={fcWin} />
                  <div style={{ padding: "12px 10px", textAlign: "center", fontFamily: MONO, fontSize: 11.5 }}>
                    {p.bd === null && p.fc === null ? (
                      <span style={{ color: "oklch(0.55 0.16 28)" }}>—</span>
                    ) : (
                      <span style={{ color: bdWin ? "oklch(0.5 0.14 250)" : fcWin ? "oklch(0.55 0.16 50)" : C.muted2, fontWeight: 600 }}>
                        {bdWin ? "BD" : fcWin ? "FC" : "tie"} {bdWin || fcWin ? `+${d}` : ""}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function HeatHeader({ color, textColor, label }: { color: string; textColor: string; label: string }) {
  return (
    <div style={{ padding: "15px 18px", background: C.surface2, display: "flex", alignItems: "center", gap: 8, borderLeft: "1px solid #eee9df" }}>
      <span style={{ width: 8, height: 8, borderRadius: 2, background: color }} />
      <span style={{ fontSize: 14, fontWeight: 600, color: textColor }}>{label}</span>
    </div>
  );
}
function HeatCell({ score, win, delta }: { score: number; win: boolean; delta: string }) {
  return (
    <div style={{ padding: "20px 18px", background: heatColor(score), borderLeft: "1px solid #fbfaf7", boxShadow: win ? "inset 0 0 0 2px oklch(0.45 0.13 155 / 0.55)" : "none", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
      <span style={{ fontFamily: MONO, fontSize: 25, fontWeight: 600, color: heatText() }}>{score.toFixed(1)}</span>
      {win && (
        <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 600, color: "#fff", background: heatBadge(score), padding: "3px 8px", borderRadius: 6 }}>▲ {delta}</span>
      )}
    </div>
  );
}
function HeatFooterCell({ avg, wins, color }: { avg: string; wins: number; color: string }) {
  return (
    <div style={{ padding: "15px 18px", background: C.surface2, borderLeft: "1px solid #eee9df", display: "flex", alignItems: "baseline", gap: 10 }}>
      <span style={{ fontFamily: MONO, fontSize: 16, fontWeight: 600, color }}>{avg}</span>
      <span style={{ fontFamily: MONO, fontSize: 12, color: C.muted }}>{wins} wins</span>
    </div>
  );
}
function ColHead({ onClick, active, center, children }: { onClick: () => void; active: boolean; center?: boolean; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{ padding: "13px 16px", border: "none", background: "transparent", cursor: "pointer", fontFamily: MONO, fontSize: 10.5, letterSpacing: "0.03em", color: active ? "#1c1a15" : C.muted2, textAlign: center ? "center" : "left", fontWeight: active ? 600 : 400 }}>
      {children}
    </button>
  );
}
function ScoreCell({ score, win }: { score: number | null; win: boolean }) {
  return (
    <div style={{ padding: "12px 10px", textAlign: "center", fontFamily: MONO, fontSize: 15, fontWeight: 600, color: score === null ? "oklch(0.55 0.16 28)" : scoreText(score), background: win ? "oklch(0.72 0.13 155 / 0.1)" : "transparent" }}>
      {score === null ? "err" : score.toFixed(1)}
    </div>
  );
}

// ─── Controls (interactive knobs + held-constant prompts) ───
interface ControlsProps {
  model: string;
  setModel: (m: string) => void;
  numSources: number;
  setNumSources: (n: number) => void;
  freshness: Freshness;
  setFreshness: (f: Freshness) => void;
  extraction: Extraction;
  setExtraction: (e: Extraction) => void;
  onRun: () => void;
}

const ROLE_STYLE: Record<string, { bg: string; color: string; label: string }> = {
  primary: { bg: "oklch(0.72 0.13 155 / 0.16)", color: "oklch(0.42 0.12 155)", label: "PRIMARY · winner metric" },
  secondary: { bg: "oklch(0.72 0.13 75 / 0.18)", color: "oklch(0.45 0.12 75)", label: "SECONDARY" },
  shared: { bg: "oklch(0.6 0.02 250 / 0.14)", color: "#6f6858", label: "SHARED STEP" },
};

function Controls(p: ControlsProps) {
  return (
    <div>
      {/* ── knobs ── */}
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 16, fontWeight: 600, color: "#1c1a15", marginBottom: 5 }}>Retrieval controls</div>
        <div style={{ fontSize: 13, color: C.muted }}>The knobs. Change them, then run — everything below the line is held constant across both arms.</div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 14, marginBottom: 18 }}>
        <KnobCard label="Model" hint="answer + both judges, every arm">
          <SelectKnob value={p.model} onChange={p.setModel} options={MODEL_OPTIONS.map((m) => ({ value: m, label: m }))} />
        </KnobCard>

        <KnobCard label="Sources per arm" hint={`${NUM_SOURCES.min}–${NUM_SOURCES.max} discovered & extracted`}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <input
              type="range"
              min={NUM_SOURCES.min}
              max={NUM_SOURCES.max}
              value={p.numSources}
              onChange={(e) => p.setNumSources(Number(e.target.value))}
              style={{ flex: 1, accentColor: "oklch(0.5 0.14 250)" }}
            />
            <span style={{ fontFamily: MONO, fontSize: 18, fontWeight: 600, color: "#1c1a15", width: 26, textAlign: "right" }}>{p.numSources}</span>
          </div>
        </KnobCard>

        <KnobCard label="Freshness" hint="held for both arms unless you vary Freshness">
          <SelectKnob value={p.freshness} onChange={(v) => p.setFreshness(v as Freshness)} options={FRESHNESS_OPTIONS} />
        </KnobCard>

        <KnobCard label="Extraction" hint="fetch full pages vs snippets only">
          <div style={{ display: "flex", gap: 3, background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 9, padding: 3 }}>
            {EXTRACTION_OPTIONS.map((o) => (
              <button
                key={o.value}
                onClick={() => p.setExtraction(o.value)}
                style={{ flex: 1, padding: "8px 10px", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 12, background: p.extraction === o.value ? "#ffffff" : "transparent", color: p.extraction === o.value ? "#1c1a15" : C.muted, fontFamily: "inherit", fontWeight: p.extraction === o.value ? 600 : 400 }}
              >
                {o.value}
              </button>
            ))}
          </div>
        </KnobCard>
      </div>

      <button
        onClick={p.onRun}
        style={{ height: 44, padding: "0 22px", background: "#26231d", border: "1px solid #26231d", borderRadius: 10, color: "#f4f1ea", fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", boxShadow: "0 1px 2px rgba(60,50,30,0.12)" }}
      >
        Run with these settings →
      </button>

      {/* ── held constant ── */}
      <div style={{ borderTop: `1px solid ${C.border}`, margin: "34px 0 22px", paddingTop: 26 }}>
        <div style={{ fontSize: 16, fontWeight: 600, color: "#1c1a15", marginBottom: 5 }}>Held constant</div>
        <div style={{ fontSize: 13, color: C.muted }}>Same model, prompts, and grading for every arm — so any score difference traces to retrieval, nothing else. This is exactly what runs.</div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {CONTROL_STAGES.map((stage) => {
          const rs = ROLE_STYLE[stage.role];
          return (
            <div key={stage.id} style={{ background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 12, padding: "18px 20px", boxShadow: "0 1px 3px rgba(60,50,30,0.05)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 8 }}>
                <span style={{ fontSize: 15, fontWeight: 600, color: "#1c1a15" }}>{stage.title}</span>
                <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: "0.08em", fontWeight: 600, color: rs.color, background: rs.bg, padding: "3px 8px", borderRadius: 6 }}>{rs.label}</span>
                <span style={{ fontFamily: MONO, fontSize: 11, color: C.muted2, marginLeft: "auto" }}>temp {stage.temperature} · {stage.responseFormat}</span>
              </div>
              <p style={{ margin: "0 0 12px", fontSize: 13, color: C.faint, lineHeight: 1.5 }}>{stage.blurb}</p>
              <pre style={{ margin: 0, padding: "12px 14px", background: C.surface2, border: `1px solid ${C.border2}`, borderRadius: 8, fontFamily: MONO, fontSize: 11.5, lineHeight: 1.55, color: "#3a362d", whiteSpace: "pre-wrap", wordBreak: "break-word", overflow: "auto" }}>
                {stage.system}
              </pre>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function KnobCard({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 12, padding: "14px 16px", boxShadow: "0 1px 3px rgba(60,50,30,0.05)" }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: "#1c1a15", marginBottom: 2 }}>{label}</div>
      <div style={{ fontFamily: MONO, fontSize: 10.5, color: C.muted2, marginBottom: 12 }}>{hint}</div>
      {children}
    </div>
  );
}

function SelectKnob({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{ width: "100%", padding: "9px 11px", background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 8, fontFamily: MONO, fontSize: 13, color: "#1c1a15", cursor: "pointer" }}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}
