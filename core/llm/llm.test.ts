import { afterEach, describe, expect, it } from "vitest";
import {
  PROVIDERS,
  complete,
  parseModelRef,
  requiredEnvKeys,
} from "./index";

describe("parseModelRef — first-slash split, bare-string back-compat", () => {
  it("treats a bare model as OpenAI (existing configs keep working)", () => {
    expect(parseModelRef("gpt-4o-mini")).toEqual({
      provider: "openai",
      model: "gpt-4o-mini",
    });
  });

  it("splits a known provider prefix off the model", () => {
    expect(parseModelRef("openai/gpt-4o")).toEqual({
      provider: "openai",
      model: "gpt-4o",
    });
  });

  it("splits on the FIRST slash only — Fireworks ids contain slashes", () => {
    expect(
      parseModelRef("fireworks/accounts/fireworks/models/kimi-k2-instruct"),
    ).toEqual({
      provider: "fireworks",
      model: "accounts/fireworks/models/kimi-k2-instruct",
    });
  });

  it("falls back to OpenAI when the prefix isn't a known provider", () => {
    // A slashed ref for an unknown vendor is NOT silently reprovidered.
    expect(parseModelRef("acme/some-model")).toEqual({
      provider: "openai",
      model: "acme/some-model",
    });
  });
});

describe("PROVIDERS registry — baseURL + env-key selection", () => {
  it("routes Fireworks to its OpenAI-compatible baseURL + env key", () => {
    expect(PROVIDERS.fireworks).toEqual({
      baseURL: "https://api.fireworks.ai/inference/v1",
      envKey: "FIREWORKS_API_KEY",
    });
  });

  it("leaves OpenAI on the SDK default baseURL", () => {
    expect(PROVIDERS.openai.baseURL).toBeUndefined();
    expect(PROVIDERS.openai.envKey).toBe("OPENAI_API_KEY");
  });
});

describe("requiredEnvKeys — deduped keys for a set of refs", () => {
  it("maps refs to their providers' env keys and dedupes", () => {
    expect(
      requiredEnvKeys([
        "fireworks/accounts/fireworks/models/x",
        "fireworks/accounts/fireworks/models/y",
      ]),
    ).toEqual(["FIREWORKS_API_KEY"]);
  });

  it("returns one key per distinct provider", () => {
    expect(requiredEnvKeys(["gpt-4o-mini", "fireworks/models/y"]).sort()).toEqual(
      ["FIREWORKS_API_KEY", "OPENAI_API_KEY"],
    );
  });
});

describe("complete — friendly missing-key error, not a stack trace", () => {
  const saved = process.env.FIREWORKS_API_KEY;
  afterEach(() => {
    if (saved === undefined) delete process.env.FIREWORKS_API_KEY;
    else process.env.FIREWORKS_API_KEY = saved;
  });

  it("names the missing env var and points at .env.local (no network call)", async () => {
    delete process.env.FIREWORKS_API_KEY;
    await expect(
      complete({
        model: "fireworks/accounts/fireworks/models/kimi-k2-instruct",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow(/Missing FIREWORKS_API_KEY.*\.env\.local/);
  });
});
