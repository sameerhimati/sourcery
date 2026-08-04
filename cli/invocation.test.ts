import { describe, expect, it } from "vitest";
import { invocation, isClone, mcpServerCommand } from "./invocation";

const CLONE = "/Users/x/Code/sourcery/cli/index.ts";
const INSTALLED = "/usr/local/lib/node_modules/sourcery-eval/dist/index.js";

describe("invocation — the advice a command prints must be runnable", () => {
  it("uses the npm script from a clone, which is what the README leads with", () => {
    expect(invocation(CLONE)).toBe("npm run sourcery --");
    expect(invocation("C:\\src\\sourcery\\cli\\index.ts")).toBe("npm run sourcery --");
  });

  it("uses the bare binary for an installed copy", () => {
    expect(invocation(INSTALLED)).toBe("sourcery");
    expect(invocation("/tmp/x/node_modules/.bin/sourcery")).toBe("sourcery");
  });

  it("falls back to the binary when argv gives it nothing", () => {
    expect(invocation("")).toBe("sourcery");
    expect(isClone("")).toBe(false);
  });
});

describe("mcpServerCommand", () => {
  it("spawns the published package once installed", () => {
    expect(mcpServerCommand(INSTALLED)).toEqual({
      command: "npx",
      args: ["-y", "sourcery-eval", "mcp"],
    });
  });

  it("points a clone at its own build, since npx would resolve to nothing", () => {
    expect(mcpServerCommand(CLONE)).toEqual({
      command: "node",
      args: ["/Users/x/Code/sourcery/dist/index.js", "mcp"],
    });
  });
});
