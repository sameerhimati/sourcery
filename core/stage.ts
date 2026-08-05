import { ErrorStage } from "./types";

// ─── which step of an arm actually failed ───
//
// An arm is one retrieval call plus three LLM calls, and any of them can throw a
// message that names nothing. `"Request timed out."` is the OpenAI SDK's wording,
// but the record it lands on is stamped with a provider's name — so a judge that
// timed out gets published as a retrieval failure.
//
// That is not a cosmetic mislabel. The reliability column is this eval's headline
// claim, and an unattributed failure is charged to a vendor who did nothing
// wrong: the published table reported Exa at 1 failure in 240 on exactly this
// bug. Same defect class as counting a 402 as a provider outage, one layer up.
//
// Shared by the live orchestrator and the batch runner, which each have their own
// try/catch and must attribute failures identically or the two disagree.

/** An error that remembers which stage of the arm threw it. */
export class StageError extends Error {
  constructor(
    readonly stage: ErrorStage,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "StageError";
    this.cause = cause;
  }
}

/**
 * Tag whatever a stage throws with that stage's name. Already-tagged errors pass
 * through unchanged, so the innermost stage wins rather than an outer wrapper
 * relabelling it.
 */
export function stage<T>(name: ErrorStage, work: Promise<T>): Promise<T> {
  return work.catch((e) => {
    throw e instanceof StageError ? e : new StageError(name, e);
  });
}

/**
 * The stage to record for a caught error. Untagged errors become "unknown", never
 * "provider" — an error we cannot place must not default to blaming the vendor.
 */
export function stageOf(e: unknown): ErrorStage {
  return e instanceof StageError ? e.stage : "unknown";
}
