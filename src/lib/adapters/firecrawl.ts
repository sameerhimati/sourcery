import { ArmConfig, FetchResult, Source } from "../types";
import { host, tbsParam, toContext } from "./util";

const ENDPOINT = "https://api.firecrawl.dev/v2/search";

interface WebResult {
  title?: string;
  url: string;
  description?: string;
}

export async function fetchFirecrawl(
  query: string,
  config: ArmConfig,
): Promise<FetchResult> {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) throw new Error("FIRECRAWL_API_KEY not set");

  const body: Record<string, unknown> = { query, limit: config.num_sources };
  const tbs = tbsParam(config.freshness);
  if (tbs) body.tbs = tbs;

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Firecrawl ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = (await res.json()) as { data?: { web?: WebResult[] } };
  const web = data?.data?.web ?? [];
  const sources: Source[] = web
    .slice(0, config.num_sources)
    .filter((r) => r.url)
    .map((r) => ({
      title: r.title ?? r.url,
      url: r.url,
      published: null,
      domain: host(r.url),
      snippet: r.description ?? "",
    }));

  return { sources, context: toContext(sources) };
}
