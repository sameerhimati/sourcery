#!/usr/bin/env node
// Build the public results page from the run's own derived numbers.
//
// Every figure in a chart, a tile or the table comes from docs/report-data.json,
// so a chart and the number beside it cannot disagree. If one of those looks
// wrong it is wrong upstream, in scripts/build-report-data.mjs, and fixing it
// there fixes the page.
//
// The prose is not all generated, and the earlier version of this comment
// claiming otherwise was wrong. A few figures in the templates' running text —
// Firecrawl's credit burn, the captcha failures, the YouTube share — are
// transcribed from docs/run-2-findings.md because nothing derives them yet.
// Anything quantitative that a reader would check should move into the data
// file rather than being typed into a sentence.
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
// Imported, not transcribed: the rubrics and rung names the methodology page
// publishes are the ones the run actually used. A copy would drift.
import { RELEVANCE_RUNGS, SET_RUNGS, NUM_SOURCES } from "../core/controls.ts";

const DATA = process.argv[2] ?? "docs/report-data.json";

// Where the pages link to each other. Absolute, because these files are served
// from Pages *and* published as standalone artifacts, and a relative link only
// works in one of those.
const BASE = "https://sameerhimati.com/sourcery/";
const REPO = "https://github.com/sameerhimati/sourcery";

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
const f3 = (n) => n.toFixed(3);
const money = (n) => `$${n.toFixed(4)}`.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");

// ── shared chart geometry ─────────────────────────────────────────────────────
// One width, one gutter, one row height across every chart, so a provider sits
// on the same line in all four and the eye can track it down the page.
const W = 720;
const GUT = 112; // right edge of the provider-name column
const PLOT = 452; // right edge of the plot area
const ROW = 34;

const txt = (x, y, cls, s, anchor) =>
  `<text x="${x}" y="${y}" class="${cls}"${anchor ? ` text-anchor="${anchor}"` : ""}>${esc(s)}</text>`;

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
  const h = baseY + 40;
  const dom = [1.8, 2.9];
  const x = (v) => GUT + ((v - dom[0]) / (dom[1] - dom[0])) * (PLOT - GUT);

  let s = "";
  for (const t of [2.0, 2.2, 2.4, 2.6, 2.8]) {
    s += `<line x1="${x(t)}" y1="${top - 8}" x2="${x(t)}" y2="${baseY - 10}" class="grid"/>`;
    s += txt(x(t), baseY + 8, "tick", t.toFixed(1), "middle");
  }

  rows.forEach((r, i) => {
    const cy = top + i * ROW + ROW / 2 - 4;
    s += txt(GUT - 16, cy + 4, "name", LABEL[r.k], "end");
    s += `<line x1="${x(r.mean - r.ci95)}" y1="${cy}" x2="${x(r.mean + r.ci95)}" y2="${cy}" class="iv"/>`;
    s += `<line x1="${x(r.mean - r.ci95)}" y1="${cy - 4}" x2="${x(r.mean - r.ci95)}" y2="${cy + 4}" class="iv-cap"/>`;
    s += `<line x1="${x(r.mean + r.ci95)}" y1="${cy - 4}" x2="${x(r.mean + r.ci95)}" y2="${cy + 4}" class="iv-cap"/>`;
    s += `<circle cx="${x(r.mean)}" cy="${cy}" r="5" class="est"/>`;
    s += txt(PLOT + 28, cy + 4, "num", f3(r.mean));
    s += txt(PLOT + 74, cy + 4, "num dim", `± ${r.ci95.toFixed(3)}`);
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
  const h = baseY + 40;
  const dom = [1.2, 2.44];
  const x = (v) => GUT + ((v - dom[0]) / (dom[1] - dom[0])) * (PLOT - GUT);

  // Two series, so a legend is not optional. It sits on its own line above the
  // plot, which is why the ticks are at the bottom.
  let s =
    `<circle cx="${GUT + 5}" cy="18" r="5" class="est"/>` +
    txt(GUT + 16, 22, "legend", `${d.counts.base} base questions`) +
    `<circle cx="${GUT + 178}" cy="18" r="5" class="est hollow"/>` +
    txt(GUT + 189, 22, "legend", `${d.counts.hard} written to be hard`);

  for (const t of [1.25, 1.5, 1.75, 2.0, 2.25]) {
    s += `<line x1="${x(t)}" y1="${top - 8}" x2="${x(t)}" y2="${baseY - 10}" class="grid"/>`;
    s += txt(x(t), baseY + 8, "tick", t.toFixed(2), "middle");
  }

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
    s += `<circle cx="${bx2}" cy="${cy}" r="5" class="est"/>`;
    s += `<circle cx="${hx}" cy="${cy}" r="5" class="est hollow"/>`;
    const drop = r.base - r.hard;
    s += txt(PLOT + 28, cy + 4, drop > 0.15 ? "num hot" : "num dim", drop > 0.005 ? `− ${drop.toFixed(3)}` : "no drop");
  });
  s += txt(PLOT + 28, 22, "collab", "change");
  return frame(
    h,
    { id: "df", text: "Base questions against hard questions, by provider" },
    `Perplexity and Parallel lose almost nothing between the base and hard halves. Tavily, Firecrawl and Bright Data ` +
      `lose around a quarter of a rung, so the spread between best and worst widens by ${d.spread.widened_pct}%.`,
    s,
  );
}

// ── 3. price against quality ──────────────────────────────────────────────────
function chartPrice() {
  const h = 356;
  const L = 96;
  const R = 636;
  const T = 30;
  const B = 288;
  const lo = Math.log10(0.0008);
  const hi = Math.log10(0.13);
  const x = (v) => L + ((Math.log10(v) - lo) / (hi - lo)) * (R - L);
  const y = (v) => B - ((v - 1.85) / (2.85 - 1.85)) * (B - T);

  let s = "";
  for (const t of [2.0, 2.25, 2.5, 2.75]) {
    s += `<line x1="${L}" y1="${y(t)}" x2="${R}" y2="${y(t)}" class="grid"/>`;
    s += txt(L - 14, y(t) + 4, "tick", t.toFixed(2), "end");
  }
  for (const t of [0.001, 0.005, 0.01, 0.05, 0.1]) {
    s += txt(x(t), B + 22, "tick", `$${t}`, "middle");
  }
  s += `<line x1="${L}" y1="${B}" x2="${R}" y2="${B}" class="axis"/>`;
  s += txt(L, B + 44, "collab", "cost per query, log scale");
  s += `<text class="collab" transform="translate(26 ${(T + B) / 2}) rotate(-90)" text-anchor="middle">set rating</text>`;

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
    s += `<circle cx="${px}" cy="${py}" r="5.5" class="${c.is_estimate ? "est hollow" : "est"}"/>`;
    const [dx, dy] = nudge[k];
    s += txt(px + dx, py + dy, "ptname", LABEL[k], dx < 0 ? "end" : "start");
  }
  return frame(
    h,
    { id: "pr", text: "Set rating against cost per query" },
    `Cost runs from ${money(P.serper.cost.per_query_usd)} to ${money(P.firecrawl.cost.per_query_usd)} a query, ` +
      `a ${Math.round(P.firecrawl.cost.per_query_usd / P.serper.cost.per_query_usd)}-fold spread, and the three arms on the cheapest ` +
      `per-query tier take three of the top four places while the outright cheapest places sixth. Firecrawl is the most expensive and seventh on quality.`,
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
      s += txt(GUT + c * cw + cw / 2, yy + ROW / 2 + 4, `cellv${step >= 4 ? " on" : ""}`, `${Math.round(v)}%`, "middle");
    });
  });
  // Serper gets a sentence, not a row of zeroes. It returns no page text at all,
  // and 0% five times would read as "extracts nothing well" — a different claim
  // about a different product.
  missing.forEach((k, i) => {
    const yy = top + (rows.length + i) * ROW;
    s += txt(GUT - 16, yy + ROW / 2 + 4, "name", LABEL[k], "end");
    s += `<rect x="${GUT + 1}" y="${yy + 2}" width="${COLS.length * cw - 4}" height="${ROW - 5}" rx="2" class="cell na"/>`;
    s += txt(GUT + 12, yy + ROW / 2 + 4, "cellna", "returns links and snippets only — never page content");
  });
  return frame(
    h,
    { id: "st", text: "Structural elements present in each provider's returned page text" },
    `Firecrawl and Tavily return full documents with links, images and headings. Exa and Parallel keep headings and drop links. ` +
      `Brave returns page text on 1% of results because its content is joined search snippets. Serper returns no page content at all.`,
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
      `<td class="n lead">${f3(v.set.mean)}<span class="pm">± ${v.set.ci95.toFixed(3)}</span></td>` +
      `<td class="n lead">${v.binary.rung3_pct}%</td>` +
      `<td class="n">${f3(v.page.mean)}</td>` +
      `<td class="n">${f3(v.difficulty.hard)}</td>` +
      `<td class="n">${money(v.cost.per_query_usd)}${v.cost.is_estimate ? '<span class="star" title="published rate, not a settled invoice">*</span>' : ""}</td>` +
      `<td class="n">$${v.cost.run_total_usd.toFixed(2)}</td>` +
      `<td class="n">${noText ? '<span class="na">n/a</span>' : `${Math.round(v.truncation.pct)}%`}</td>` +
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
  ["perplexity", "Search API /search", "search_context_size: high", "Excerpts — their maximum; there is no full-page mode"],
  ["brave", "Search API, web endpoint", "extra_snippets: true", "Snippets only, by architecture — never a page body"],
  ["parallel", "Search API, advanced tier", "mode: advanced, 6,000-char excerpts", "Dense excerpts; cannot be turned off"],
  ["exa", "/search with inline contents", "contents: { text: true }", "Page text at Exa's own default length"],
  ["tavily", "Search API /search", "search_depth: advanced, include_raw_content: markdown", "Full page markdown"],
  ["serper", "Google Search API /search", "none — their scrape endpoint was not called", "Links and snippets only. The one deliberate downgrade"],
  ["firecrawl", "v2 /search with scrape", 'scrapeOptions: { formats: ["markdown"] }', "Full page markdown"],
  ["bright_data", "SERP API + Web Unlocker", "data_format: markdown, via a second paid product", "Full page markdown, on the ~47% of URLs the unlocker returned"],
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


// ── assemble ──────────────────────────────────────────────────────────────────
const REPL = {
  __CHART_LEADERBOARD__: chartLeaderboard(),
  __CHART_DIFFICULTY__: chartDifficulty(),
  __CHART_PRICE__: chartPrice(),
  __CHART_STRUCTURE__: chartStructure(),
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
  __OVERLAP_ALL__: String(d.overlap.from_all_providers),
  __UNIQUE_PAIRS__: d.counts.unique_pairs.toLocaleString("en-US"),
  __COST_TOTAL__: d.cost_total_usd.toFixed(2),
  __TRUNC_LIMIT__: String(P.firecrawl.truncation.limit_chars),
  __TRUNC_FIRECRAWL__: String(Math.round(P.firecrawl.truncation.pct)),
  __TRUNC_PERPLEXITY__: String(Math.round(P.perplexity.truncation.pct)),
  __GENERATED__: new Date(d.generated_at).toISOString().slice(0, 10),
  __BASE__: BASE,
  __REPO__: REPO,
  __NUM_SOURCES__: String(NUM_SOURCES.default),
  __PAGE_RUNGS__: rungRows(RELEVANCE_RUNGS),
  __SET_RUNGS__: rungRows(SET_RUNGS),
  __STYLE__: fs.readFileSync("docs/report-style.css", "utf8").trimEnd(),
};

// One page, two tabs. The method used to be a second file; splitting a report
// from its method means most readers only ever see one of them.
const PAGES = [["docs/report-template.html", "docs/index.html"]];

const usedSomewhere = new Set();
for (const [tpl, out] of PAGES) {
  let html = fs.readFileSync(tpl, "utf8");
  for (const [key, val] of Object.entries(REPL)) {
    if (html.includes(key)) usedSomewhere.add(key);
    html = html.replaceAll(key, () => val);
  }
  const left = html.match(/__[A-Z_]+__/g);
  if (left) {
    console.error(`${out}: unfilled tokens — ${[...new Set(left)].join(", ")}`);
    process.exit(1);
  }
  fs.writeFileSync(out, html);
  console.log(`${out} — ${(fs.statSync(out).size / 1024).toFixed(1)} KB`);
}

// A token no page uses is a number that quietly left the site.
const orphans = Object.keys(REPL).filter((k) => !usedSomewhere.has(k));
if (orphans.length) {
  console.error(`\nNo page uses: ${orphans.join(", ")}. Wire them in or drop them.`);
  process.exit(1);
}
console.log(`from ${DATA} (${d.run}, ${REPL.__GENERATED__})`);
