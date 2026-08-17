import { beforeEach, describe, expect, it, vi } from "vitest";

// Batching is an optimisation, and an optimisation that can take a run down is
// not one. These pin the fallbacks hardest: unsupported provider, failed
// submission, and a result the provider simply never returned.
const create = vi.fn();
vi.mock("./openai-compat", () => ({
  getClient: () => ({
    chat: { completions: { create } },
    files: { create: vi.fn(), content: vi.fn() },
    batches: { create: vi.fn(), retrieve: vi.fn() },
  }),
}));

const { completeBatch, supportsBatch, toAnthropicParams } = await import("./batch");

const req = (id: string, model: string) => ({
  customId: id,
  args: { model, jsonMode: true, messages: [{ role: "user" as const, content: "hi" }] },
});

beforeEach(() => {
  create.mockReset();
  create.mockResolvedValue({ choices: [{ message: { content: '{"rung": 2}' } }] });
  process.env.OPENAI_API_KEY = "test-key";
  process.env.FIREWORKS_API_KEY = "test-key";
});

describe("supportsBatch", () => {
  it("knows which providers have a batch path here", () => {
    expect(supportsBatch("openai/gpt-5.4")).toBe(true);
    expect(supportsBatch("anthropic/claude-sonnet-5")).toBe(true);
    expect(supportsBatch("fireworks/accounts/fireworks/models/glm-5p2")).toBe(false);
    expect(supportsBatch("groq/llama")).toBe(false);
  });

  it("treats a bare model as OpenAI, matching parseModelRef", () => {
    expect(supportsBatch("gpt-4o-mini")).toBe(true);
  });
});

describe("toAnthropicParams", () => {
  it("hoists the system prompt out of the message list", () => {
    const p = toAnthropicParams([
      { role: "system", content: "you grade pages" },
      { role: "user", content: "this page" },
    ]);
    expect(p.system).toBe("you grade pages");
    expect(p.messages).toEqual([{ role: "user", content: "this page" }]);
  });

  it("omits system entirely when there isn't one", () => {
    const p = toAnthropicParams([{ role: "user", content: "hi" }]);
    expect(p.system).toBeUndefined();
    expect(p.messages).toHaveLength(1);
  });
});

describe("completeBatch — the fallbacks that keep a run alive", () => {
  it("runs providers with no batch API synchronously instead of failing", async () => {
    const out = await completeBatch([req("a", "fireworks/accounts/fireworks/models/glm-5p2")]);
    expect(out).toEqual([{ customId: "a", text: '{"rung": 2}' }]);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("reports a per-request failure without taking the others down", async () => {
    create
      .mockRejectedValueOnce(new Error("429 rate limit"))
      .mockResolvedValueOnce({ choices: [{ message: { content: "ok" } }] });
    const out = await completeBatch([
      req("a", "fireworks/x"),
      req("b", "fireworks/x"),
    ]);
    expect(out.find((o) => o.customId === "a")?.error).toMatch(/rate limit/);
    expect(out.find((o) => o.customId === "b")?.text).toBe("ok");
  });

  it("returns an empty array for no work rather than submitting an empty batch", async () => {
    expect(await completeBatch([])).toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });

  it("keys results by customId, never by position", async () => {
    create
      .mockResolvedValueOnce({ choices: [{ message: { content: "first" } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: "second" } }] });
    const out = await completeBatch([req("x", "fireworks/m"), req("y", "fireworks/m")]);
    expect(new Set(out.map((o) => o.customId))).toEqual(new Set(["x", "y"]));
  });
});
