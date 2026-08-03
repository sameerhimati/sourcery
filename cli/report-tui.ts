import {
  PROVIDERS,
  SCORE_STEPS_DARK,
  median,
  providerMeta,
  scoreStep,
} from "@core/viz";
import { deriveHeatmap, providersIn } from "@core/batch";
import type { BatchRow } from "@core/batch";
import type { BatchRowRecord, RunRecord, SourceryRecord } from "./persist";

// Terminal report — the same view as the HTML one, for people who don't want to
// leave the shell. Kept pure (records + options in, string out) so it snapshots
// in tests, with colour as an explicit option rather than a read of process
// state, which is also what makes a no-colour snapshot possible.
//
// `renderRun`/`renderBatch` in format.ts stay plain-text and unchanged: those
// are the scorecards a command prints as it works, and they're parsed by eye
// mid-run. This is the read-afterwards view, where colour earns its place.

export interface TuiOptions {
  color: boolean;
  width: number;
}

/** True unless the stream isn't a TTY or the user asked for no colour.
 *  Honours the NO_COLOR convention and FORCE_COLOR, in that order of surprise. */
export function detectColor(env: NodeJS.ProcessEnv, isTTY: boolean): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0") return true;
  return isTTY && env.TERM !== "dumb";
}

const RESET = "[0m";

function rgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/** 24-bit colour. Every terminal that matters has supported it for a decade, and
 *  the fallback for one that doesn't is a stray escape, not a crash. */
const fg = (hex: string, s: string, on: boolean): string => {
  if (!on) return s;
  const [r, g, b] = rgb(hex);
  return `[38;2;${r};${g};${b}m${s}${RESET}`;
};

const bgFg = (bgHex: string, fgHex: string, s: string, on: boolean): string => {
  if (!on) return s;
  const [r, g, b] = rgb(bgHex);
  const [r2, g2, b2] = rgb(fgHex);
  return `[48;2;${r};${g};${b}m[38;2;${r2};${g2};${b2}m${s}${RESET}`;
};

const dim = (s: string, on: boolean): string => (on ? `[2m${s}${RESET}` : s);
const bold = (s: string, on: boolean): string => (on ? `[1m${s}${RESET}` : s);

/** Display width, ignoring the escape sequences the colour helpers inject. */
const ANSI_RE = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");
const vlen = (s: string): number => s.replace(ANSI_RE, "").length;
const padEnd = (s: string, w: number): string => s + " ".repeat(Math.max(0, w - vlen(s)));
const padStart = (s: string, w: number): string => " ".repeat(Math.max(0, w - vlen(s))) + s;

const num = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const txt = (s: unknown): string => (typeof s === "string" ? s : "");

// Terminals are dark far more often than not, and the dark ramp is the one
// stepped against a dark surface. A light-terminal user still reads it: the ramp
// is monotonic in lightness either way, so the ordering survives even if the
// contrast isn't ideal.
const heatBg = (score: number): string => SCORE_STEPS_DARK[scoreStep(score)];
const heatInk = (score: number): string => (scoreStep(score) >= 9 ? "#0b0b0b" : "#ffffff");

interface Row {
  provider: string;
  query: string;
  retrieval: number | null;
  answer: number | null;
  latency: number | null;
  failed: boolean;
}

function flatten(records: SourceryRecord[]): Row[] {
  const out: Row[] = [];
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

const ORDER = Object.keys(PROVIDERS);
const orderOf = (p: string): number => {
  const i = ORDER.indexOf(p);
  return i === -1 ? ORDER.length : i;
};

const mean = (xs: number[]): number | null =>
  xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null;

/** A proportional bar in eighth-block characters, so a 2.89 and a 3.11 are
 *  visibly different rather than rounding to the same number of full blocks. */
function bar(value: number | null, cells: number, color: string, on: boolean): string {
  if (value === null) return dim("no data", on);
  const filled = Math.max(0, Math.min(1, value / 10)) * cells;
  const whole = Math.floor(filled);
  const rem = filled - whole;
  const PARTIALS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
  const partial = PARTIALS[Math.floor(rem * 8)];
  const body = "█".repeat(whole) + partial;
  const track = "·".repeat(Math.max(0, cells - vlen(body)));
  return fg(color, body, on) + dim(track, on);
}

export function renderReportTui(records: SourceryRecord[], opts: TuiOptions): string {
  const { color: c } = opts;
  const width = Math.max(60, Math.min(opts.width || 100, 120));
  const rows = flatten(records);

  if (!rows.length) {
    return [
      "",
      `  ${bold("sourcery", c)} ${dim("· retrieval eval", c)}`,
      "",
      `  Nothing recorded yet. Run ${bold('sourcery run "<query>"', c)} or ${bold("sourcery batch", c)} first.`,
      "",
    ].join("\n");
  }

  const out: string[] = [];
  const rule = dim("─".repeat(width - 4), c);

  // ── header ──
  out.push("");
  out.push(
    `  ${bold("sourcery", c)} ${dim("· retrieval eval", c)}` +
      padStart(dim(`${records.length} record${records.length === 1 ? "" : "s"}`, c), width - 26),
  );
  out.push(`  ${rule}`);

  // ── stat tiles ──
  const fails = rows.filter((r) => r.failed).length;
  const lat = median(rows.map((r) => r.latency).filter(num));
  const providers = [...new Set(rows.map((r) => r.provider))].sort(
    (a, b) => orderOf(a) - orderOf(b),
  );
  const tiles: [string, string][] = [
    [String(rows.length), "results"],
    [String(new Set(rows.map((r) => r.query)).size), "queries"],
    [String(providers.length), "providers"],
    [lat === null ? "—" : `${Math.round(lat / 1000)}s`, "med latency"],
    [`${rows.length ? ((fails / rows.length) * 100).toFixed(1) : "0"}%`, "failed"],
  ];
  const tw = Math.floor((width - 4) / tiles.length);
  out.push("");
  out.push("  " + tiles.map(([v]) => padEnd(bold(v, c), tw)).join(""));
  out.push("  " + tiles.map(([, k]) => padEnd(dim(k, c), tw)).join(""));

  // ── retrieval vs answer ──
  out.push("");
  out.push(`  ${bold("RETRIEVAL VS ANSWER", c)}  ${dim("· 0–10, same scale", c)}`);
  out.push("");
  const nameW = Math.max(...providers.map((p) => providerMeta(p).label.length), 11) + 2;
  const barW = Math.max(14, width - nameW - 24);
  for (const p of providers) {
    const rs = rows.filter((r) => r.provider === p);
    const m = providerMeta(p);
    const ret = mean(rs.map((r) => r.retrieval).filter(num));
    const ans = mean(rs.map((r) => r.answer).filter(num));
    // The label column carries the provider on the first line and its result count
    // on the second, so the two bars stay a visual pair with nothing dangling
    // under them.
    const line = (lead: string, tag: string, v: number | null, col: string) =>
      `  ${padEnd(lead, nameW)}${dim(padEnd(tag, 10), c)}${bar(v, barW, col, c)}  ` +
      `${padStart(v === null ? "—" : v.toFixed(2), 5)}`;
    out.push(line(fg(m.dark, m.label, c), "retrieval", ret, m.dark));
    out.push(line(dim(`${rs.length} results`, c), "answer", ans, "#6b6a66"));
    if (p !== providers[providers.length - 1]) out.push("");
  }

  // ── heatmap ──
  const batchRows = records.filter((r): r is BatchRowRecord => r.mode === "batch");
  const byBatch = new Map<string, BatchRow[]>();
  for (const r of batchRows) {
    const list = byBatch.get(r.batchId) ?? [];
    list.push(r.row);
    byBatch.set(r.batchId, list);
  }
  const latestId = [...byBatch.keys()].at(-1);
  const latest = latestId ? byBatch.get(latestId)! : [];

  if (latest.length) {
    // Same fixed order as the bars above. providersIn returns whatever order the
    // batch happened to write, which put the heatmap columns and the bar rows in
    // different orders on the same screen.
    const hp = [...providersIn(latest)].sort((a, b) => orderOf(a) - orderOf(b));
    const heat = deriveHeatmap(latest, hp);
    if (heat.length) {
      // The legend is a colour ramp, so it says nothing without colour. Without
      // it the cells are still plain numbers, which read fine on their own.
      const legend = c
        ? padStart(
            `${dim("0", c)}${SCORE_STEPS_DARK.map((s, i) => bgFg(s, heatInk(i), " ", c)).join("")}${dim("10", c)}`,
            24,
          )
        : "";
      out.push("");
      out.push(`  ${bold("RETRIEVAL BY QUERY TYPE", c)}  ${dim("· latest batch", c)}${legend}`);
      out.push("");
      const labelW = Math.max(...heat.map((h) => h.label.length), 4) + 2;
      const colW = Math.max(...hp.map((p) => providerMeta(p).label.length), 5) + 2;
      // A painted cell carries a space either side of the number so the colour
      // block has body. Headers reserve that same right-hand space, otherwise
      // every column label sits one character right of its own numbers.
      out.push(
        "  " +
          padEnd("", labelW) +
          hp
            .map(
              (p) =>
                padStart(fg(providerMeta(p).dark, providerMeta(p).label, c), colW - 1) + " ",
            )
            .join(""),
      );
      for (const h of heat) {
        const cells = hp
          .map((p) => {
            const v = h.scores[p];
            if (!num(v)) return padStart(dim("—", c), colW - 1) + " ";
            const cell = ` ${v.toFixed(1)} `;
            return padStart(bgFg(heatBg(v), heatInk(v), cell, c), colW);
          })
          .join("");
        out.push("  " + padEnd(h.label, labelW) + cells);
      }
    }
  }

  // ── recent single runs ──
  const runs = records.filter((r): r is RunRecord => r.mode === "run");
  if (runs.length) {
    out.push("");
    out.push(`  ${bold("SINGLE RUNS", c)}  ${dim(`· ${runs.length}, most recent first`, c)}`);
    out.push("");
    for (const r of [...runs].reverse().slice(0, 8)) {
      const q = txt(r.query);
      const shown = q.length > width - 6 ? q.slice(0, width - 9) + "…" : q;
      out.push(`  ${shown}`);
      for (const a of r.arms ?? []) {
        const m = providerMeta(a.provider);
        const mark = a.id === r.winner && !a.error ? fg("#3fae76", "●", c) : " ";
        const scores = a.error
          ? fg("#e88b85", "failed", c)
          : `${dim("ret", c)} ${bgFg(heatBg(a.retrieval_score), heatInk(a.retrieval_score), ` ${num(a.retrieval_score) ? a.retrieval_score : "—"} `, c)}` +
            `  ${dim("ans", c)} ${bgFg(heatBg(a.score), heatInk(a.score), ` ${num(a.score) ? a.score : "—"} `, c)}`;
        out.push(
          `   ${mark} ${padEnd(fg(m.dark, m.label, c), nameW)}${scores}` +
            dim(`  ${(a.sources ?? []).length} sources`, c),
        );
      }
      out.push("");
    }
    if (runs.length > 8) out.push(dim(`  … ${runs.length - 8} more`, c));
  }

  out.push(`  ${rule}`);
  out.push(
    dim(`  full detail, every answer and judge rationale:  sourcery report`, c),
  );
  out.push("");
  return out.join("\n");
}
