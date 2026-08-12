import { readFileSync } from "node:fs";
import { parseQuerySet, QuerySetError } from "@core/query-set";

/**
 * Read a user query set, and fail with something actionable.
 *
 * A malformed query file is the most likely thing to go wrong on someone's first
 * real use of this tool, so the error has to name the file, the entry and the
 * fix — not surface a JSON.parse stack trace from three frames down.
 *
 * Shared by `batch` and `credibility`: the same file has to be runnable through
 * the quick single-judge pass and through the full seeds+panel matrix, or the
 * second dataset can never be measured the way the built-in 48 were.
 */
export function loadQuerySet(file: string): ReturnType<typeof parseQuerySet> {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    process.stderr.write(`Cannot read ${file}\n  \`sourcery batch --queries-template\` prints a starting point.\n`);
    process.exit(1);
  }
  try {
    return parseQuerySet(text, file);
  } catch (e) {
    if (e instanceof QuerySetError) {
      process.stderr.write(`${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }
}
