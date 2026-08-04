import { describe, expect, it } from "vitest";
import { missingKeysMessage } from "./env";

// The regression guarded here is a message that sent users in a circle: it told
// a Fireworks-only user to pass `--model <provider>/<model>`, they did, and the
// run failed with the identical error — because the judge defaults to an OpenAI
// model on its own. Advice that doesn't work is worse than no advice.

describe("missingKeysMessage", () => {
  it("never sends anyone to .env.example, which the npm tarball does not contain", () => {
    // `files: ["dist"]` ships four files. Naming .env.example in an error means
    // an `npx sourcery-eval` user is told to open a file they do not have — the
    // exact failure init was fixed for, which survived here.
    const msg = missingKeysMessage(["OPENAI_API_KEY"], ["gpt-4o-mini"]);
    expect(msg).not.toContain(".env.example");
    expect(msg).toContain(".env.local");
  });

  const msg = () => missingKeysMessage(["OPENAI_API_KEY"], ["gpt-4o-mini"]);

  it("names the missing key and where to put it", () => {
    expect(msg()).toContain("Missing required env: OPENAI_API_KEY");
    expect(msg()).toContain(".env.local");
  });

  it("says the answer model and judge are set separately", () => {
    expect(msg()).toMatch(/set separately/i);
  });

  it("warns that --model alone is not enough", () => {
    // The exact trap: --model without --judge leaves the judge on OpenAI.
    expect(msg()).toMatch(/--model alone still fails on the judge/i);
  });

  it("shows BOTH flags, not just --model", () => {
    const out = msg();
    expect(out).toContain("--model ");
    expect(out).toContain("--judge ");
  });

  it("points at init as the way to stop passing flags", () => {
    expect(msg()).toContain("sourcery init");
  });

  it("reports which model caused the requirement", () => {
    expect(missingKeysMessage(["FIREWORKS_API_KEY"], ["fireworks/some/model"])).toContain(
      "fireworks/some/model",
    );
  });

  it("de-duplicates when answer and judge are the same model", () => {
    const out = missingKeysMessage(["OPENAI_API_KEY"], ["gpt-4o-mini", "gpt-4o-mini"]);
    expect(out.match(/gpt-4o-mini/g)?.length).toBe(1);
  });

  it("stays terse when no models are known", () => {
    const out = missingKeysMessage(["OPENAI_API_KEY"]);
    expect(out).not.toMatch(/--judge/);
    expect(out).toContain("Missing required env");
  });
});
