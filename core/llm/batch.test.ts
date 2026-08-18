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

// ─── The two bugs that cost run 2 its judging ───
//
// Both only appear against a real batch API, which is exactly why neither the
// dry-run nor reading the code caught them. These pin them at the seam instead.
describe("batch ids and whole-batch failures", () => {
  const longKey = (n: number) =>
    `r2-bn-0${n}|https://www.nasaspaceflight.com/2026/07/starship-flight-13-booster-recovery-analysis/|claude-sonnet-5`;

  it("never puts an id over 64 characters on the wire", async () => {
    const files = { create: vi.fn().mockResolvedValue({ id: "file-1" }), content: vi.fn() };
    const batches = {
      create: vi.fn().mockResolvedValue({ id: "b1", status: "completed", output_file_id: "out-1" }),
      retrieve: vi.fn(),
    };
    let submitted = "";
    files.create.mockImplementation(async (a: { file: { text: () => Promise<string> } }) => {
      submitted = await a.file.text();
      return { id: "file-1" };
    });
    files.content.mockImplementation(async () => ({
      text: async () =>
        submitted
          .split("\n")
          .filter(Boolean)
          .map((l) => {
            const { custom_id } = JSON.parse(l) as { custom_id: string };
            return JSON.stringify({
              custom_id,
              response: { status_code: 200, body: { choices: [{ message: { content: '{"rung":2}' } }] } },
            });
          })
          .join("\n"),
    }));
    vi.doMock("./openai-compat", () => ({ getClient: () => ({ chat: { completions: { create } }, files, batches }) }));
    vi.resetModules();
    const { completeBatch: cb } = await import("./batch");

    const reqs = [1, 2, 3].map((n) => req(longKey(n), "gpt-5.4"));
    expect(reqs.every((r) => r.customId.length > 64)).toBe(true);

    const out = await cb(reqs, {});

    // What went over the wire is short...
    for (const line of submitted.split("\n").filter(Boolean)) {
      expect((JSON.parse(line) as { custom_id: string }).custom_id.length).toBeLessThanOrEqual(64);
    }
    // ...and what comes back is keyed by the caller's real resume key.
    expect(out.map((o) => o.customId).sort()).toEqual(reqs.map((r) => r.customId).sort());
    expect(out.every((o) => o.text === '{"rung":2}')).toBe(true);
  });

  it("falls back to synchronous when the whole batch fails after submission", async () => {
    const files = { create: vi.fn().mockResolvedValue({ id: "file-1" }), content: vi.fn() };
    const batches = {
      create: vi.fn().mockResolvedValue({ id: "b1", status: "validating" }),
      // validating -> failed, with no output and no error file: run 2 exactly.
      retrieve: vi.fn().mockResolvedValue({ id: "b1", status: "failed", request_counts: { completed: 0, total: 0, failed: 0 } }),
    };
    vi.doMock("./openai-compat", () => ({ getClient: () => ({ chat: { completions: { create } }, files, batches }) }));
    vi.resetModules();
    const { completeBatch: cb } = await import("./batch");

    const out = await cb([req("a", "gpt-5.4"), req("b", "gpt-5.4")], { pollMs: 1 });

    // Every request answered, none recorded as its own error.
    expect(out).toHaveLength(2);
    expect(out.every((o) => o.error === undefined)).toBe(true);
    expect(create).toHaveBeenCalledTimes(2);
  });
});

it("bounds the synchronous fallback instead of opening one socket per request", async () => {
  let inFlight = 0;
  let peak = 0;
  create.mockImplementation(async () => {
    peak = Math.max(peak, ++inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return { choices: [{ message: { content: '{"rung": 2}' } }] };
  });
  // Fireworks has no batch API, so the whole group lands on the fallback.
  const reqs = Array.from({ length: 40 }, (_, i) =>
    req(`k${i}`, "fireworks/accounts/fireworks/models/glm-5p2"),
  );
  const out = await completeBatch(reqs, { syncConcurrency: 4 });
  expect(out).toHaveLength(40);
  expect(out.every((o) => o.error === undefined)).toBe(true);
  expect(peak).toBeLessThanOrEqual(4);
});
