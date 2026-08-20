// The one navigation bar every published page carries, and the constants that
// say where those pages live. Both build scripts import from here — a second
// copy of a nav is two navs that will eventually disagree, the same failure
// mode as a retyped number.

// Where the pages link to each other. Absolute, because these files are served
// from Pages *and* published as standalone artifacts, and a relative link only
// works in one of those.
export const BASE = "https://sameerhimati.com/sourcery/";
export const REPO = "https://github.com/sameerhimati/sourcery";

// A run that finished inside one day should not read as a range. Anything
// longer names both ends, because "fetched on one day" is a claim about how
// comparable the arms are and a two-day run has to say so.
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export function fetchedRange({ first_fetch, last_fetch }) {
  const [, m1, d1] = first_fetch.split("-");
  const [y2, m2, d2] = last_fetch.split("-");
  if (first_fetch === last_fetch) return `${+d1} ${MONTHS[+m1 - 1]} ${y2}`;
  if (m1 === m2) return `${+d1}–${+d2} ${MONTHS[+m2 - 1]} ${y2}`;
  return `${+d1} ${MONTHS[+m1 - 1]} – ${+d2} ${MONTHS[+m2 - 1]} ${y2}`;
}

// Three pages, three items. "How to pick" used to sit here as a fragment link
// into the front page; it is the first thing on that page now, so the Results
// item already lands on it and a second item pointing at the same screen was
// just a longer bar.
const ITEMS = [
  ["results", "Results", BASE],
  ["methodology", "Methodology", `${BASE}methodology/`],
  ["explorer", "Explorer", `${BASE}explorer/`],
];

// `current` is "results" | "methodology" | "explorer". The values arrive final,
// never as __TOKENS__, so the bar renders the same no matter which build script
// asked for it or in what order tokens get filled.
export function navHtml(current, { fetched }) {
  const links = ITEMS.map(
    ([key, label, href]) =>
      `<a href="${href}"${key === current ? ' aria-current="page"' : ""}>${label}</a>`,
  ).join("\n    ");
  return `<nav class="sitenav" aria-label="Site">
  <span class="brand">Sourcery<a href="https://sameerhimati.com">by Sameer Himati</a></span>
  <span class="meta">
    <span class="stamp">Run 2 &middot; fetched ${fetched}</span>
    <a href="${REPO}">Source</a>
  </span>
  <span class="navlinks">
    ${links}
  </span>
</nav>`;
}

// Literal hex rather than var(): the report and the explorer carry the same
// Grid palette under different custom-property names (--paper vs --surface),
// and this block is injected into both stylesheets. --nav-bg is the one knob:
// the current page's item punches through the bar's bottom rule by taking the
// page background, and the two pages sit on different papers.
//
// The run stamp sits up here rather than only in the colophon. A reader
// deciding whether to trust a benchmark asks how old it is first, and that
// answer should not be at the bottom of the page.
export const NAV_CSS = `
/* ── site navigation (from scripts/nav.mjs) ─────────────────────────────── */
/* Two deliberate rows: brand and run stamp on the first, the link strip on the
   second, sitting directly on the bar's bottom rule. The current page's link
   punches through that rule by taking the page background, and the trick only
   works if nothing can ever wrap in between the links and the rule. */
/* Stuck to the top of the viewport, so the way back to the other pages is
   never a scroll away on a page this long. It carries its own background for
   that: a transparent bar would let the text scroll through it. */
.sitenav {
  --nav-bg: #fafcfe;
  position: sticky; top: 0; z-index: 20; background: var(--nav-bg);
  display: flex; flex-wrap: wrap; align-items: baseline; column-gap: 20px; row-gap: 2px;
  padding-top: 14px; border-bottom: 1px solid #0a0e12;
  font-size: 0.78rem; letter-spacing: 0.02em; color: #5b5e61;
}
.sitenav .brand { font-weight: 800; text-transform: uppercase; color: #0a0e12; white-space: nowrap; }
.sitenav .brand a { font-weight: 500; text-transform: none; letter-spacing: 0; color: #5b5e61; text-decoration: none; margin-left: 8px; }
.sitenav .brand a:hover { color: #d01e1c; }
.sitenav .meta { margin-left: auto; display: flex; column-gap: 20px; white-space: nowrap; }
.sitenav .meta a { color: #5b5e61; text-decoration: none; }
.sitenav .meta a:hover { color: #d01e1c; }
.sitenav .stamp .mono { font-size: 0.85em; }
.sitenav .navlinks { width: 100%; display: flex; flex-wrap: wrap; margin-top: 4px; }
.sitenav .navlinks a {
  padding: 8px 14px; font-weight: 700; font-size: 0.84rem; letter-spacing: 0.01em;
  color: #5b5e61; text-decoration: none;
  border: 1px solid transparent; border-bottom: 0; margin-bottom: -1px;
}
.sitenav .navlinks a:hover { color: #0a0e12; }
.sitenav .navlinks a[aria-current="page"] { color: #0a0e12; background: var(--nav-bg); border-color: #0a0e12; }
@media (max-width: 760px) {
  .sitenav .meta { margin-left: 0; white-space: normal; }
}
`.trimEnd();
