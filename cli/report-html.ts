import {
  PROVIDERS,
  SCORE_STEPS_DARK,
  SCORE_STEPS_LIGHT,
  median,
  providerMeta,
  scoreInkDark,
  scoreInkLight,
  scoreStep,
} from "@core/viz";
import { deriveHeatmap, providersIn, TYPE_LABELS } from "@core/batch";
import type { BatchRow } from "@core/batch";
import type { Arm, Source } from "@core/types";
import type { BatchRowRecord, RunRecord, SourceryRecord } from "./persist";

// Self-contained HTML report: inline CSS, no external requests, no JavaScript.
// A pure view over runs.jsonl (records in → HTML string out) so it snapshots in
// tests. Everything interactive is <details> or :hover, which is why it stays
// script-free and still works when opened as a file:// URL.

const esc = (s: string): string =>
  String(s ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!,
  );

/** Every field below comes from a JSON.parse cast with no schema check, so any
 *  of them can be absent on an older or hand-edited line. One bad record used to
 *  take the whole report down with a TypeError; now it degrades to a placeholder. */
const txt = (s: string | undefined | null): string => (typeof s === "string" ? s : "");

/** Sources are scraped SERP results, so their URLs are attacker-influenceable and
 *  land in an href in a file the user opens in a browser. `javascript:` and
 *  `data:` are live code there, and escaping does not disarm them. */
function safeHref(url: string | undefined): string | null {
  const raw = txt(url).trim();
  if (!/^https?:\/\//i.test(raw)) return null;
  return esc(raw);
}

const num = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

const scoreChip = (n: unknown): string =>
  num(n)
    ? `<span class="chip heat-${scoreStep(n)}">${n}</span>`
    : `<span class="chip chip-na">&mdash;</span>`;

const pct = (n: number): string => `${Math.max(0, Math.min(100, n * 10)).toFixed(1)}%`;

// ─── Aggregates ───

interface ProviderStat {
  provider: string;
  arms: number;
  fails: number;
  retrieval: number | null;
  answer: number | null;
  latency: number | null;
}

interface Summary {
  arms: number;
  fails: number;
  queries: number;
  latency: number | null;
  stats: ProviderStat[];
}

/** One flat row per arm, from both record shapes, so the tiles and the provider
 *  chart describe everything on file rather than only the latest batch. */
function flatten(records: SourceryRecord[]): {
  provider: string;
  query: string;
  retrieval: number | null;
  answer: number | null;
  latency: number | null;
  failed: boolean;
}[] {
  const out = [];
  for (const rec of records) {
    if (rec.mode === "batch") {
      const r = rec.row;
      out.push({
        provider: r.provider,
        query: txt(r.query),
        retrieval: num(r.retrieval_score) ? r.retrieval_score : null,
        answer: num(r.answer_score) ? r.answer_score : null,
        latency: num(r.latency_ms) ? r.latency_ms : null,
        failed: Boolean(r.error),
      });
    } else if (rec.mode === "run") {
      for (const a of rec.arms ?? []) {
        out.push({
          provider: a.provider,
          query: txt(rec.query),
          retrieval: num(a.retrieval_score) ? a.retrieval_score : null,
          answer: num(a.score) ? a.score : null,
          latency: num(a.latency_ms) ? a.latency_ms : null,
          failed: Boolean(a.error),
        });
      }
    }
  }
  return out;
}

function summarize(records: SourceryRecord[]): Summary {
  const rows = flatten(records);
  const mean = (xs: number[]): number | null =>
    xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null;

  const byProvider = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byProvider.get(r.provider) ?? [];
    list.push(r);
    byProvider.set(r.provider, list);
  }

  const stats: ProviderStat[] = [...byProvider.entries()]
    .map(([provider, rs]) => ({
      provider,
      arms: rs.length,
      fails: rs.filter((r) => r.failed).length,
      retrieval: mean(rs.map((r) => r.retrieval).filter(num)),
      answer: mean(rs.map((r) => r.answer).filter(num)),
      latency: median(rs.map((r) => r.latency).filter(num)),
    }))
    // Fixed order, so a provider keeps its row and its hue between reports.
    .sort((a, b) => providerOrder(a.provider) - providerOrder(b.provider));

  return {
    arms: rows.length,
    fails: rows.filter((r) => r.failed).length,
    queries: new Set(rows.map((r) => r.query)).size,
    latency: median(rows.map((r) => r.latency).filter(num)),
    stats,
  };
}

const PROVIDER_ORDER = Object.keys(PROVIDERS);
const providerOrder = (p: string): number => {
  const i = PROVIDER_ORDER.indexOf(p);
  return i === -1 ? PROVIDER_ORDER.length : i;
};

// ─── Sections ───

function statTiles(s: Summary): string {
  const failRate = s.arms ? ((s.fails / s.arms) * 100).toFixed(1) + "%" : "—";
  const lat = s.latency === null ? "—" : Math.round(s.latency / 1000) + "s";
  const tiles = [
    { v: String(s.arms), k: "results", sub: "one fetch → answer → judge each" },
    { v: String(s.queries), k: "queries", sub: "distinct questions asked" },
    { v: String(s.stats.length), k: "providers", sub: "retrieval backends compared" },
    { v: lat, k: "median latency", sub: "per call, end to end" },
    { v: failRate, k: "failure rate", sub: `${s.fails} of ${s.arms} returned nothing` },
  ];
  return `<section class="tiles" aria-label="Run summary">
    ${tiles
      .map(
        (t) => `<div class="tile">
        <div class="tile-v">${esc(t.v)}</div>
        <div class="tile-k">${esc(t.k)}</div>
        <div class="tile-s">${esc(t.sub)}</div>
      </div>`,
      )
      .join("")}
  </section>`;
}

/** The headline chart. Retrieval is the primary metric and carries the one hue;
 *  answer is secondary and stays neutral. That contrast is the point rather than
 *  decoration — where the two bars disagree, the answer model is working from
 *  memory instead of from what came back. */
function providerChart(s: Summary): string {
  if (!s.stats.length) return "";
  const rows = s.stats
    .map((st) => {
      const m = providerMeta(st.provider);
      const bar = (label: string, v: number | null, cls: string): string => {
        if (v === null) return `<div class="bar-line"><span class="bar-na">no data</span></div>`;
        return `<div class="bar-line">
            <div class="bar-track" role="img" aria-label="${esc(label)} ${v.toFixed(2)} out of 10">
              <div class="bar-fill ${cls}" style="width:${pct(v)}"></div>
            </div>
            <div class="bar-v">${v.toFixed(2)}</div>
          </div>`;
      };
      return `<div class="bar-group">
        <div class="bar-name"><span class="swatch" style="background:var(--p-${esc(st.provider)})"></span>${esc(m.label)}
          <span class="bar-n">${st.arms} result${st.arms === 1 ? "" : "s"}</span></div>
        <div class="bar-bars">
          ${bar("retrieval", st.retrieval, "f-ret")}
          ${bar("answer", st.answer, "f-ans")}
        </div>
      </div>`;
    })
    .join("");

  return `<section class="panel">
    <div class="panel-h">
      <h2>Retrieval vs answer quality</h2>
      <div class="legend">
        <span class="lg"><i class="sw f-ret"></i>retrieval</span>
        <span class="lg"><i class="sw f-ans"></i>answer</span>
      </div>
    </div>
    <p class="note">Both scored 0&ndash;10 on the same scale. Retrieval grades the sources that came
      back, answer grades the text written from them. Where a provider&rsquo;s two bars disagree, the
      answer is not coming from the retrieval.</p>
    <div class="bars">${rows}</div>
  </section>`;
}

function heatmapSection(rows: BatchRow[]): string {
  // deriveHeatmap is imported rather than reimplemented here. This file used to
  // carry its own copy, which had already drifted (it counted runs per cell
  // differently) and needed an `as unknown as Record<string, number>` cast to
  // read provider columns out of a type that named only two of them.
  const providers = providersIn(rows);
  const heat = deriveHeatmap(rows, providers);
  if (!heat.length) return "";

  const head = providers
    .map(
      (p) =>
        `<th><span class="swatch" style="background:var(--p-${esc(p)})"></span>${esc(providerMeta(p).label)}</th>`,
    )
    .join("");
  const body = heat
    .map((h) => {
      const cells = providers
        .map((p) => {
          const v = h.scores[p];
          if (!num(v)) return `<td class="cell cell-na" title="no data">&mdash;</td>`;
          return `<td class="cell heat-${scoreStep(v)}" title="${esc(h.label)} · ${esc(providerMeta(p).label)} · ${v.toFixed(2)} of 10">${v.toFixed(1)}</td>`;
        })
        .join("");
      return `<tr><th class="rowh">${esc(h.label)}</th>${cells}</tr>`;
    })
    .join("");

  const scale = SCORE_STEPS_LIGHT.map(
    (_, i) => `<i class="heat-${i}" title="${i} of 10"></i>`,
  ).join("");

  return `<section class="panel">
    <div class="panel-h"><h2>Retrieval score by query type</h2>
      <div class="scale"><span>0</span>${scale}<span>10</span></div>
    </div>
    <p class="note">Latest batch. Each cell averages the retrieval scores of every query of that type,
      so no single judge rationale belongs to a cell &mdash; those are listed per row below.</p>
    <div class="scroll"><table class="heat">
      <thead><tr><th></th>${head}</tr></thead><tbody>${body}</tbody>
    </table></div>
  </section>`;
}

/** Per-row judge rationales behind the heatmap. A heatmap cell is an average
 *  over the queries of its type, so a rationale can't be attached to a cell —
 *  it belongs to one (query, provider) row, which is what this lists. */
function batchNotesSection(rows: BatchRow[]): string {
  if (!rows.length) return "";
  const body = rows
    .map((r) => {
      const reason = r.error
        ? `<span class="bad">${esc(r.error)}</span>`
        : txt(r.retrieval_rationale).trim()
          ? esc(r.retrieval_rationale)
          : `<span class="dim">(no rationale recorded)</span>`;
      return `<tr>
        <td class="nq"><b>${esc(r.queryId)}</b> <span class="dim">${esc(TYPE_LABELS[r.type] ?? r.type)}</span>
          <div class="dim nq-q">${esc(txt(r.query))}</div></td>
        <td class="nowrap"><span class="swatch" style="background:var(--p-${esc(r.provider)})"></span>${esc(providerMeta(r.provider).label)}</td>
        <td>${r.error ? `<span class="chip chip-na">&mdash;</span>` : scoreChip(r.retrieval_score)}</td>
        <td class="why">${reason}</td>
      </tr>`;
    })
    .join("");
  return `<details class="panel drop">
      <summary><span class="tw"></span>Why those scores &mdash; retrieval rationale for each of the ${rows.length} rows</summary>
      <div class="scroll"><table class="notes">
        <thead><tr><th>query</th><th>provider</th><th>score</th><th>judge&rsquo;s reason</th></tr></thead>
        <tbody>${body}</tbody>
      </table></div>
    </details>`;
}

function sourceEntry(s: Source): string {
  const date = txt(s.published) || "undated";
  const body = txt(s.content) || txt(s.snippet) || "(no content extracted)";
  const title = txt(s.title) || txt(s.url) || "(untitled)";
  const href = safeHref(s.url);
  const head = href
    ? `<a href="${href}" target="_blank" rel="noreferrer noopener">${esc(title)}</a>`
    : `<span class="src-t">${esc(title)}</span>`;
  return `<div class="src">
      <div class="src-h">${head}
        <span class="dim mono">${esc(txt(s.domain))}</span><span class="dim">${esc(date)}</span></div>
      <pre class="src-b">${esc(body)}</pre>
    </div>`;
}

/** Collapsible list of what one arm actually retrieved. */
function sourcesBlock(a: Arm): string {
  const sources = a.sources ?? [];
  if (!sources.length) return "";
  return `<details class="drop sub">
      <summary><span class="tw"></span>${sources.length} source${sources.length === 1 ? "" : "s"} retrieved</summary>
      ${sources.map(sourceEntry).join("")}
    </details>`;
}

/** A score and the judge's reason for it, kept in one block so the two can't be
 *  read against each other. The heading restates the score the rationale
 *  justifies — retrieval rationales sit under the retrieval score, answer under
 *  answer, and a reader never has to infer which is which. */
function verdict(label: string, score: unknown, rationale: string | undefined): string {
  const text = txt(rationale).trim();
  return `<div class="vd">
      <div class="vd-h">${esc(label)} score ${scoreChip(score)}</div>
      <p class="vd-r">${text ? esc(text) : `<span class="dim">(no rationale recorded)</span>`}</p>
    </div>`;
}

function armBlock(a: Arm, winner: string | null | undefined): string {
  const m = providerMeta(a.provider);
  const isWin = a.id === winner && !a.error;
  const answer = txt(a.answer).trim();

  const summary = `<summary>
      <span class="tw"></span>
      <span class="arm-p"><span class="swatch" style="background:var(--p-${esc(a.provider)})"></span>${esc(m.label)}</span>
      ${isWin ? `<span class="win">best</span>` : ""}
      ${
        a.error
          ? `<span class="bad">failed</span>`
          : `<span class="arm-sc">retrieval ${scoreChip(a.retrieval_score)} answer ${scoreChip(a.score)}</span>`
      }
      <span class="dim arm-n">${(a.sources ?? []).length} sources</span>
    </summary>`;

  // An errored arm still gets its sources listed if it managed to fetch any:
  // knowing what came back before the failure is exactly what you want when
  // reading a failure.
  const body = a.error
    ? `<div class="arm-b"><p class="bad">${esc(a.error)}</p>${sourcesBlock(a)}</div>`
    : `<div class="arm-b">
        <div class="vd">
          <div class="vd-h">Answer <span class="dim mono">${esc(txt(a.model))}</span></div>
          <p class="ans">${answer ? esc(answer) : `<span class="dim">(no answer recorded)</span>`}</p>
        </div>
        ${verdict("Retrieval", a.retrieval_score, a.retrieval_rationale)}
        ${verdict("Answer", a.score, a.rationale)}
        ${sourcesBlock(a)}
      </div>`;

  return `<details class="drop arm${isWin ? " won" : ""}">${summary}${body}</details>`;
}

function runCard(r: RunRecord): string {
  const arms = r.arms ?? [];
  const when = new Date(r.ts).toISOString().slice(0, 16).replace("T", " ");
  return `<article class="card">
      <h3 class="q">${esc(txt(r.query))}</h3>
      <div class="card-m dim">varying ${esc(txt(r.variable))} · judge <span class="mono">${esc(txt(r.judge_model))}</span> · ${esc(when)} UTC</div>
      <div class="arms">${arms.map((a) => armBlock(a, r.winner)).join("")}</div>
    </article>`;
}

// ─── Page ───

function themeVars(): string {
  const light = Object.entries(PROVIDERS)
    .map(([id, m]) => `--p-${id}:${m.color};`)
    .join("");
  const dark = Object.entries(PROVIDERS)
    .map(([id, m]) => `--p-${id}:${m.dark};`)
    .join("");
  const heatLight = SCORE_STEPS_LIGHT.map(
    (bg, i) => `.heat-${i}{background:${bg};color:${scoreInkLight(i)}}`,
  ).join("");
  const heatDark = SCORE_STEPS_DARK.map(
    (bg, i) => `.heat-${i}{background:${bg};color:${scoreInkDark(i)}}`,
  ).join("");

  // Dark is stated under both scopes: the media query follows the OS, the
  // data-theme scope follows a viewer toggle, and the toggle has to win either
  // way. Dark steps are their own ramp against the dark surface, not an
  // inversion of the light one.
  return `
  :root{
    color-scheme:light;
    --bg:#f9f9f7; --surface:#fcfcfb; --raised:#ffffff;
    --line:#e6e5e1; --line-2:#d6d5d0;
    --ink:#0b0b0b; --ink-2:#52514e; --ink-3:#8a8983;
    --accent:#2a78d6; --neutral:#b9b8b2;
    --good:#1a7f4b; --bad:#b3261e; --bad-bg:#fdf2f1;
    ${light}
  }
  ${heatLight}
  @media (prefers-color-scheme: dark){
    :root:where(:not([data-theme="light"])){
      color-scheme:dark;
      --bg:#0d0d0d; --surface:#1a1a19; --raised:#211f1f;
      --line:#2e2d2b; --line-2:#3d3c39;
      --ink:#ffffff; --ink-2:#c3c2b7; --ink-3:#8e8d86;
      --accent:#3987e5; --neutral:#4a4946;
      --good:#3fae76; --bad:#e88b85; --bad-bg:#2a1a19;
      ${dark}
    }
    :root:where(:not([data-theme="light"])){ ${heatDark} }
  }
  :root[data-theme="dark"]{
    color-scheme:dark;
    --bg:#0d0d0d; --surface:#1a1a19; --raised:#211f1f;
    --line:#2e2d2b; --line-2:#3d3c39;
    --ink:#ffffff; --ink-2:#c3c2b7; --ink-3:#8e8d86;
    --accent:#3987e5; --neutral:#4a4946;
    --good:#3fae76; --bad:#e88b85; --bad-bg:#2a1a19;
    ${dark}
  }
  :root[data-theme="dark"]{ ${heatDark} }`;
}

const CSS = `
  *,*::before,*::after{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);
    font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
    -webkit-font-smoothing:antialiased}
  .mono{font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:.82em}
  .wrap{max-width:68rem;margin-inline:auto;padding:0 1.5rem 5rem}
  .dim{color:var(--ink-3)}
  .bad{color:var(--bad)}
  .nowrap{white-space:nowrap}
  h1,h2,h3{margin:0;font-weight:600;letter-spacing:-.011em}
  h2{font-size:1rem}
  .scroll{overflow-x:auto}

  header.top{position:sticky;top:0;z-index:5;background:color-mix(in srgb,var(--bg) 88%,transparent);
    backdrop-filter:blur(10px);border-bottom:1px solid var(--line);margin-bottom:1.75rem}
  .top-in{max-width:68rem;margin-inline:auto;padding:.85rem 1.5rem;display:flex;
    align-items:baseline;gap:.75rem;flex-wrap:wrap}
  .brand{font-size:1.05rem;font-weight:640;letter-spacing:-.02em}
  .brand i{font-style:normal;color:var(--accent)}
  .top-m{color:var(--ink-3);font-size:.82rem;margin-left:auto}

  .tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(9.5rem,1fr));
    gap:.75rem;margin-bottom:1.5rem}
  .tile{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:.85rem .95rem}
  .tile-v{font-size:1.6rem;font-weight:620;letter-spacing:-.028em;font-variant-numeric:tabular-nums;line-height:1.1}
  .tile-k{font-size:.78rem;color:var(--ink-2);margin-top:.15rem}
  .tile-s{font-size:.72rem;color:var(--ink-3);margin-top:.3rem;line-height:1.35}

  .panel{background:var(--surface);border:1px solid var(--line);border-radius:12px;
    padding:1.1rem 1.25rem;margin-bottom:1rem}
  .panel-h{display:flex;align-items:center;gap:1rem;flex-wrap:wrap;margin-bottom:.4rem}
  .note{margin:0 0 1rem;color:var(--ink-2);font-size:.83rem;max-width:52rem}
  .legend{margin-left:auto;display:flex;gap:.9rem;font-size:.78rem;color:var(--ink-2)}
  .lg{display:inline-flex;align-items:center;gap:.35rem}
  .sw{width:10px;height:10px;border-radius:3px;display:inline-block}
  .swatch{width:8px;height:8px;border-radius:2px;display:inline-block;margin-right:.4rem;
    vertical-align:baseline;flex:none}
  .f-ret{background:var(--accent)} .f-ans{background:var(--neutral)}

  .bars{display:flex;flex-direction:column;gap:.9rem}
  .bar-group{display:grid;grid-template-columns:minmax(7rem,10rem) 1fr;gap:1rem;align-items:center}
  .bar-name{font-size:.85rem;font-weight:520;display:flex;align-items:center;flex-wrap:wrap}
  .bar-n{color:var(--ink-3);font-size:.72rem;font-weight:400;margin-left:.4rem;width:100%}
  .bar-bars{display:flex;flex-direction:column;gap:2px}
  .bar-line{display:flex;align-items:center;gap:.6rem}
  .bar-track{flex:1;height:9px;background:var(--bg);border-radius:5px;overflow:hidden}
  .bar-fill{height:100%;border-radius:0 4px 4px 0;min-width:2px}
  .bar-v{width:2.4rem;text-align:right;font-size:.78rem;color:var(--ink-2);
    font-variant-numeric:tabular-nums}
  .bar-na{font-size:.78rem;color:var(--ink-3)}

  .scale{margin-left:auto;display:flex;align-items:center;gap:2px;font-size:.7rem;color:var(--ink-3)}
  .scale i{width:13px;height:9px;display:inline-block;border-radius:2px}
  .scale span:first-child{margin-right:.3rem} .scale span:last-child{margin-left:.3rem}

  table{border-collapse:separate;border-spacing:0;width:100%}
  .heat th,.heat td{padding:.5rem .7rem;text-align:center;font-size:.85rem}
  .heat thead th{color:var(--ink-2);font-weight:520;font-size:.78rem;text-align:center;white-space:nowrap}
  .heat .rowh{text-align:left;color:var(--ink);font-weight:500;white-space:nowrap}
  .cell{font-variant-numeric:tabular-nums;font-weight:560;border-radius:6px;
    border:2px solid var(--surface);cursor:default}
  .cell-na{color:var(--ink-3);background:var(--bg)}

  .chip{display:inline-block;min-width:1.55rem;padding:.05rem .3rem;border-radius:5px;
    font-size:.78rem;font-weight:600;text-align:center;font-variant-numeric:tabular-nums}
  .chip-na{background:var(--bg);color:var(--ink-3)}

  details.drop{border:1px solid var(--line);border-radius:10px;background:var(--surface);
    margin-bottom:.5rem}
  details.drop>summary{list-style:none;cursor:pointer;padding:.6rem .85rem;display:flex;
    align-items:center;gap:.55rem;flex-wrap:wrap;font-size:.86rem;border-radius:9px}
  details.drop>summary::-webkit-details-marker{display:none}
  details.drop>summary:hover{background:var(--raised)}
  details.drop[open]>summary{border-bottom:1px solid var(--line);border-radius:9px 9px 0 0}
  .tw{width:0;height:0;border-left:5px solid var(--ink-3);border-top:4px solid transparent;
    border-bottom:4px solid transparent;flex:none;transition:transform .12s ease}
  details[open]>summary .tw{transform:rotate(90deg)}
  details.drop.sub{margin:.7rem 0 0;background:var(--bg)}

  .card{background:var(--surface);border:1px solid var(--line);border-radius:12px;
    padding:1.1rem 1.25rem;margin-bottom:.85rem}
  .q{font-size:.98rem;line-height:1.4}
  .card-m{font-size:.76rem;margin:.25rem 0 .85rem}
  .arms{display:flex;flex-direction:column;gap:.4rem}
  details.arm{background:var(--bg)}
  details.arm.won{border-color:var(--line-2)}
  .arm-p{font-weight:560;display:inline-flex;align-items:center}
  .arm-sc{color:var(--ink-2);font-size:.8rem;display:inline-flex;align-items:center;gap:.35rem}
  .arm-n{font-size:.75rem;margin-left:auto}
  .win{font-size:.68rem;font-weight:600;color:var(--good);border:1px solid currentColor;
    border-radius:99px;padding:.02rem .38rem;text-transform:uppercase;letter-spacing:.04em}
  .arm-b{padding:.85rem}
  .vd{margin-bottom:.85rem}
  .vd-h{font-size:.74rem;font-weight:600;color:var(--ink-2);text-transform:uppercase;
    letter-spacing:.05em;display:flex;align-items:center;gap:.4rem;margin-bottom:.3rem}
  .vd-r,.ans{margin:0;font-size:.87rem;color:var(--ink-2);line-height:1.6}
  .ans{color:var(--ink);background:var(--surface);border:1px solid var(--line);
    border-radius:8px;padding:.6rem .75rem}

  .src{margin:.55rem 0 0;padding:0 .85rem .55rem}
  .src-h{display:flex;gap:.55rem;align-items:baseline;flex-wrap:wrap;font-size:.83rem}
  .src-h a{color:var(--accent);text-decoration:none;font-weight:540}
  .src-h a:hover{text-decoration:underline}
  .src-t{font-weight:540}
  .src-b{margin:.3rem 0 0;padding:.55rem .7rem;background:var(--surface);border:1px solid var(--line);
    border-radius:7px;max-height:13rem;overflow:auto;white-space:pre-wrap;word-break:break-word;
    font:12px/1.55 ui-monospace,Menlo,monospace;color:var(--ink-2)}

  .notes th,.notes td{padding:.5rem .6rem;text-align:left;font-size:.82rem;
    border-bottom:1px solid var(--line);vertical-align:top}
  .notes thead th{color:var(--ink-3);font-weight:500;font-size:.72rem;text-transform:uppercase;
    letter-spacing:.04em}
  .nq{min-width:13rem} .nq-q{font-size:.76rem;margin-top:.15rem}
  .why{color:var(--ink-2);min-width:16rem}
  .empty{color:var(--ink-2);text-align:center;padding:3rem 1rem}
  code{background:var(--bg);border:1px solid var(--line);padding:.08rem .3rem;border-radius:5px;
    font-family:ui-monospace,Menlo,monospace;font-size:.85em}
  @media (max-width:34rem){
    .bar-group{grid-template-columns:1fr;gap:.35rem}
    .arm-n{margin-left:0;width:100%}
  }`;

/** Build the full report page from all persisted records. */
export function buildReport(records: SourceryRecord[], generatedAt: string): string {
  const runs = records.filter((r): r is RunRecord => r.mode === "run");
  const batchRows = records.filter((r): r is BatchRowRecord => r.mode === "batch");

  // Latest batch = the batchId whose newest row is most recent.
  const byBatch = new Map<string, BatchRow[]>();
  for (const r of batchRows) {
    const list = byBatch.get(r.batchId) ?? [];
    list.push(r.row);
    byBatch.set(r.batchId, list);
  }
  const latestBatchId = [...byBatch.keys()].at(-1);
  const latestBatch = latestBatchId ? byBatch.get(latestBatchId)! : [];

  const s = summarize(records);
  const empty = !runs.length && !latestBatch.length;

  const sections = empty
    ? `<div class="panel empty">Nothing recorded yet. Run <code>sourcery run "&lt;query&gt;"</code> or
        <code>sourcery batch</code>, then come back.</div>`
    : [
        statTiles(s),
        providerChart(s),
        heatmapSection(latestBatch),
        batchNotesSection(latestBatch),
        runs.length
          ? `<h2 class="sec">Single runs</h2>${[...runs].reverse().map(runCard).join("")}`
          : "",
      ].join("\n");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>sourcery report</title>
<style>${themeVars()}${CSS}
  .sec{font-size:.76rem;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-3);
    margin:1.75rem 0 .6rem}
</style></head>
<body>
  <header class="top"><div class="top-in">
    <span class="brand">sourcery<i>.</i></span>
    <span class="dim" style="font-size:.82rem">retrieval eval</span>
    <span class="top-m">${records.length} record${records.length === 1 ? "" : "s"} · ${esc(generatedAt)}</span>
  </div></header>
  <main class="wrap">${sections}</main>
</body></html>`;
}
