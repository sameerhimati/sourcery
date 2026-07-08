import { Freshness, Source } from "../types";

/** Bare hostname, www-stripped. Empty string on malformed URLs. */
export function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Freshness knob -> Google `tbs` value ("" = no time filter). */
export function tbsParam(f: Freshness): string {
  return { "24h": "qdr:d", "30d": "qdr:m", "1y": "qdr:y", all: "" }[f];
}

/** Numbered source list handed to the answering LLM. */
export function toContext(sources: Source[]): string {
  return sources
    .map((s, i) => `[${i + 1}] ${s.title} — ${s.snippet ?? ""} (${s.domain})`)
    .join("\n");
}
