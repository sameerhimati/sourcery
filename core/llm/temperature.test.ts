import { beforeEach, describe, expect, it, vi } from "vitest";

// The newest models on both labs 400 on an explicit temperature. These pin the
// retry that keeps them usable, because the failure mode without it is a whole
// run dying on its first judge call.
const create = vi.fn();
vi.mock("./openai-compat", () => ({
  getClient: () => ({ chat: { completions: { create } } }),
}));

const { complete, isTemperatureRejection } = await import("./index");

const ok = { choices: [{ message: { content: "OK" } }] };
const args = {
  model: "openai/some-model",
  temperature: 0,
  messages: [{ role: "user" as const, content: "hi" }],
};

beforeEach(() => {
  create.mockReset();
  process.env.OPENAI_API_KEY = "test-key";
});

describe("isTemperatureRejection", () => {
  it("recognises both labs' wordings", () => {
    expect(isTemperatureRejection("400 `temperature` is deprecated for this model.")).toBe(true);
    expect(
      isTemperatureRejection(
        "400 Unsupported value: 'temperature' does not support 0 with this model. Only the default (1) value is supported.",
      ),
    ).toBe(true);
  });

  it("does not swallow unrelated 400s", () => {
    expect(isTemperatureRejection("400 model not found")).toBe(false);
    expect(isTemperatureRejection("429 rate limit")).toBe(false);
    // A message that merely mentions temperature is not a rejection of it.
    expect(isTemperatureRejection("the temperature outside is 30 degrees")).toBe(false);
  });
});

describe("complete — temperature retry", () => {
  it("retries without temperature when the model rejects it", async () => {
    create
      .mockRejectedValueOnce(new Error("400 `temperature` is deprecated for this model."))
      .mockResolvedValueOnce(ok);
    await expect(complete({ ...args, model: "openai/rejects-temp" })).resolves.toBe("OK");
    expect(create.mock.calls[0][0]).toHaveProperty("temperature", 0);
    expect(create.mock.calls[1][0]).not.toHaveProperty("temperature");
  });

  it("remembers, so the second call skips the wasted attempt", async () => {
    create
      .mockRejectedValueOnce(new Error("400 `temperature` is deprecated for this model."))
      .mockResolvedValue(ok);
    await complete({ ...args, model: "openai/remembers" });
    create.mockClear();
    await complete({ ...args, model: "openai/remembers" });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).not.toHaveProperty("temperature");
  });

  it("does NOT retry an unrelated failure — one 429 must not become two", async () => {
    create.mockRejectedValue(new Error("429 rate limit exceeded"));
    await expect(complete({ ...args, model: "openai/rate-limited" })).rejects.toThrow(/rate limit/);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("surfaces the second failure if the retry also fails", async () => {
    create
      .mockRejectedValueOnce(new Error("400 `temperature` is deprecated for this model."))
      .mockRejectedValueOnce(new Error("401 invalid api key"));
    await expect(complete({ ...args, model: "openai/bad-key" })).rejects.toThrow(/rejected the key/);
  });

  it("never retries when the caller sent no temperature at all", async () => {
    create.mockRejectedValue(new Error("400 `temperature` is deprecated for this model."));
    await expect(
      complete({ model: "openai/no-temp-sent", messages: args.messages }),
    ).rejects.toThrow();
    expect(create).toHaveBeenCalledTimes(1);
  });
});
