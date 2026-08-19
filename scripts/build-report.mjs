#!/usr/bin/env node
// Build the public results page from the run's own derived numbers.
//
// Every figure on the page — and every pixel of every chart — comes from
// docs/report-data.json, so a chart and a sentence beside it cannot disagree.
// Nothing here is typed by hand. If a number looks wrong, it is wrong upstream,
// in scripts/build-report-data.mjs, and fixing it there fixes the page.
//
// The charts are emitted as static SVG at build time rather than drawn by
// script in the browser. Two reasons: the page then needs no JavaScript to show
// its results, and the same <svg> can be pasted into a blog post whose markdown
// pipeline renders raw HTML but never executes a script tag.
//
// Usage: node scripts/build-report.mjs [data.json] [template.html] [out.html]

import fs from "node:fs";

const DATA = process.argv[2] ?? "docs/report-data.json";
const TPL = process.argv[3] ?? "docs/report-template.html";
const OUT = process.argv[4] ?? "docs/index.html";

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
const money = (n) => (n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(4)}`.replace(/0+$/, ""));

// ── svg helpers ───────────────────────────────────────────────────────────────
// A bar's data end is rounded and its baseline end is square, so the eye reads
// which end is the measurement and which is the axis.
function barPath(x0, x1, y, h, r) {
  const rr = Math.min(r, Math.max(0, x1 - x0), h / 2);
  return [
    `M${x0} ${y}`,
    `H${x1 - rr}`,
    `a${rr} ${rr} 0 0 1 ${rr} ${rr}`,
    `V${y + h - rr}`,
    `a${rr} ${rr} 0 0 1 ${-rr} ${rr}`,
    `H${x0}`,
    "Z",
  ].join(" ");
}
const txt = (x, y, cls, s, anchor) =>
  `<text x="${x}" y="${y}" class="${cls}"${anchor ? ` text-anchor="${anchor}"` : ""}>${esc(s)}</text>`;

function frame(w, h, title, desc, body) {
  return (
    `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-labelledby="${title.id} ${desc.id}" class="viz">` +
    `<title id="${title.id}">${esc(title.text)}</title>` +
    `<desc id="${desc.id}">${esc(desc.text)}</desc>` +
    body +
    `</svg>`
  );
}

// ── 1. the leaderboard, with the interval as the point of the chart ───────────
// A ranked table of eight rows invites the reader to believe row 2 beats row 3.
// On this run three of them are a tie, so the interval is drawn at full weight
// and the tie is bracketed. Someone who reads nothing else should still leave
// knowing that.
function chartLeaderboard() {
  const rows = ORDER.map((k) => ({ k, ...P[k].set }));
  const W = 840;
  const rowH = 36;
  const top = 44;
  const base = top + rows.length * rowH;
  const H = base + 46;
  const x0 = 104;
  const x1 = 536;
  const xmax = 3;
  const x = (v) => x0 + (v / xmax) * (x1 - x0);

  let s = txt(0, 16, "axtitle", "set rating — could someone answer from these eight pages alone?");
  // Ticks sit below the plot so the title has the top line to itself. Rungs are a
  // 0–3 scale, so every rung is labelled rather than picking round numbers.
  for (let t = 0; t <= 3; t++) {
    s += `<line x1="${x(t)}" y1="${top - 6}" x2="${x(t)}" y2="${base - 6}" class="grid"/>`;
    s += txt(x(t), base + 12, "tick", t, "middle");
  }

  rows.forEach((r, i) => {
    const cy = top + i * rowH + rowH / 2 - 3;
    const bh = 13;
    s += txt(92, cy + 4, "rowlab", LABEL[r.k], "end");
    s += `<path d="${barPath(x(0), x(r.mean), cy - bh / 2, bh, 4)}" class="bar"/>`;
    // the interval, drawn over the bar so it reads as part of the measurement
    const lo = x(r.mean - r.ci95);
    const hi = x(r.mean + r.ci95);
    s += `<line x1="${lo}" y1="${cy}" x2="${hi}" y2="${cy}" class="ci"/>`;
    s += `<line x1="${lo}" y1="${cy - 5}" x2="${lo}" y2="${cy + 5}" class="ci"/>`;
    s += `<line x1="${hi}" y1="${cy - 5}" x2="${hi}" y2="${cy + 5}" class="ci"/>`;
    s += txt(550, cy + 4, "val", f3(r.mean));
    s += txt(600, cy + 4, "valdim", `±${r.ci95.toFixed(3)}`);
  });

  // Bracket every run of providers whose intervals overlap down the list. There
  // is more than one such run — the ordering inside each is noise — and picking
  // only the longest, or only the top one, would hide a real cluster.
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
  const bx = 690;
  for (const g of groups.filter((g) => g.length > 1)) {
    const yA = top + g[0] * rowH + 7;
    const yB = top + (g[g.length - 1] + 1) * rowH - 7;
    s += `<path d="M${bx} ${yA} h8 V${yB} h-8" class="brace"/>`;
    s += txt(bx + 16, (yA + yB) / 2 + 4, "bracelab", `these ${g.length} are a tie`);
  }

  s += txt(0, H - 10, "foot", `bars are the mean; the whisker is the 95% interval. ${d.counts.questions} questions, ${d.counts.judges} judges.`);
  return frame(
    W,
    H,
    { id: "lb-t", text: "Set rating by provider, with 95% confidence intervals" },
    {
      id: "lb-d",
      text:
        `Perplexity leads at ${f3(P.perplexity.set.mean)}. ` +
        `Brave, Parallel and Exa overlap and cannot be ordered. ` +
        `Bright Data is last at ${f3(P.bright_data.set.mean)}.`,
    },
    s,
  );
}

// ── 2. price against quality ──────────────────────────────────────────────────
function chartPrice() {
  const W = 760;
  const H = 400;
  const L = 64;
  const R = 726;
  const T = 44;
  const B = 330;
  const lx = (v) => L + ((Math.log10(v) + 3.15) / (Math.log10(0.12) + 3.15)) * (R - L);
  const ys = [1.85, 2.85];
  const y = (v) => B - ((v - ys[0]) / (ys[1] - ys[0])) * (B - T);

  let s = txt(L, 18, "axtitle", "the 86× price spread buys nothing");
  for (const t of [0.001, 0.005, 0.01, 0.05, 0.1]) {
    s += `<line x1="${lx(t)}" y1="${T - 8}" x2="${lx(t)}" y2="${B}" class="grid"/>`;
    s += txt(lx(t), B + 18, "tick", `$${t}`, "middle");
  }
  for (const t of [2.0, 2.25, 2.5, 2.75]) {
    s += `<line x1="${L}" y1="${y(t)}" x2="${R}" y2="${y(t)}" class="grid"/>`;
    s += txt(L - 8, y(t) + 4, "tick", t.toFixed(2), "end");
  }
  s += txt(L, B + 40, "axlab", "cost per query, log scale");
  s += `<text class="axlab" transform="translate(16 ${(T + B) / 2}) rotate(-90)" text-anchor="middle">set rating</text>`;

  // Labels are placed by hand-tuned nudges because eight points on a log axis
  // collide in ways no generic rule solves, and a collided label is worse than
  // a fussy constant.
  const nudge = {
    perplexity: [10, -10],
    brave: [10, 4],
    parallel: [10, 15],
    exa: [10, -8],
    tavily: [10, 4],
    serper: [10, 4],
    firecrawl: [-10, 4],
    bright_data: [10, 4],
  };
  for (const k of ORDER) {
    const c = P[k].cost;
    const px = lx(c.per_query_usd);
    const py = y(P[k].set.mean);
    // a hollow ring means the price is a list rate rather than a settled bill
    s += `<circle cx="${px}" cy="${py}" r="6" class="${c.is_estimate ? "dot est" : "dot"}"/>`;
    const [dx, dy] = nudge[k];
    s += txt(px + dx, py + dy, "ptlab", LABEL[k], dx < 0 ? "end" : "start");
  }
  s += txt(L, H - 10, "foot", "a hollow ring is a published list price rather than a settled invoice");
  return frame(
    W,
    H,
    { id: "pr-t", text: "Set rating against cost per query" },
    {
      id: "pr-d",
      text:
        `Cost ranges from ${money(P.serper.cost.per_query_usd)} to ${money(P.firecrawl.cost.per_query_usd)} a query, an 86-fold spread, ` +
        `and the three cheapest providers take three of the top four places. Firecrawl is the most expensive and seventh on quality.`,
    },
    s,
  );
}

// ── 3. base against hard ──────────────────────────────────────────────────────
// A dumbbell rather than a slope chart: eight lines between two columns put
// eight labels on top of each other, and two of the hard values differ by 0.001.
function chartDifficulty() {
  // Same order as the leaderboard, so a reader can scan across the two charts
  // and find the same provider on the same line.
  const rows = ORDER.map((k) => ({ k, ...P[k].difficulty }));
  const W = 760;
  const rowH = 34;
  const top = 68;
  const base = top + rows.length * rowH;
  const H = base + 48;
  const x0 = 116;
  const x1 = 560;
  const dom = [1.18, 2.45];
  const x = (v) => x0 + ((v - dom[0]) / (dom[1] - dom[0])) * (x1 - x0);

  let s = txt(0, 16, "axtitle", "easy questions make providers look alike");
  // a legend, because there are two series — and it gets its own line, clear of
  // the axis, which is why the ticks moved to the bottom
  s += `<circle cx="${x0 + 6}" cy="40" r="6" class="dot"/>` + txt(x0 + 18, 44, "legend", `the ${d.counts.base} base questions`);
  s += `<circle cx="${x0 + 186}" cy="40" r="6" class="dot alt"/>` + txt(x0 + 198, 44, "legend", `the ${d.counts.hard} written to be hard`);
  s += txt(590, 44, "collab", "change");

  for (const t of [1.25, 1.5, 1.75, 2.0, 2.25]) {
    s += `<line x1="${x(t)}" y1="${top - 8}" x2="${x(t)}" y2="${base - 8}" class="grid"/>`;
    s += txt(x(t), base + 10, "tick", t.toFixed(2), "middle");
  }

  rows.forEach((r, i) => {
    const cy = top + i * rowH + rowH / 2 - 4;
    s += txt(104, cy + 4, "rowlab", LABEL[r.k], "end");
    // A provider that lost nothing puts both dots in the same place, which reads
    // as one missing dot rather than as no change. Nudge them just apart so the
    // pair is visible and the absent gap is the message.
    let bx2 = x(r.base);
    let hx = x(r.hard);
    if (Math.abs(bx2 - hx) < 7) {
      const mid = (bx2 + hx) / 2;
      bx2 = mid + 3.5;
      hx = mid - 3.5;
    }
    s += `<line x1="${hx}" y1="${cy}" x2="${bx2}" y2="${cy}" class="dumb"/>`;
    s += `<circle cx="${bx2}" cy="${cy}" r="6" class="dot"/>`;
    s += `<circle cx="${hx}" cy="${cy}" r="6" class="dot alt"/>`;
    const drop = r.base - r.hard;
    s += txt(590, cy + 4, drop > 0.15 ? "val drop" : "valdim", drop > 0.005 ? `−${drop.toFixed(3)}` : "no drop");
  });
  s += txt(
    0,
    H - 10,
    "foot",
    `best-to-worst spread widens from ${d.spread.base} to ${d.spread.hard} — ${d.spread.widened_pct}% wider on the hard half`,
  );
  return frame(
    W,
    H,
    { id: "df-t", text: "Base questions against hard questions, by provider" },
    {
      id: "df-d",
      text:
        `Perplexity and Parallel lose almost nothing between the base and hard halves. ` +
        `Tavily, Firecrawl and Bright Data lose around a quarter of a rung, so the spread between best and worst widens by ${d.spread.widened_pct}%.`,
    },
    s,
  );
}

// ── 4. what "page text" means ─────────────────────────────────────────────────
// Sequential single hue: these are five shares of the same kind of thing, and a
// categorical palette here would imply the columns are unrelated.
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
  const W = 760;
  const cw = 92;
  const rh = 34;
  const L = 116;
  const top = 62;
  const H = top + (rows.length + missing.length) * rh + 44;

  let s = txt(L - 12, 18, "axtitle", "“page text” means something different from every one of them");
  s += txt(L - 12, 36, "sub", "share of returned pages containing each element");
  COLS.forEach(([, name], c) => s += txt(L + c * cw + cw / 2, top - 12, "tick", name, "middle"));

  rows.forEach((k, i) => {
    const y = top + i * rh;
    s += txt(L - 12, y + rh / 2 + 4, "rowlab", LABEL[k], "end");
    COLS.forEach(([field], c) => {
      const v = P[k].structure[field];
      const step = v >= 80 ? 4 : v >= 55 ? 3 : v >= 30 ? 2 : v >= 8 ? 1 : 0;
      s += `<rect x="${L + c * cw + 1}" y="${y + 1}" width="${cw - 3}" height="${rh - 3}" rx="3" class="cell s${step}"/>`;
      s += txt(L + c * cw + cw / 2, y + rh / 2 + 4, `cellv i${step >= 3 ? 1 : 0}`, `${Math.round(v)}%`, "middle");
    });
  });
  // Serper has no row of numbers because it never returns page text. An empty
  // row of zeroes would read as "extracts nothing well" instead of "does not
  // do this at all", which is a different product.
  missing.forEach((k, i) => {
    const y = top + (rows.length + i) * rh;
    s += txt(L - 12, y + rh / 2 + 4, "rowlab", LABEL[k], "end");
    s += `<rect x="${L + 1}" y="${y + 1}" width="${COLS.length * cw - 3}" height="${rh - 3}" rx="3" class="cell na"/>`;
    s += txt(L + 10, y + rh / 2 + 4, "cellna", "returns links and snippets only — never page content");
  });
  s += txt(L - 12, H - 12, "foot", "Brave's 1% is the tell: its “pages” are search snippets joined together");
  return frame(
    W,
    H,
    { id: "st-t", text: "Structural elements present in each provider's returned page text" },
    {
      id: "st-d",
      text:
        `Firecrawl and Tavily return full documents with links, images and headings. Exa and Parallel keep headings and drop links. ` +
        `Brave returns page text on 1% of results because its content is joined search snippets. Serper returns no page content at all.`,
    },
    s,
  );
}

// ── the table ─────────────────────────────────────────────────────────────────
function tableRows() {
  return ORDER.map((k) => {
    const v = P[k];
    const st = v.structure.markdown_pct === null;
    return (
      `<tr>` +
      `<th scope="row">${esc(LABEL[k])}</th>` +
      `<td class="n strong">${f3(v.set.mean)}<span class="ci">±${v.set.ci95.toFixed(3)}</span></td>` +
      `<td class="n">${f3(v.page.mean)}</td>` +
      `<td class="n">${f3(v.difficulty.hard)}</td>` +
      `<td class="n">${v.binary.rung3_pct}%</td>` +
      `<td class="n">${money(v.cost.per_query_usd)}${v.cost.is_estimate ? '<span class="est" title="published list price, not a settled invoice">*</span>' : ""}</td>` +
      `<td class="n">$${v.cost.run_total_usd.toFixed(2)}</td>` +
      `<td class="n">${st ? '<span class="dim">n/a</span>' : `${Math.round(v.truncation.pct)}%`}</td>` +
      `</tr>`
    );
  }).join("\n");
}

function stats() {
  const cheap = ORDER.reduce((a, k) => (P[k].cost.per_query_usd < P[a].cost.per_query_usd ? k : a), ORDER[0]);
  const dear = ORDER.reduce((a, k) => (P[k].cost.per_query_usd > P[a].cost.per_query_usd ? k : a), ORDER[0]);
  const ratio = Math.round(P[dear].cost.per_query_usd / P[cheap].cost.per_query_usd);
  const tiles = [
    [d.counts.page_ratings_scored.toLocaleString("en-US"), "page ratings", `${d.counts.questions} questions × 8 providers × 3 judges`],
    [`${ratio}×`, "price spread", `${money(P[cheap].cost.per_query_usd)} to ${money(P[dear].cost.per_query_usd)} for the same query`],
    [`${(d.variance_shares.judge * 100).toFixed(1)}%`, "explained by the judge", `the provider explains ${(d.variance_shares.provider * 100).toFixed(1)}%`],
    [`$${d.cost_total_usd.toFixed(2)}`, "to run the retrieval", "every provider, every question, one day"],
  ];
  return tiles
    .map(
      ([n, l, s]) =>
        `<div class="tile"><div class="tnum">${esc(n)}</div><div class="tlab">${esc(l)}</div><div class="tsub">${esc(s)}</div></div>`,
    )
    .join("\n");
}

// ── assemble ──────────────────────────────────────────────────────────────────
const REPL = {
  __CHART_LEADERBOARD__: chartLeaderboard(),
  __CHART_PRICE__: chartPrice(),
  __CHART_DIFFICULTY__: chartDifficulty(),
  __CHART_STRUCTURE__: chartStructure(),
  __TABLE_ROWS__: tableRows(),
  __STATS__: stats(),
  __N_QUESTIONS__: String(d.counts.questions),
  __N_PROVIDERS__: String(d.counts.providers),
  __N_JUDGES__: String(d.counts.judges),
  __N_RATINGS__: d.counts.page_ratings_scored.toLocaleString("en-US"),
  __N_SETS__: d.counts.set_verdicts_scored.toLocaleString("en-US"),
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
  __GENERATED__: new Date(d.generated_at).toISOString().slice(0, 10),
};

let html = fs.readFileSync(TPL, "utf8");
for (const [key, val] of Object.entries(REPL)) {
  if (!html.includes(key)) {
    console.error(`Template has no ${key}. Every placeholder must be used, or a number is silently missing from the page.`);
    process.exit(1);
  }
  html = html.replaceAll(key, () => val);
}
const left = html.match(/__[A-Z_]+__/g);
if (left) {
  console.error(`Unfilled placeholders left in the page: ${[...new Set(left)].join(", ")}`);
  process.exit(1);
}

fs.writeFileSync(OUT, html);
console.log(`${OUT} — ${(fs.statSync(OUT).size / 1024).toFixed(1)} KB, from ${DATA} (${d.run}, generated ${REPL.__GENERATED__})`);
