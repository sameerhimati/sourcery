import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DEFAULT_PROVIDERS, getAdapter } from "@core/adapters";
import { runEval } from "@core/orchestrator";
import { bestProviderByType } from "@core/routing";
import type { Run } from "@core/types";
import { readRecords, RUNS_PATH } from "../cli/persist";
import { classifyQuery } from "./classify";
import { REFERENCE_CAVEAT, REFERENCE_ROUTING } from "./reference";

// ─── sourcery over MCP ───
// Two tools, both thin wrappers over what the CLI already does: run the
// experiment (expensive, live) and answer the question the experiment exists to
// answer (cheap, from history). Everything an agent gets back is JSON on one
// line — this lands in a context window, so no source bodies, no answer text,
// no prose framing.

/** Every tool replies with compact JSON text: parseable by the agent, cheap in tokens. */
function json(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

/**
 * A Run, minus everything an agent can't act on. Drops answers, source bodies
 * and per-source metadata; keeps the two scores, the failure reason, and the
 * domains each arm actually retrieved (enough to sanity-check a verdict).
 * Winner is reported as a provider id, not the arm letter — "A" means nothing
 * outside the terminal scorecard.
 */
function compactRun(run: Run) {
  return {
    query: run.query,
    answer_model: run.arms[0]?.model ?? null,
    judge_model: run.judge_model,
    winner: run.arms.find((a) => a.id === run.winner)?.provider ?? null,
    arms: run.arms.map((a) =>
      a.error
        ? { provider: a.provider, error: a.error }
        : {
            provider: a.provider,
            retrieval_score: a.retrieval_score,
            answer_score: a.score,
            retrieval_rationale: a.retrieval_rationale,
            num_sources: a.sources.length,
            domains: [...new Set(a.sources.map((s) => s.domain))],
            latency_ms: a.latency_ms,
          },
    ),
  };
}

export interface ServerOptions {
  /** Where this user's eval history lives; overridable so tests can point at a fixture. */
  runsPath?: string;
}

export function createSourceryServer({ runsPath = RUNS_PATH }: ServerOptions = {}): McpServer {
  const server = new McpServer({ name: "sourcery", version: "0.1.0" });

  server.registerTool(
    "evaluate_retrieval",
    {
      title: "Evaluate retrieval providers on a query",
      description:
        "Run one query through several web-retrieval providers with everything else held constant " +
        "(same answer model, same prompts, same judge), so the only variable is the retrieval layer. " +
        "Returns per-provider retrieval and answer scores (0-10) plus a winner. " +
        "Slow and metered: it makes live provider + LLM calls.",
      inputSchema: {
        query: z.string().min(1).describe("the query to evaluate"),
        providers: z
          .array(z.string())
          .optional()
          .describe(`provider ids to compare (default: ${DEFAULT_PROVIDERS.join(", ")})`),
        model: z
          .string()
          .optional()
          .describe(
            "answer model override, e.g. gpt-4o or fireworks/<model>. The judge is deliberately " +
              "left on its stale default and is not overridable here.",
          ),
      },
    },
    async ({ query, providers, model }) => {
      // A mistyped provider is a startup error naming the valid ids, not N
      // identical per-arm failures the agent has to read a scorecard to find.
      providers?.forEach((p) => getAdapter(p));

      const run = await runEval({
        query,
        variable: "provider",
        ...(providers?.length ? { values: providers } : {}),
        ...(model ? { model } : {}),
      });
      return json(compactRun(run));
    },
  );

  server.registerTool(
    "which_provider",
    {
      title: "Recommend a retrieval provider for a query",
      description:
        "Classify a query into one of sourcery's six retrieval types and return the provider that " +
        "scored best on that type in this project's eval history. Cheap: one LLM call, no retrieval, " +
        "no provider calls. Use this to pick a provider; use evaluate_retrieval to prove one.",
      inputSchema: {
        query: z.string().min(1).describe("the query you want a provider recommendation for"),
      },
    },
    async ({ query }) => {
      const type = await classifyQuery(query);

      // The user's own data wins whenever it covers this type — that is the
      // whole point of the tool. Reference numbers are the floor, not the goal.
      const local = bestProviderByType(readRecords(runsPath)).find((r) => r.type === type);
      const pick = local ?? REFERENCE_ROUTING.find((r) => r.type === type);
      if (!pick) {
        throw new Error(`no routing data for query type "${type}"`);
      }

      return json({
        query,
        ...pick,
        source: local ? runsPath : "sourcery reference run",
        ...(local ? {} : { caveat: REFERENCE_CAVEAT }),
      });
    },
  );

  return server;
}
