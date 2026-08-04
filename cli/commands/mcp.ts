import type { Command } from "commander";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createSourceryServer } from "../../mcp/server";
import { loadEnv } from "../env";
import { mcpServerCommand } from "../invocation";

/**
 * The registration lines for the clients people actually use, generated from
 * one source so they cannot drift apart. Verified against each client's current
 * docs: Claude Code and Codex both take `-- <command>` after the name, and
 * Codex's file form is a `[mcp_servers.<name>]` table.
 *
 * Kept pure so a test can assert every block spawns the same command — three
 * hand-maintained snippets is three chances to publish one that doesn't work.
 */
export function installInstructions(
  spec: { command: string; args: string[] } = mcpServerCommand(),
): string {
  const line = [spec.command, ...spec.args].join(" ");
  const json = JSON.stringify(
    { mcpServers: { sourcery: { command: spec.command, args: spec.args } } },
    null,
    2,
  );
  const toml =
    `[mcp_servers.sourcery]\n` +
    `command = ${JSON.stringify(spec.command)}\n` +
    `args = [${spec.args.map((a) => JSON.stringify(a)).join(", ")}]`;

  return (
    `Give an agent sourcery's two tools.\n\n` +
    `Claude Code\n  claude mcp add sourcery -- ${line}\n\n` +
    `Codex\n  codex mcp add sourcery -- ${line}\n` +
    `  …or in ~/.codex/config.toml:\n` +
    toml.split("\n").map((l) => `    ${l}`).join("\n") + `\n\n` +
    `Cursor, Claude Desktop, anything else that takes JSON\n` +
    json.split("\n").map((l) => `  ${l}`).join("\n") + `\n\n` +
    `The tools\n` +
    `  which_provider      one LLM call, no retrieval — which backend has done\n` +
    `                      best on this kind of query. Start here.\n` +
    `  evaluate_retrieval  runs the real experiment across providers. Slow, and\n` +
    `                      it spends credits. Use it to settle a question.\n\n` +
    `Run the agent from the directory holding .sourcery/runs.jsonl and .env.local —\n` +
    `the server reads both relative to its working directory. With no runs of your\n` +
    `own you get the shipped reference numbers, and the tool says so in a caveat.\n`
  );
}

// `sourcery mcp` — the same engine, driven by an agent instead of a human.
// stdio only: the audience is a locally-configured client (Claude Desktop,
// Cursor, Claude Code) spawning this binary; nothing here is hosted.
export function registerMcp(program: Command): void {
  program
    .command("mcp")
    .description("serve sourcery's tools to an agent over MCP (stdio)")
    .option("--install", "print the registration snippet for Claude Code, Codex or Cursor and exit")
    .action(async (opts: { install?: boolean }) => {
      // Printed rather than written: these files belong to the client, and
      // silently editing someone's ~/.codex/config.toml is not this tool's call.
      if (opts.install) {
        process.stdout.write(installInstructions());
        return;
      }
      loadEnv();
      // Deliberately no requireKeys() here: a missing key must surface as a
      // readable tool error, not as a server that dies on launch and shows the
      // user "sourcery failed to start" with nothing to act on.
      //
      // Nothing may write to stdout past this point — stdout IS the protocol.
      await createSourceryServer().connect(new StdioServerTransport());
    });
}
