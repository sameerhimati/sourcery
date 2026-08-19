import { TYPE_LABELS } from "./batch";
import type { EvalQuery, Genre, QueryType, Sharpness } from "./eval-dataset";

// Your own queries, which is the entire pitch.
//
// The built-in 48 are freshness probes — deliberately phrased so they don't rot,
// and deliberately unlike the work anyone actually points a retrieval agent at.
// Run 1 said so at length and promised this flag as the fix. Until it existed, "run it on your own queries" meant one `run` at a time, by hand.
//
// Additive on purpose: `core/eval-dataset.ts` is untouched. The published
// summary is anchored to those 48, and quietly editing them would invalidate the
// result rather than improve it.

export const QUERY_TYPES = Object.keys(TYPE_LABELS) as QueryType[];

export const SHARPNESS_VALUES: Sharpness[] = ["sharp", "open"];

export const GENRE_VALUES: Genre[] = [
  "software",
  "business",
  "science",
  "sports",
  "policy",
  "everyday",
];

/** What each genre covers, for the error message and the docs. Kept beside the
 *  list so a seventh genre can't be added without saying what it means. */
export const GENRE_LABELS: Record<Genre, string> = {
  software: "dev tools, infrastructure, APIs, library releases",
  business: "pricing, companies, markets, finance",
  science: "research, medicine, climate, energy",
  sports: "results, records, transfers, fixtures",
  policy: "regulation, government, courts",
  everyday: "travel, local, consumer goods, culture",
};

/** A parse that failed in a way the user can act on. */
export class QuerySetError extends Error {}

function fail(source: string, where: string, problem: string, fix: string): never {
  throw new QuerySetError(`${source}${where}: ${problem}\n  ${fix}`);
}

/**
 * Parse a user-supplied query set: a JSON array, or one JSON object per line.
 *
 * Both formats because both are things people already have — a JSON array is
 * what you hand-write, JSONL is what falls out of a query log.
 *
 * Types are restricted to the built-in six, and that is a real constraint rather
 * than laziness: the heatmap, `which_provider`'s routing table and the MCP
 * classifier all key off them. A seventh type would parse fine here and then
 * come out of the classifier as "unknown" forever, which is a worse experience
 * than being told no at the door.
 */
export function parseQuerySet(text: string, source = "query set"): EvalQuery[] {
  const trimmed = text.trim();
  if (!trimmed) fail(source, "", "is empty", "Expected a JSON array of queries, or one JSON object per line.");

  const raw: unknown = trimmed.startsWith("[")
    ? parseJson(trimmed, source)
    : trimmed
        .split("\n")
        .map((line, i) => ({ line: line.trim(), i }))
        .filter(({ line }) => line && !line.startsWith("//"))
        .map(({ line, i }) => parseJson(line, source, ` line ${i + 1}`));

  if (!Array.isArray(raw)) {
    fail(source, "", "is not a list of queries", "The top level must be a JSON array, or one object per line.");
  }
  if (!raw.length) fail(source, "", "contains no queries", "Add at least one { query, type } object.");

  const seen = new Set<string>();
  return raw.map((item, i) => {
    const where = ` query ${i + 1}`;
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      fail(source, where, "is not an object", `Each entry looks like {"query": "...", "type": "how_to"}.`);
    }
    const o = item as Record<string, unknown>;

    const query = typeof o.query === "string" ? o.query.trim() : "";
    if (!query) fail(source, where, "has no `query`", `Each entry needs a non-empty "query" string.`);

    const type = o.type;
    if (typeof type !== "string" || !QUERY_TYPES.includes(type as QueryType)) {
      fail(
        source,
        where,
        `has type ${JSON.stringify(type ?? null)}`,
        `Use one of: ${QUERY_TYPES.join(", ")}. These six are fixed because the ` +
          `heatmap, the MCP classifier and which_provider's routing all key off them.`,
      );
    }

    // Ids are optional — most people writing a query list won't invent them —
    // but they must be unique, because the run log is keyed by id and duplicates
    // would silently merge two different queries into one row.
    const id = typeof o.id === "string" && o.id.trim() ? o.id.trim() : `q-${String(i + 1).padStart(2, "0")}`;
    if (seen.has(id)) {
      fail(source, where, `reuses the id ${JSON.stringify(id)}`, "Ids must be unique; results are keyed by them.");
    }
    seen.add(id);

    // Optional, but a wrong value is an error rather than a silent drop. This
    // function rebuilds each entry from the fields below instead of validating
    // the object it was given, so anything it doesn't name disappears without
    // complaint — a misspelt "sharpness" would cost a whole run's worth of the
    // slice it was added for, and nothing would say why.
    const sharp = o.sharpness;
    if (sharp !== undefined && (typeof sharp !== "string" || !SHARPNESS_VALUES.includes(sharp as Sharpness))) {
      fail(
        source,
        where,
        `has sharpness ${JSON.stringify(sharp)}`,
        `Use one of: ${SHARPNESS_VALUES.join(", ")}, or leave it out. ` +
          `"sharp" means one checkable answer; "open" means several pages could each be right.`,
      );
    }

    // Same rule as sharpness, and for the same reason: a misspelt genre would
    // otherwise vanish here and cost a whole run's worth of the slice it was
    // added for, with nothing in the output saying why.
    const genre = o.genre;
    if (genre !== undefined && (typeof genre !== "string" || !GENRE_VALUES.includes(genre as Genre))) {
      fail(
        source,
        where,
        `has genre ${JSON.stringify(genre)}`,
        `Use one of: ${GENRE_VALUES.join(", ")}, or leave it out. ` +
          `Genre is what the question is about; type is what shape it takes.`,
      );
    }

    return {
      id,
      type: type as QueryType,
      query,
      ...(typeof o.note === "string" ? { note: o.note } : {}),
      ...(sharp !== undefined ? { sharpness: sharp as Sharpness } : {}),
      ...(genre !== undefined ? { genre: genre as Genre } : {}),
    };
  });
}

function parseJson(text: string, source: string, where = ""): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    fail(source, where, `is not valid JSON (${e instanceof Error ? e.message : e})`, "Check for a trailing comma or an unquoted key.");
  }
}

/**
 * A starting point, printed by `batch --queries-template`.
 *
 * Real retrieval work, not freshness probes — the kind of task run 1
 * argues the built-in set is missing. Someone should be able to redirect this to
 * a file, edit the strings, and run it.
 */
export function querySetTemplate(): string {
  const rows: { type: QueryType; query: string }[] = [
    { type: "breaking_news", query: "What did <competitor> announce in the last week?" },
    { type: "how_to", query: "How do I configure <tool> to do <specific thing>?" },
    { type: "product_lookup", query: "What are the current pricing tiers for <product>?" },
    { type: "local_geo", query: "Which <business type> near <place> are open right now?" },
    { type: "recent_release", query: "What changed in the most recent release of <library>?" },
    { type: "numeric_live", query: "What is the current <metric> for <thing>?" },
  ];
  const withIds = rows.map((r, i) => ({
    id: `q-${String(i + 1).padStart(2, "0")}`,
    type: r.type,
    query: r.query,
  }));
  return JSON.stringify(withIds, null, 2) + "\n";
}
