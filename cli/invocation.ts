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

/** True when we're running from a checkout rather than an installed package. */
export function isClone(argv1: string = process.argv[1] ?? ""): boolean {
  return /cli[/\\]index\.ts$/.test(argv1);
}

/**
 * The command an MCP client should spawn to serve sourcery.
 *
 * `npx -y sourcery-eval mcp` once it's installable, but from a clone that
 * resolves to nothing — so a checkout gets the absolute path to its own build
 * instead. Printing the npx line to someone who cloned the repo would be advice
 * that fails on first use, which is the same defect as any other doc that
 * describes a product it doesn't have.
 */
export function mcpServerCommand(
  argv1: string = process.argv[1] ?? "",
): { command: string; args: string[] } {
  if (!isClone(argv1)) return { command: "npx", args: ["-y", "sourcery-eval", "mcp"] };
  const root = argv1.replace(/cli[/\\]index\.ts$/, "");
  return { command: "node", args: [`${root}dist/index.js`, "mcp"] };
}
