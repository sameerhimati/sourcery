import { afterEach, describe, expect, it } from "vitest";
import {
  PROVIDERS,
  complete,
  explainLlmError,
  parseModelRef,
  requiredEnvKeys,
  unfenceJson,
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

  it("puts Anthropic on prompt-only JSON, since it 400s on json_object", () => {
    // Measured against the live endpoint: `response_format: {type:"json_object"}`
    // returns 400 "Input should be 'json_schema'". Every Anthropic arm failed
    // before it was scored until this row existed.
    expect(PROVIDERS.anthropic.jsonMode).toBe("prompt");
  });

  it("leaves every other provider on json_object", () => {
    for (const [id, spec] of Object.entries(PROVIDERS)) {
      if (id === "anthropic") continue;
      expect(spec.jsonMode ?? "object").toBe("object");
    }
  });
});

describe("explainLlmError — a free-tier limit should not read like a bug", () => {
  // The real message, from a two-provider run on Groq's free tier.
  const RATE_LIMIT =
    "429 Rate limit reached for model `llama-3.3-70b-versatile` in organization " +
    "`org_01kz75akbge8dby1btxf87m680` service tier `on_demand` on tokens per minute " +
    "(TPM): Limit 12000, Used 11443, Requested 3751. Please try again in 15.969999999s.";

  it("says what to do, and rounds the wait to something readable", () => {
    const out = explainLlmError(RATE_LIMIT, "groq", "GROQ_API_KEY");
    expect(out).toContain("retry in 16s");
    expect(out).toContain("fewer providers");
  });

  it("keeps the original message, so nothing is hidden", () => {
    expect(explainLlmError(RATE_LIMIT, "groq", "GROQ_API_KEY")).toContain("Limit 12000");
  });

  it("points a rejected key at the env var that holds it", () => {
    const out = explainLlmError("401 Invalid API Key", "groq", "GROQ_API_KEY");
    expect(out).toContain("GROQ_API_KEY");
  });

  it("passes anything it doesn't recognise through untouched", () => {
    expect(explainLlmError("socket hang up", "groq", "GROQ_API_KEY")).toBe("socket hang up");
  });

  it("does not mistake a 429 inside a model id for a rate limit", () => {
    // Guards the \b boundaries: "gpt-429b" is a model name, not a status code.
    expect(explainLlmError("model gpt-4290b not found", "groq", "GROQ_API_KEY")).toBe(
      "model gpt-4290b not found",
    );
  });
});

describe("unfenceJson — a fenced judge response still parses", () => {
  it("strips a ```json fence", () => {
    expect(unfenceJson('```json\n{"score": 9}\n```')).toBe('{"score": 9}');
  });

  it("strips a bare ``` fence", () => {
    expect(unfenceJson('```\n{"type": "news"}\n```')).toBe('{"type": "news"}');
  });

  it("leaves unfenced JSON exactly as it was", () => {
    expect(unfenceJson('{"score": 9, "rationale": "fine"}')).toBe(
      '{"score": 9, "rationale": "fine"}',
    );
  });

  it("leaves a backtick INSIDE a rationale alone", () => {
    // The guard against a greedy match: this is valid JSON already, and
    // mangling it would corrupt a score rather than rescue one.
    const raw = '{"score": 4, "rationale": "the ``` in the page broke extraction"}';
    expect(unfenceJson(raw)).toBe(raw);
  });

  it("survives being applied twice", () => {
    expect(unfenceJson(unfenceJson('```json\n{"score": 1}\n```'))).toBe('{"score": 1}');
  });

  // Measured on claude-sonnet-5 against real pages: 1 call in 12 wrote a
  // sentence before the object, and every one of those verdicts was dropped.
  it("recovers the object from behind a sentence of prose", () => {
    const raw =
      'This describes Flight 13 as the most recent, matching the question.\n\n{"rung": 3, "rationale": "answers it"}';
    expect(unfenceJson(raw)).toBe('{"rung": 3, "rationale": "answers it"}');
  });

  it("recovers it from prose AND a fence together", () => {
    expect(unfenceJson('Here is my verdict:\n```json\n{"rung": 0}\n```')).toBe('{"rung": 0}');
  });

  it("keeps a brace that lives inside the rationale", () => {
    const raw = 'Verdict below.\n{"rung": 2, "rationale": "the page shows a {tag} literal"}';
    expect(unfenceJson(raw)).toBe('{"rung": 2, "rationale": "the page shows a {tag} literal"}');
  });

  it("leaves text with no object at all untouched, so the caller still errors", () => {
    expect(unfenceJson("I would rate this a 3 honestly")).toBe("I would rate this a 3 honestly");
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

  it("does not point at .env.example, which is not in the npm tarball", async () => {
    delete process.env.FIREWORKS_API_KEY;
    const err = await complete({
      model: "fireworks/accounts/fireworks/models/kimi-k2-instruct",
      messages: [{ role: "user", content: "hi" }],
    }).catch((e: Error) => e);
    expect((err as Error).message).not.toContain(".env.example");
  });
});
