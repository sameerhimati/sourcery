#!/usr/bin/env node
// Build the public results page from the run's own derived numbers.
//
// Every figure in a chart, a tile or the table comes from docs/report-data.json,
// so a chart and the number beside it cannot disagree. If one of those looks
// wrong it is wrong upstream, in scripts/build-report-data.mjs, and fixing it
// there fixes the page.
//
// The running prose is templated too. Figures that used to be typed into
// sentences by hand — the captcha failures, Bright Data's
// extraction yield, how far Tavily got before its plan ran out — are derived in
// scripts/build-report-data.mjs now and arrive here as tokens. The two that
// cannot be derived, because they come from a billing page rather than the run,
// sit in that file's `recorded` block with their source beside them.
//
// scripts/check-numbers.mjs enforces this: it reads the built page's text and
// fails if a number in it traces to nothing in docs/report-data.json. Add a
// figure to a sentence by hand and the build stops.
//
// The charts are static SVG emitted at build time rather than drawn by script in
// the browser. Two reasons: the page needs no JavaScript to show its results,
// and the same <svg> can be pasted into a post whose markdown pipeline renders
// raw HTML but never executes a script tag.
//
// Charts carry no titles of their own. The prose above each one already says
// what it shows, and a repeated heading inside the frame is the tell that a
// chart was dropped in rather than written into an argument.
//
// Usage: node scripts/build-report.mjs [data.json] [template.html] [out.html]

import fs from "node:fs";
import path from "node:path";
// Imported, not transcribed: the rubrics and rung names the methodology page
// publishes are the ones the run actually used. A copy would drift.
import { RELEVANCE_RUNGS, SET_RUNGS, NUM_SOURCES } from "../core/controls.ts";
// The nav bar, its styles, and the site's URLs live in one module both build
// scripts import, so the report and the explorer cannot disagree about either.
import { BASE, REPO, fetchedRange, navHtml, NAV_CSS } from "./nav.mjs";

const DATA = process.argv[2] ?? "docs/report-data.json";

const d = JSON.parse(fs.readFileSync(DATA, "utf8"));
const P = d.providers;
const ORDER = d.provider_order;

// Providers are named by their package name everywhere else in the repo. The
// page is read by people, so it gets the name the vendor uses.
const LABEL = {
  perplexity: "Perplexity",
  brave: "Brave",
  parallel: "Parallel",
  exa: "Exa",
  tavily: "Tavily",
  serper: "Serper",
  firecrawl: "Firecrawl",
  bright_data: "Bright Data",
};

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// One helper per kind of number the page renders, and every chart and cell goes
// through them. A rating typed as `.toFixed(2)` in a chart and `.toFixed(3)` in
// the table beside it is two numbers to a reader, and nobody drawing either one
// would notice.
const f3 = (n) => n.toFixed(3); // a rating on the 0–3 rubric
const f2 = (n) => n.toFixed(2); // an axis tick, where a third decimal is noise
const f1 = (n) => n.toFixed(1);
const pm = (n) => `± ${f3(n)}`; // half-width of a confidence interval
const fall = (n) => `− ${f3(n)}`; // how far a rating dropped
const share = (n) => `${Math.round(n)}%`; // a percentage of pages
// Seconds, because a search that takes half a minute is the kind of fact a
// reader should not have to convert from milliseconds to notice.
const secs = (ms) => (ms >= 10000 ? `${(ms / 1000).toFixed(0)}s` : `${(ms / 1000).toFixed(1)}s`);
const money = (n) => `$${n.toFixed(4)}`.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");

// Small counts read as words in a sentence. Anything the reader might want to
// compare stays a numeral.
const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const numberWord = (n) => WORDS[n] ?? String(n);

// ── shared chart geometry ─────────────────────────────────────────────────────
// One width, one gutter, one row height across every chart, so a provider sits
// on the same line in all four and the eye can track it down the page.
const W = 720;
const GUT = 112; // right edge of the provider-name column
const PLOT = 452; // right edge of the plot area
const ROW = 34;

const txt = (x, y, cls, s, anchor) =>
  `<text x="${x}" y="${y}" class="${cls}"${anchor ? ` text-anchor="${anchor}"` : ""}>${esc(s)}</text>`;

// Every mark on every chart is the same colour. Grid has one accent and a chart
// does not get to invent a second — see the note beside --mark in
// site/style.css. Two series separate by fill instead: solid is the
// measured thing, hollow carries the caveat named in that chart's legend. It is
// a helper rather than a literal in four places so a fifth chart cannot drift.
const dot = (cx, cy, r, hollow) => `<circle cx="${cx}" cy="${cy}" r="${r}" class="est${hollow ? " hollow" : ""}"/>`;

// What the horizontal axis measures, in units, and which end is the good end.
// Every chart says both. A reader who lands on one figure out of context should
// not have to infer from the provider order whether more is better.
const axisFooter = (y, units, direction, right = PLOT) =>
  txt(GUT, y, "collab", units) + txt(right, y, "collab", direction, "end");

function frame(h, title, desc, body) {
  const id = title.id;
  return (
    `<svg viewBox="0 0 ${W} ${h}" width="100%" role="img" aria-labelledby="${id}-t ${id}-d" class="viz">` +
    `<title id="${id}-t">${esc(title.text)}</title>` +
    `<desc id="${id}-d">${esc(desc)}</desc>` +
    body +
    `</svg>`
  );
}

// ── 1. the leaderboard, as a forest plot ──────────────────────────────────────
// A bar chart says "this much"; the honest claim here is "somewhere in here".
// So the estimate is a dot and the interval is the line it sits on — the shape
// statisticians use for exactly this, and the shape that makes an overlap
// impossible to miss. Bars would draw the eye to a length that is not the
// finding.
function chartLeaderboard() {
  const rows = ORDER.map((k) => ({ k, ...P[k].set }));
  const top = 30;
  const baseY = top + rows.length * ROW;
  const h = baseY + 60;
  const dom = [1.8, 2.9];
  const x = (v) => GUT + ((v - dom[0]) / (dom[1] - dom[0])) * (PLOT - GUT);

  let s = "";
  for (const t of [2.0, 2.2, 2.4, 2.6, 2.8]) {
    s += `<line x1="${x(t)}" y1="${top - 8}" x2="${x(t)}" y2="${baseY - 10}" class="grid"/>`;
    s += txt(x(t), baseY + 8, "tick", f1(t), "middle");
  }
  s += axisFooter(baseY + 30, "set rating, 0–3", "higher is better");
  // This is the first chart on the page and the first place a confidence
  // interval appears, so it says what one is here rather than in the method tab.
  s += txt(GUT, baseY + 50, "note", "Each line is the 95% confidence interval: the range the true rating probably sits in.");

  rows.forEach((r, i) => {
    const cy = top + i * ROW + ROW / 2 - 4;
    s += txt(GUT - 16, cy + 4, "name", LABEL[r.k], "end");
    s += `<line x1="${x(r.mean - r.ci95)}" y1="${cy}" x2="${x(r.mean + r.ci95)}" y2="${cy}" class="iv"/>`;
    s += `<line x1="${x(r.mean - r.ci95)}" y1="${cy - 4}" x2="${x(r.mean - r.ci95)}" y2="${cy + 4}" class="iv-cap"/>`;
    s += `<line x1="${x(r.mean + r.ci95)}" y1="${cy - 4}" x2="${x(r.mean + r.ci95)}" y2="${cy + 4}" class="iv-cap"/>`;
    s += dot(x(r.mean), cy, 5);
    s += txt(PLOT + 28, cy + 4, "num", f3(r.mean));
    s += txt(PLOT + 74, cy + 4, "num dim", pm(r.ci95));
  });

  // Bracket every run of providers whose intervals overlap down the list. There
  // is more than one such run, and showing only the top one would hide a real
  // cluster at the bottom.
  const groups = [];
  let cur = [0];
  for (let i = 0; i < rows.length - 1; i++) {
    if (rows[i].mean - rows[i].ci95 <= rows[i + 1].mean + rows[i + 1].ci95) cur.push(i + 1);
    else {
      groups.push(cur);
      cur = [i + 1];
    }
  }
  groups.push(cur);
  const bx = 622;
  for (const g of groups.filter((g) => g.length > 1)) {
    const yA = top + g[0] * ROW + 8;
    const yB = top + (g[g.length - 1] + 1) * ROW - 8;
    s += `<path d="M${bx} ${yA} h7 V${yB} h-7" class="brace"/>`;
    s += txt(bx + 14, (yA + yB) / 2 + 3.5, "bracelab", "a tie");
  }
  return frame(
    h,
    { id: "lb", text: "Set rating by provider, with 95% confidence intervals" },
    `Perplexity leads at ${f3(P.perplexity.set.mean)} and is the only provider clear of every other. ` +
      `Brave, Parallel and Exa overlap and cannot be ordered; so can Tavily, Serper, Firecrawl and Bright Data. ` +
      `Bright Data is last at ${f3(P.bright_data.set.mean)}.`,
    s,
  );
}

// ── 2. base against hard ──────────────────────────────────────────────────────
function chartDifficulty() {
  // Sorted by its own metric rather than borrowing the leaderboard's. This chart
  // plots per-page scores, and on those Exa beats Parallel while the set rating
  // puts Parallel first — so the leaderboard's order left the dots not
  // descending, which reads as a plotting error instead of as the finding it is.
  const rows = ORDER.map((k) => ({ k, ...P[k].difficulty })).sort((a, b) => b.base - a.base);
  const top = 46;
  const baseY = top + rows.length * ROW;
  const h = baseY + 42;
  const dom = [1.2, 2.44];
  const x = (v) => GUT + ((v - dom[0]) / (dom[1] - dom[0])) * (PLOT - GUT);

  // Two series, so a legend is not optional. It sits on its own line above the
  // plot, which is why the ticks are at the bottom.
  let s =
    dot(GUT + 5, 18, 5) +
    txt(GUT + 16, 22, "legend", `${d.counts.base} base questions`) +
    dot(GUT + 178, 18, 5, true) +
    txt(GUT + 189, 22, "legend", `${d.counts.hard} written to be hard`);

  for (const t of [1.25, 1.5, 1.75, 2.0, 2.25]) {
    s += `<line x1="${x(t)}" y1="${top - 8}" x2="${x(t)}" y2="${baseY - 10}" class="grid"/>`;
    s += txt(x(t), baseY + 8, "tick", f2(t), "middle");
  }
  s += axisFooter(baseY + 30, "page rating, 0–3", "higher is better");

  rows.forEach((r, i) => {
    const cy = top + i * ROW + ROW / 2 - 4;
    s += txt(GUT - 16, cy + 4, "name", LABEL[r.k], "end");
    // A provider that lost nothing puts both dots in one place, which reads as a
    // missing dot rather than as no change. Nudge them just apart.
    let bx2 = x(r.base);
    let hx = x(r.hard);
    if (Math.abs(bx2 - hx) < 7) {
      const mid = (bx2 + hx) / 2;
      bx2 = mid + 3.5;
      hx = mid - 3.5;
    }
    s += `<line x1="${hx}" y1="${cy}" x2="${bx2}" y2="${cy}" class="join"/>`;
    s += dot(bx2, cy, 5);
    s += dot(hx, cy, 5, true);
    const drop = r.base - r.hard;
    s += txt(PLOT + 28, cy + 4, drop > 0.15 ? "num hot" : "num dim", drop > 0.005 ? fall(drop) : "no drop");
  });
  // The dots are ratings, where higher is better; this column is how far the
  // rating fell, where the good direction is the other way. Two labels, because
  // one "higher is better" over the whole chart would be wrong about half of it.
  s += txt(PLOT + 28, 14, "collab", "drop on the hard half");
  s += txt(PLOT + 28, 30, "collab", "smaller is better");
  return frame(
    h,
    { id: "df", text: "Base questions against hard questions, by provider" },
    `Perplexity and Parallel lose almost nothing between the base and hard halves. Tavily, Firecrawl and Bright Data ` +
      `lose about a quarter of a point on the 0–3 scale, so the spread between best and worst widens by ${d.spread.widened_pct}%.`,
    s,
  );
}

// ── 3. price against quality ──────────────────────────────────────────────────
function chartPrice() {
  const B = 288;
  const h = B + 92; // room under the axis for two lines explaining the frontier
  const L = 96;
  const R = 636;
  const T = 30;
  const lo = Math.log10(0.0008);
  const hi = Math.log10(0.13);
  const x = (v) => L + ((Math.log10(v) - lo) / (hi - lo)) * (R - L);
  const y = (v) => B - ((v - 1.85) / (2.85 - 1.85)) * (B - T);

  // The corner worth wanting: under the middle of the field on price and over it
  // on rating. Both cut points come from the data file, so the tint cannot end
  // up marking a corner the numbers do not support. It goes down first and stays
  // faint — it is context behind the marks, not a fifth series.
  const F = d.frontier;
  let s = `<rect x="${L}" y="${T}" width="${x(F.median_cost_usd) - L}" height="${y(F.median_set_mean) - T}" class="quad"/>`;

  for (const t of [2.0, 2.25, 2.5, 2.75]) {
    s += `<line x1="${L}" y1="${y(t)}" x2="${R}" y2="${y(t)}" class="grid"/>`;
    s += txt(L - 14, y(t) + 4, "tick", f2(t), "end");
  }
  for (const t of [0.001, 0.005, 0.01, 0.05, 0.1]) {
    s += txt(x(t), B + 22, "tick", money(t), "middle");
  }
  s += `<line x1="${L}" y1="${B}" x2="${R}" y2="${B}" class="axis"/>`;
  s += txt(L, B + 44, "collab", "cost per query, log scale");
  s += txt(R, B + 44, "collab", "cheaper is better", "end");
  s += `<text class="collab" transform="translate(26 ${(T + B) / 2}) rotate(-90)" text-anchor="middle">set rating, 0–3 · higher is better</text>`;

  // The providers nothing else beats on both counts at once, joined cheapest
  // first. Which providers those are is derived in build-report-data.mjs and
  // read off here — drawing a line through a list typed into this file would be
  // an assertion the data never made.
  s +=
    `<polyline points="${F.providers.map((k) => `${x(P[k].cost.per_query_usd)},${y(P[k].set.mean)}`).join(" ")}" class="front"/>`;

  // Eight points on a log axis collide in ways no generic rule solves, and a
  // collided label is worse than a hand-tuned constant.
  const nudge = {
    perplexity: [11, -9],
    brave: [11, 3],
    parallel: [11, 14],
    exa: [11, -7],
    tavily: [-11, -8],
    serper: [11, 4],
    firecrawl: [-11, 4],
    bright_data: [11, 4],
  };
  for (const k of ORDER) {
    const c = P[k].cost;
    const px = x(c.per_query_usd);
    const py = y(P[k].set.mean);
    // a hollow ring means the price is a published rate, not a settled bill
    s += dot(px, py, 5.5, c.is_estimate);
    const [dx, dy] = nudge[k];
    s += txt(px + dx, py + dy, "ptname", LABEL[k], dx < 0 ? "end" : "start");
  }
  // Under the axis rather than inside the plot: eight labelled points already
  // fill the frame, and the line runs through the only clear space left.
  s += txt(L, B + 62, "note", "The dashed line joins the providers nothing else beats on both price and rating.");
  s += txt(L, B + 78, "note", "The shaded corner is cheaper and rated higher than half the field.");
  return frame(
    h,
    { id: "pr", text: "Set rating against cost per query" },
    `Cost runs from ${money(P.serper.cost.per_query_usd)} to ${money(P.firecrawl.cost.per_query_usd)} a query, ` +
      `a ${Math.round(P.firecrawl.cost.per_query_usd / P.serper.cost.per_query_usd)}-fold spread, and the three arms on the cheapest ` +
      `per-query tier take three of the top four places while the outright cheapest places sixth. Firecrawl is the most expensive and seventh on quality. ` +
      `Only ${F.providers.map((k) => LABEL[k]).join(" and ")} are beaten by nobody on price and rating at once; the other ` +
      `${numberWord(F.beaten_outright.length)} each have an arm that is both cheaper and rated higher.`,
    s,
  );
}

// ── 4. what "page text" means ─────────────────────────────────────────────────
// Sequential single hue: five shares of the same kind of thing. A categorical
// palette here would imply the columns are unrelated measures.
function chartStructure() {
  const COLS = [
    ["markdown_pct", "markdown"],
    ["headings_pct", "headings"],
    ["links_pct", "links"],
    ["images_pct", "images"],
    ["tables_pct", "tables"],
  ];
  const rows = ORDER.filter((k) => P[k].structure.markdown_pct !== null);
  const missing = ORDER.filter((k) => P[k].structure.markdown_pct === null);
  const cw = 96;
  const top = 34;
  const h = top + (rows.length + missing.length) * ROW + 32;

  let s = "";
  COLS.forEach(([, name], c) => (s += txt(GUT + c * cw + cw / 2, top - 12, "collab", name, "middle")));

  rows.forEach((k, i) => {
    const yy = top + i * ROW;
    s += txt(GUT - 16, yy + ROW / 2 + 4, "name", LABEL[k], "end");
    COLS.forEach(([field], c) => {
      const v = P[k].structure[field];
      const step = v >= 80 ? 4 : v >= 55 ? 3 : v >= 30 ? 2 : v >= 8 ? 1 : 0;
      s += `<rect x="${GUT + c * cw + 1}" y="${yy + 2}" width="${cw - 4}" height="${ROW - 5}" rx="2" class="cell s${step}"/>`;
      // Light text only on the darkest step. On the step below it the off-white
      // reads at 3.75:1 and the dark ink at 4.58:1, so that one keeps dark ink.
      s += txt(GUT + c * cw + cw / 2, yy + ROW / 2 + 4, `cellv${step >= 4 ? " on" : ""}`, share(v), "middle");
    });
  });
  // Serper gets a sentence, not a row of zeroes. It returns no page text at all,
  // and 0% five times would read as "extracts nothing well" — a different claim
  // about a different product.
  missing.forEach((k, i) => {
    const yy = top + (rows.length + i) * ROW;
    s += txt(GUT - 16, yy + ROW / 2 + 4, "name", LABEL[k], "end");
    s += `<rect x="${GUT + 1}" y="${yy + 2}" width="${COLS.length * cw - 4}" height="${ROW - 5}" rx="2" class="cell na"/>`;
    s += txt(GUT + 12, yy + ROW / 2 + 4, "cellna", "returns links and snippets only; never page content");
  });
  // The one chart where neither direction is the good one. A page full of links
  // is not a better page, it is a different product, and stamping "higher is
  // better" here would score a design decision as a defect.
  s += axisFooter(h - 12, "share of returned pages, percent", "darker is more, not better", GUT + COLS.length * cw);
  return frame(
    h,
    { id: "st", text: "Structural elements present in each provider's returned page text" },
    `Firecrawl and Tavily return full documents with links, images and headings. Exa and Parallel keep headings and drop links. ` +
      `Brave returns page text on 1% of results because its content is joined search snippets. Serper returns no page content at all.`,
    s,
  );
}

// ── 5. how long one search takes ──────────────────────────────────────────────
// The same dot-and-interval shape as the leaderboard, so the eye already knows
// how to read it. Log x, like the price chart, because the arms span two orders
// of magnitude: on a linear axis six providers pile onto the left edge to make
// room for one.
function chartLatency() {
  const rows = ORDER.filter((k) => d.latency[k]).sort((a, b) => d.latency[a].p50_ms - d.latency[b].p50_ms);
  const top = 46;
  const baseY = top + rows.length * ROW;
  const h = baseY + 80;
  const lo = Math.log10(500);
  const hi = Math.log10(90000);
  const x = (ms) => GUT + ((Math.log10(ms) - lo) / (hi - lo)) * (PLOT - GUT);

  let s = "";
  for (const t of [1000, 3000, 10000, 30000]) {
    s += `<line x1="${x(t)}" y1="${top - 8}" x2="${x(t)}" y2="${baseY - 10}" class="grid"/>`;
    s += txt(x(t), baseY + 8, "tick", secs(t), "middle");
  }
  s += axisFooter(baseY + 30, "seconds per search, log scale", "lower is better");
  s += txt(GUT, baseY + 50, "note", "The dot is the median search; the line runs out to the 90th percentile, the slowest one search in ten.");

  rows.forEach((k, i) => {
    const cy = top + i * ROW + ROW / 2 - 4;
    const l = d.latency[k];
    s += txt(GUT - 16, cy + 4, "name", LABEL[k], "end");
    s += `<line x1="${x(l.p50_ms)}" y1="${cy}" x2="${x(l.p90_ms)}" y2="${cy}" class="iv"/>`;
    s += `<line x1="${x(l.p90_ms)}" y1="${cy - 4}" x2="${x(l.p90_ms)}" y2="${cy + 4}" class="iv-cap"/>`;
    s += dot(x(l.p50_ms), cy, 5);
    s += txt(PLOT + 28, cy + 4, "num", secs(l.p50_ms));
    s += txt(PLOT + 74, cy + 4, "num dim", secs(l.p90_ms));
  });
  // Two number columns, so both get named, in the same spot the difficulty
  // chart names its drop column.
  s += txt(PLOT + 28, 14, "collab", "median, then the");
  s += txt(PLOT + 28, 30, "collab", "slowest 1 in 10");
  return frame(
    h,
    { id: "lt", text: "Search time by provider, median and 90th percentile" },
    `${LABEL[latFast]} is fastest at a median of ${secs(d.latency[latFast].p50_ms)} per search. ` +
      `${LABEL[cheapest]}, the cheapest arm, takes ${secs(d.latency[cheapest].p50_ms)}. ` +
      `${LABEL[latSlow]} is slowest at ${secs(d.latency[latSlow].p50_ms)}, with the slowest one search in ten at ` +
      `${secs(d.latency[latSlow].p90_ms)} or worse, and its sample includes the repair pass its one-request throttle forced.`,
    s,
  );
}

// ── table & tiles ─────────────────────────────────────────────────────────────
function tableRows() {
  return ORDER.map((k) => {
    const v = P[k];
    const noText = v.structure.markdown_pct === null;
    return (
      `<tr>` +
      `<th scope="row">${esc(LABEL[k])}</th>` +
      `<td class="n lead">${f3(v.set.mean)}<span class="pm">${pm(v.set.ci95)}</span></td>` +
      `<td class="n lead">${v.binary.rung3_pct}%</td>` +
      `<td class="n">${f3(v.page.mean)}</td>` +
      `<td class="n">${f3(v.difficulty.hard)}</td>` +
      `<td class="n">${money(v.cost.per_query_usd)}${v.cost.is_estimate ? '<span class="star" title="published rate, not a settled invoice">*</span>' : ""}</td>` +
      `<td class="n">$${v.cost.run_total_usd.toFixed(2)}</td>` +
      `<td class="n">${noText ? '<span class="na">n/a</span>' : share(v.truncation.pct)}</td>` +
      `<td class="n">${d.latency[k] ? secs(d.latency[k].p50_ms) : '<span class="na">n/a</span>'}</td>` +
      `</tr>`
    );
  }).join("\n");
}


// ── what each provider was actually asked for ────────────────────────────────
// Read off core/adapters/. Published because "we tested provider X" means
// nothing without the tier: a cheap default would make a good product look bad,
// and every knob here is turned up. Serper is the single deliberate exception
// and says so in its own row.
const SETTINGS = [
  ["perplexity", "Search API /search", "search_context_size: high", "Excerpts, their maximum; there is no full-page mode"],
  ["brave", "Search API, web endpoint", "extra_snippets: true", "Snippets only, by architecture; never a page body"],
  ["parallel", "Search API, advanced tier", "mode: advanced, 6,000-char excerpts", "Dense excerpts; cannot be turned off"],
  ["exa", "/search with inline contents", "contents: { text: true }", "Page text at Exa's own default length"],
  ["tavily", "Search API /search", "search_depth: advanced, include_raw_content: markdown", "Full page markdown"],
  ["serper", "Google Search API /search", "none; their scrape endpoint was not called", "Links and snippets only. The one deliberate downgrade"],
  ["firecrawl", "v2 /search with scrape", 'scrapeOptions: { formats: ["markdown"] }', "Full page markdown"],
  ["bright_data", "SERP API + Web Unlocker", "data_format: markdown, via a second paid product", `Full page markdown, on the ${Math.round(d.cited.extraction_yield_pct.bright_data)}% of URLs the unlocker returned`],
]
  .map(
    ([k, product, setting, out]) =>
      `<tr><th scope="row">${esc(LABEL[k])}</th><td class="prose">${esc(product)}</td><td>${esc(setting)}</td><td class="prose">${esc(out)}</td></tr>`,
  )
  .join("\n");

// ── the methodology tab ───────────────────────────────────────────────────────
const rungRows = (rungs) =>
  rungs
    .map(
      (r) =>
        `<div class="rung"><div class="n">${r.rung}</div><div class="nm">${esc(r.name)}</div><div class="mg">${esc(r.meaning)}</div></div>`,
    )
    .join("\n");


// Which arm is fastest and which slowest, read off the data instead of named
// here, so a re-run that reorders them cannot leave the sentence behind.
const byLatency = ORDER.filter((k) => d.latency[k]).sort((a, b) => d.latency[a].p50_ms - d.latency[b].p50_ms);
const latFast = byLatency[0];
const latSlow = byLatency[byLatency.length - 1];
// The cheapest arm, read off the data for the same reason: the speed section
// points out that cheap and fast are different providers, and a re-run that
// changed either should change the sentence with it.
const cheapest = ORDER.reduce((a, b) => (P[a].cost.per_query_usd <= P[b].cost.per_query_usd ? a : b));

// ── assemble ──────────────────────────────────────────────────────────────────
const REPL = {
  __CHART_LEADERBOARD__: chartLeaderboard(),
  __CHART_DIFFICULTY__: chartDifficulty(),
  __CHART_PRICE__: chartPrice(),
  __CHART_STRUCTURE__: chartStructure(),
  __CHART_LATENCY__: chartLatency(),
  __TABLE_ROWS__: tableRows(),
  __PROVIDER_SETTINGS__: SETTINGS,
  __PPX_RUNG3__: String(P.perplexity.binary.rung3_pct),
  __SERPER_PRICE__: money(P.serper.cost.per_query_usd),
  __TAVILY_MD__: String(Math.round(P.tavily.structure.markdown_pct)),
  __EXA_HEADINGS__: String(Math.round(P.exa.structure.headings_pct)),
  __EXA_LINKS__: String(Math.round(P.exa.structure.links_pct)),
  __BRAVE_MD__: String(Math.round(P.brave.structure.markdown_pct)),
  __BD_RUNG3__: String(P.bright_data.binary.rung3_pct),
  __N_QUESTIONS__: String(d.counts.questions),
  __N_RATINGS__: d.counts.page_ratings_scored.toLocaleString("en-US"),
  __N_BASE__: String(d.counts.base),
  __N_HARD__: String(d.counts.hard),
  __N_UNANS__: String(d.counts.unanswerable),
  __SPREAD_BASE__: String(d.spread.base),
  __SPREAD_HARD__: String(d.spread.hard),
  __SPREAD_PCT__: String(d.spread.widened_pct),
  __KAPPA_LO__: d.agreement.reduce((a, x) => Math.min(a, x.kappa), 1).toFixed(2),
  __KAPPA_HI__: d.agreement.reduce((a, x) => Math.max(a, x.kappa), 0).toFixed(2),
  __VAR_JUDGE__: (d.variance_shares.judge * 100).toFixed(1),
  __VAR_PROVIDER__: (d.variance_shares.provider * 100).toFixed(1),
  __OVERLAP_ONE__: String(d.overlap.from_one_provider_pct),
  // What pooling actually saved: the share of question-page pairs that never
  // needed their own judge call, because some other arm had already returned
  // that page. This is the honest reason the run fit in a hobby budget.
  __LAT_FAST__: LABEL[latFast],
  __LAT_FAST_P50__: secs(d.latency[latFast].p50_ms),
  __LAT_SLOW__: LABEL[latSlow],
  __LAT_SLOW_P50__: secs(d.latency[latSlow].p50_ms),
  __LAT_SLOW_P90__: secs(d.latency[latSlow].p90_ms),
  __CHEAPEST__: LABEL[cheapest],
  // How far clear the fastest arm is of the next one down. Derived rather than
  // typed, because "three times quicker" is a claim about two medians and both
  // of them move when the run does.
  __LAT_FAST_LEAD__: String(
    Math.round(
      Math.min(...ORDER.filter((k) => k !== latFast).map((k) => d.latency[k].p50_ms)) / d.latency[latFast].p50_ms,
    ),
  ),
  __PARALLEL_PRICE__: money(P.parallel.cost.per_query_usd),
  __PARALLEL_HEADINGS__: String(Math.round(P.parallel.structure.headings_pct)),
  __PARALLEL_LINKS__: String(Math.round(P.parallel.structure.links_pct)),
  __CHEAPEST_P50__: secs(d.latency[cheapest].p50_ms),
  __POOL_SAVED_PCT__: String(Math.round(((d.counts.pairs - d.counts.unique_pairs) / d.counts.pairs) * 100)),
  // The complement of from_one_provider_pct: the share of pages more than one
  // arm returned, which is exactly the share pooling grades on somebody else's
  // extraction. Derived rather than typed so it cannot drift from its own half.
  __OVERLAP_MULTI_PCT__: String(Math.round((d.overlap.from_two_or_more / d.overlap.n_pages) * 100)),
  __OVERLAP_ALL__: String(d.overlap.from_all_providers),
  __UNIQUE_PAIRS__: d.counts.unique_pairs.toLocaleString("en-US"),
  __N_PAIRS__: d.counts.pairs.toLocaleString("en-US"),
  __COST_TOTAL__: d.cost_total_usd.toFixed(2),
  __TRUNC_LIMIT__: String(P.firecrawl.truncation.limit_chars),
  __TRUNC_FIRECRAWL__: String(Math.round(P.firecrawl.truncation.pct)),
  __TRUNC_PERPLEXITY__: String(Math.round(P.perplexity.truncation.pct)),
  __GENERATED__: new Date(d.generated_at).toISOString().slice(0, 10),
  // What the page stamps itself with. `generated_at` is when this script last
  // ran, which drifts every rebuild and would let a year-old run advertise
  // today's date; the run window is a fact about the run and never moves.
  __FETCHED__: fetchedRange(d.run_window),
  __CODE_SHA__: d.code_sha ?? "unreleased",
  // Figures the prose cites. Derived ones first, then the two that come from
  // outside the run and carry their source in docs/report-data.json.
  __KEYLESS_FAILS__: numberWord(d.cited.keyless_attempts),
  __FC_CREDITS__: d.recorded.firecrawl_credits.value.toLocaleString("en-US"),
  __FC_CREDIT_PCT__: String(
    Math.round((d.recorded.firecrawl_credits.value / d.recorded.firecrawl_credits.monthly_allowance) * 100),
  ),
  __FC_CREDIT_USD__: String(d.recorded.firecrawl_credits.usd),
  __WASTED_USD__: String(d.recorded.wasted_usd.value),
  // Derived, not recorded: the number of questions Tavily got through before its
  // plan's quota stopped it is exactly its row count on the run's first day.
  __TAVILY_QUOTA_Q__: String(d.cited.first_day_rows.tavily),
  __ARMS_DAY1__: numberWord(d.cited.arms_finished_first_day),
  // How many fetches came back clean, out of how many were attempted. The
  // denominator is every question put to every arm, which is the only total the
  // numerator can honestly be read against.
  __SEARCH_CLEAN__: d.counts.searches.toLocaleString("en-US"),
  __SEARCH_TOTAL__: (d.counts.questions * d.counts.providers).toLocaleString("en-US"),
  __BASE__: BASE,
  __REPO__: REPO,
  __NUM_SOURCES__: String(NUM_SOURCES.default),
  __PAGE_RUNGS__: rungRows(RELEVANCE_RUNGS),
  __SET_RUNGS__: rungRows(SET_RUNGS),
  __STYLE__: fs.readFileSync("site/style.css", "utf8").trimEnd() + "\n" + NAV_CSS,
};

// Results and how-to-pick share the front page — the picks are the payoff of
// the ranking. The method has its own URL because it is the thing people cite.
// Each page gets its own nav with itself marked current; the nav is a per-page
// extra rather than a REPL entry so the orphan check below stays about numbers.
const navMeta = { fetched: REPL.__FETCHED__, sha: REPL.__CODE_SHA__ };
const PAGES = [
  ["site/report.html", "docs/index.html", { __NAV__: navHtml("results", navMeta) }],
  ["site/methodology.html", "docs/methodology/index.html", { __NAV__: navHtml("methodology", navMeta) }],
];

const usedSomewhere = new Set();
for (const [tpl, out, extra] of PAGES) {
  let html = fs.readFileSync(tpl, "utf8");
  for (const [key, val] of Object.entries({ ...extra, ...REPL })) {
    if (html.includes(key) && key in REPL) usedSomewhere.add(key);
    html = html.replaceAll(key, () => val);
  }
  const left = html.match(/__[A-Z_]+__/g);
  if (left) {
    console.error(`${out}: unfilled tokens — ${[...new Set(left)].join(", ")}`);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html);
  console.log(`${out} — ${(fs.statSync(out).size / 1024).toFixed(1)} KB`);
}

// A token no page uses is a number that quietly left the site.
const orphans = Object.keys(REPL).filter((k) => !usedSomewhere.has(k));
if (orphans.length) {
  console.error(`\nNo page uses: ${orphans.join(", ")}. Wire them in or drop them.`);
  process.exit(1);
}

// Three URLs and no other discovery surface, so the sitemap is how a crawler
// learns /methodology/ exists. Written here so it can never list an unbuilt page.
const sitemap =
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  [BASE, `${BASE}methodology/`, `${BASE}explorer/`]
    .map((u) => `  <url><loc>${u}</loc><lastmod>${REPL.__GENERATED__}</lastmod></url>`)
    .join("\n") +
  `\n</urlset>\n`;
fs.writeFileSync("docs/sitemap.xml", sitemap);

// /method/ was this page's address until it was renamed. Anything already
// linking there — a DM, a post, somebody's notes — should still arrive rather
// than 404, so the old path keeps a stub that forwards and tells a crawler the
// new URL is the real one. Emitted here, because nothing under docs/ is hand-written.
const redirect = `<!doctype html>
<meta charset="utf-8">
<title>Moved to ${BASE}methodology/</title>
<link rel="canonical" href="${BASE}methodology/">
<meta http-equiv="refresh" content="0; url=${BASE}methodology/">
<p>This page is now at <a href="${BASE}methodology/">${BASE}methodology/</a>.</p>
`;
fs.mkdirSync("docs/method", { recursive: true });
fs.writeFileSync("docs/method/index.html", redirect);

console.log(`from ${DATA} (${d.run}, ${REPL.__GENERATED__})`);
