import { ArmConfig, FetchResult, Source } from "../types";
import { host, tbsParam, toContext } from "./util";
import { extractAll } from "../extract";
import { dateFromSnippet, dateFromUrl, parsePublished } from "../date";

const ENDPOINT = "https://api.brightdata.com/request";

interface Organic {
  link: string;
  title?: string;
  description?: string;
  last_modified_date?: string;
}

async function serpAttempt(
  token: string,
  zone: string,
  searchUrl: string,
): Promise<Organic[]> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    // format:"raw" returns the parsed SERP JSON directly as the response body.
    body: JSON.stringify({ zone, country: "us", url: searchUrl, format: "raw" }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Bright Data ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = (await res.json()) as { organic?: Organic[] };
  return Array.isArray(data.organic) ? data.organic : [];
}

export async function fetchBrightData(
  query: string,
  config: ArmConfig,
): Promise<FetchResult> {
  const token = process.env.BRIGHTDATA_API_TOKEN;
  const zone = process.env.BRIGHTDATA_SERP_ZONE;
  if (!token) throw new Error("BRIGHTDATA_API_TOKEN not set");
  if (!zone) throw new Error("BRIGHTDATA_SERP_ZONE not set (create a SERP API zone)");

  // brd_json=1 = parse Google into structured JSON; gl/hl pin geo to US so results
  // aren't localized to the proxy's random exit country. `num` is rejected by the SERP
  // parser, so we slice num_sources in code instead.
  const params = new URLSearchParams({ q: query, gl: "us", hl: "en", brd_json: "1" });
  const tbs = tbsParam(config.freshness);
  if (tbs) params.set("tbs", tbs);
  const searchUrl = `https://www.google.com/search?${params.toString()}`;

  // Bright Data's SERP scrape intermittently returns an empty parse (bad proxy exit /
  // transient page). Retry a few times before giving up so an arm doesn't blank out mid-demo.
  let organic: Organic[] = [];
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      organic = await serpAttempt(token, zone, searchUrl);
      if (organic.length > 0) break;
    } catch (e) {
      lastErr = e;
    }
    // brief backoff lets the proxy pool rotate to a fresh exit before retrying
    if (attempt < 4) await new Promise((r) => setTimeout(r, 500));
  }
  if (organic.length === 0 && lastErr) throw lastErr;

  const now = Date.now();
  const picked = organic.slice(0, config.num_sources).filter((o) => o.link);

  // Extract pass: fetch each discovered URL's real content via the Web Unlocker.
  // `clean` (default) extracts; `raw` skips extraction and answers from snippets.
  const contents =
    config.extraction === "clean"
      ? await extractAll(picked.map((o) => o.link))
      : picked.map(() => null);

  const sources: Source[] = picked.map((o, i) => {
    const snippet = o.description ?? "";
    // Date ladder for the Bright Data arm: native SERP field → snippet-leading
    // date → URL-path date. (SERP `last_modified_date` is usually null; the
    // snippet is the workhorse — see the smoke-test findings in date.ts.)
    const published =
      parsePublished(o.last_modified_date, now) ??
      dateFromSnippet(snippet, now) ??
      dateFromUrl(o.link);
    return {
      title: o.title ?? o.link,
      url: o.link,
      published,
      domain: host(o.link),
      snippet,
      content: contents[i] ?? undefined,
    };
  });

  return { sources, context: toContext(sources) };
}
