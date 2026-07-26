import type { Command } from "commander";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createSourceryServer } from "../../mcp/server";
import { loadEnv } from "../env";

// `sourcery mcp` — the same engine, driven by an agent instead of a human.
// stdio only: the audience is a locally-configured client (Claude Desktop,
// Cursor, Claude Code) spawning this binary; nothing here is hosted.
export function registerMcp(program: Command): void {
  program
    .command("mcp")
    .description("serve sourcery's tools to an agent over MCP (stdio)")
    .action(async () => {
      loadEnv();
      // Deliberately no requireKeys() here: a missing key must surface as a
      // readable tool error, not as a server that dies on launch and shows the
      // user "sourcery failed to start" with nothing to act on.
      //
      // Nothing may write to stdout past this point — stdout IS the protocol.
      await createSourceryServer().connect(new StdioServerTransport());
    });
}
