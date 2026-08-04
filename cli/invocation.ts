/**
 * How to spell this command back to the person running it.
 *
 * The README leads with the clone, where the binary is not on PATH and the only
 * thing that works is `npm run sourcery -- run "…"`. Printing a bare `sourcery`
 * to that user hands them a command-not-found as advice. The tsx entrypoint is
 * the tell: an installed copy runs `dist/index.js`, or a `.bin` shim.
 *
 * Lives on its own rather than inside a command, because more than one command
 * ends by telling you what to type next.
 */
export function invocation(argv1: string = process.argv[1] ?? ""): string {
  return /cli[/\\]index\.ts$/.test(argv1) ? "npm run sourcery --" : "sourcery";
}
