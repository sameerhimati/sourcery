import { heatColor, heatText, providerMeta, scoreText } from "@core/viz";
import { TYPE_LABELS } from "@core/batch";
import type { BatchRow, HeatRow } from "@core/batch";
import type { QueryType } from "@core/eval-dataset";
import type { Arm, Source } from "@core/types";
import type { BatchRowRecord, RunRecord, SourceryRecord } from "./persist";

// Self-contained HTML report — inline CSS, no external requests, no JS. A pure
// view over runs.jsonl (records in → HTML string out) so it snapshots in tests.

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const scoreCell = (n: number): string =>
  `<span class="score" style="color:${scoreText(n)}">${n}/10</span>`;

/** Re-aggregate persisted rows into the same heatmap runBatch would produce. */
function aggregate(rows: BatchRow[]): { providers: string[]; heat: HeatRow[] } {
  const providers = [...new Set(rows.map((r) => r.provider))];
  const types = [...new Set(rows.map((r) => r.type))] as QueryType[];
  const avg = (ns: number[]) => (ns.length ? ns.reduce((s, x) => s + x, 0) / ns.length : 0);
  const heat = types.map((type) => {
    const ok = rows.filter((r) => r.type === type && !r.error);
    const cell: HeatRow = {
      type,
      label: TYPE_LABELS[type] ?? type,
      bright_data: Number(avg(ok.filter((r) => r.provider === "bright_data").map((r) => r.retrieval_score)).toFixed(2)),
      firecrawl: Number(avg(ok.filter((r) => r.provider === "firecrawl").map((r) => r.retrieval_score)).toFixed(2)),
      runs: ok.length,
    };
    return cell;
  });
  return { providers, heat };
}

function heatmapSection(rows: BatchRow[]): string {
  const { providers, heat } = aggregate(rows);
  const head = providers.map((p) => `<th>${esc(providerMeta(p).label)}</th>`).join("");
  const body = heat
    .map((h) => {
      const cells = providers
        .map((p) => {
          const v = (h as unknown as Record<string, number>)[p] ?? 0;
          return `<td class="heat" style="background:${heatColor(v)};color:${heatText()}">${v.toFixed(1)}</td>`;
        })
        .join("");
      return `<tr><th class="rowh">${esc(h.label)}</th>${cells}</tr>`;
    })
    .join("");
  return `
    <h2>Latest batch — avg retrieval score by query type</h2>
    <table class="heatmap"><thead><tr><th></th>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function sourceEntry(s: Source): string {
  const date = s.published ?? "undated";
  const body = s.content ?? s.snippet ?? "(no content extracted)";
  const title = s.title || s.url;
  return `<div class="src">
      <div class="src-head"><a href="${esc(s.url)}" target="_blank" rel="noreferrer">${esc(title)}</a>
        <span class="dom">${esc(s.domain)}</span><span class="date">${esc(date)}</span></div>
      <pre class="src-body">${esc(body)}</pre>
    </div>`;
}

/** Collapsible list of what one arm actually retrieved — the sources + their text. */
function sourcesBlock(a: Arm): string {
  if (!a.sources.length) return "";
  return `<details class="sources">
      <summary>${esc(providerMeta(a.provider).label)} — ${a.sources.length} source${a.sources.length === 1 ? "" : "s"} retrieved</summary>
      ${a.sources.map(sourceEntry).join("")}
    </details>`;
}

function runCard(r: RunRecord): string {
  const arms = r.arms
    .map((a) => {
      const win = a.id === r.winner ? ' class="winner"' : "";
      const scores = a.error
        ? `<td colspan="3" class="err">${esc(a.error)}</td>`
        : `<td>${scoreCell(a.retrieval_score)}</td><td>${scoreCell(a.score)}</td><td class="mut">${a.latency_ms}ms</td>`;
      return `<tr${win}><td>${a.id === r.winner ? "★ " : ""}${esc(providerMeta(a.provider).label)}</td>${scores}</tr>`;
    })
    .join("");
  const sources = r.arms.map(sourcesBlock).join("");
  return `
    <div class="card">
      <div class="q">${esc(r.query)}</div>
      <div class="meta">varying ${esc(r.variable)} · judge ${esc(r.judge_model)} · ${new Date(r.ts).toLocaleString()}</div>
      <table class="arms">
        <thead><tr><th>provider</th><th>retrieval</th><th>answer</th><th>latency</th></tr></thead>
        <tbody>${arms}</tbody>
      </table>
      ${sources}
    </div>`;
}

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

  const empty = !runs.length && !latestBatch.length;
  const sections = [
    latestBatch.length ? heatmapSection(latestBatch) : "",
    runs.length
      ? `<h2>Single runs (${runs.length})</h2>${[...runs].reverse().map(runCard).join("")}`
      : "",
    empty ? `<p class="mut">No runs yet — try <code>sourcery run "&lt;query&gt;"</code>.</p>` : "",
  ].join("\n");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>sourcery report</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; padding: 2.5rem 1.5rem; background: #faf6ef; color: #2a2620;
    font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; max-width: 60rem; margin-inline: auto; }
  h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
  h2 { font-size: 1.05rem; margin: 2.5rem 0 .75rem; }
  .sub { color: #8a8272; margin: 0 0 1rem; font-size: .85rem; }
  .mut { color: #8a8272; }
  .score, .heat, td.mut { font-family: ui-monospace, "SF Mono", Menlo, monospace; }
  table { border-collapse: collapse; width: 100%; }
  .heatmap th, .heatmap td { padding: .5rem .75rem; text-align: center; border: 3px solid #faf6ef; }
  .heatmap thead th, .heatmap .rowh { background: #f0ebe0; font-weight: 600; text-align: left; }
  .heat { font-weight: 700; border-radius: 4px; }
  .card { background: #fffdf9; border: 1px solid #e8e1d4; border-radius: 10px;
    padding: 1rem 1.25rem; margin: .75rem 0; }
  .q { font-weight: 600; }
  .meta { color: #8a8272; font-size: .8rem; margin: .1rem 0 .6rem; }
  .arms th, .arms td { padding: .35rem .6rem; text-align: left; border-bottom: 1px solid #f0ebe0; }
  .arms thead th { color: #8a8272; font-weight: 500; font-size: .78rem; text-transform: uppercase; letter-spacing: .04em; }
  tr.winner td { background: #f3f7f0; }
  .err { color: #a04030; font-style: italic; }
  code { background: #f0ebe0; padding: .1rem .35rem; border-radius: 4px; }
  details.sources { margin-top: .6rem; border-top: 1px solid #f0ebe0; padding-top: .5rem; }
  details.sources summary { cursor: pointer; color: #6a6252; font-size: .82rem; }
  details.sources summary:hover { color: #2a2620; }
  .src { margin: .6rem 0 .2rem; }
  .src-head { display: flex; gap: .6rem; align-items: baseline; flex-wrap: wrap; font-size: .85rem; }
  .src-head a { color: #3a5a8a; text-decoration: none; font-weight: 600; }
  .src-head a:hover { text-decoration: underline; }
  .src-head .dom { color: #8a8272; font-family: ui-monospace, Menlo, monospace; font-size: .78rem; }
  .src-head .date { color: #8a8272; font-size: .78rem; }
  .src-body { margin: .3rem 0 0; padding: .6rem .75rem; background: #f7f2ea; border-radius: 6px;
    max-height: 15rem; overflow: auto; white-space: pre-wrap; word-break: break-word;
    font: 12px/1.5 ui-monospace, Menlo, monospace; color: #4a4436; }
</style></head>
<body>
  <h1>sourcery report</h1>
  <p class="sub">${records.length} record(s) · generated ${esc(generatedAt)}</p>
  ${sections}
</body></html>`;
}
