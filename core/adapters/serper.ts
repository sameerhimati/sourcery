// Serper: Google's results page as JSON, cheap and fast. One POST returns the
// organic listings — title, link, snippet, and the date Google itself printed
// under the result — and nothing more. There is no page body anywhere in the
// response.
//
// So this arm runs on snippets alone, and that is a decision rather than an
// omission. Serper does sell a separate scraping endpoint, and calling it here
// would make this arm look like the providers that return page text — but the
// run-2 plan seats Serper as one of the three providers measured on the links
// they return (docs/provider-admission.md, and section 6 of the
// preregistration, which is the plan of record and can't be edited quietly).
// Bright Data fetches pages after its SERP because Bright Data's own Web
// Unlocker is the thing it sells; bolting somebody else's extractor onto
// Serper's links would measure the extractor, not Serper.
//
// Two consequences for the eval, both worth saying out loud whenever this arm's
// numbers are quoted:
//
//   - `content` is always undefined, so `config.extraction` changes nothing
//     here. A `--variable extraction` sweep yields identical Serper arms and a
//     difference of exactly zero, which reads like a finding and isn't one —
//     the same trap `plain` has with freshness.
//   - The scores that need page text cover the providers that return it. Serper
//     is scored on whether the right web address came back, which is what it
//     sells.
//
// The dates are better than "links only" suggests. Google prints a date under
// most results and Serper passes it straight through as `date`, in whatever
// shape the SERP used ("Aug 5, 2026", "3 days ago") — a real provider-reported
// signal, unlike Tavily, though it is Google's opinion of when the page was
// published rather than the page's own claim.

import { ArmConfig, FetchResult, Source } from "../types";
import { host, tbsParam, toContext } from "./util";
import { dateFromSnippet, dateFromUrl, parsePublished } from "../date";

const ENDPOINT = "https://google.serper.dev/search";

interface Organic {
  title?: string;
  link?: string;
  snippet?: string;
  date?: string;
}

export async function fetchSerper(
  query: string,
  config: ArmConfig,
): Promise<FetchResult> {
  const key = process.env.SERPER_API_KEY;
  if (!key) throw new Error("SERPER_API_KEY not set");

  // gl/hl pin this to US English, the same geo the Bright Data arm pins, so the
  // two Google-backed arms differ by vendor and nothing else. `num` is Google's
  // page size and it rounds up to one, so we still slice in code.
  const body: Record<string, unknown> = {
    q: query,
    num: config.num_sources,
    gl: "us",
    hl: "en",
  };
  const tbs = tbsParam(config.freshness);
  if (tbs) body.tbs = tbs;

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "X-API-KEY": key, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Serper ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = (await res.json()) as { organic?: Organic[] };
  const organic = (data.organic ?? []).filter(
    (o): o is Organic & { link: string } => Boolean(o.link),
  );
  // An empty organic block behind a 200 is this provider failing, not a question
  // with no answer on the web. Handing back zero sources instead would be graded
  // as a real and very bad answer, so the arm would score a legitimate-looking
  // zero and quietly pull Serper's mean down.
  if (organic.length === 0) throw new Error("Serper returned no organic results");

  const now = Date.now();

  const sources: Source[] = organic.slice(0, config.num_sources).map((o) => {
    const snippet = o.snippet ?? "";
    // The ladder stops at the URL — with no page body there is nothing for
    // dateFromContent to read.
    return {
      title: o.title ?? o.link,
      url: o.link,
      published:
        parsePublished(o.date, now) ??
        dateFromSnippet(snippet, now) ??
        dateFromUrl(o.link),
      domain: host(o.link),
      snippet,
    };
  });

  return { sources, context: toContext(sources) };
}
