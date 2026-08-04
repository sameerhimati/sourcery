import { describe, expect, it } from "vitest";
import { installInstructions } from "./mcp";

// Three snippets for three clients is three chances to publish one that doesn't
// work, so the thing worth asserting is that they all spawn the same command.

const SPEC = { command: "npx", args: ["-y", "sourcery-eval", "mcp"] };

describe("installInstructions", () => {
  const out = installInstructions(SPEC);

  it("covers the clients people actually use", () => {
    expect(out).toContain("Claude Code");
    expect(out).toContain("Codex");
    expect(out).toContain("Cursor");
  });

  it("uses each client's real registration syntax", () => {
    // Verified against current docs: both CLIs take `-- <command>` after the
    // server name, and Codex's file form is a [mcp_servers.<name>] table.
    expect(out).toContain("claude mcp add sourcery -- npx -y sourcery-eval mcp");
    expect(out).toContain("codex mcp add sourcery -- npx -y sourcery-eval mcp");
    expect(out).toContain("[mcp_servers.sourcery]");
  });

  it("gives the JSON clients a config that parses", () => {
    const json = out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1);
    expect(JSON.parse(json)).toEqual({ mcpServers: { sourcery: SPEC } });
  });

  it("names both tools and which one is the cheap one", () => {
    expect(out).toContain("which_provider");
    expect(out).toContain("evaluate_retrieval");
    expect(out).toContain("Start here");
  });

  it("says the working directory matters, because the run log is relative to it", () => {
    expect(out).toContain(".sourcery/runs.jsonl");
  });

  it("adapts to a clone, where npx resolves to nothing", () => {
    const clone = installInstructions({ command: "node", args: ["/repo/dist/index.js", "mcp"] });
    expect(clone).toContain("claude mcp add sourcery -- node /repo/dist/index.js mcp");
    expect(clone).not.toContain("npx");
  });
});
