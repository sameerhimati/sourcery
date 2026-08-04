import { describe, expect, it } from "vitest";
import { createProgress, formatElapsed, renderLine, type TimerHandle } from "./progress";

// The whole point of this module is that a long silence is indistinguishable
// from a hang, so the tests care about two things: that a TTY gets something
// that visibly advances, and that a pipe gets plain lines instead of a
// megabyte of escape codes.

describe("formatElapsed", () => {
  it("stays in seconds under a minute", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(8_400)).toBe("8s");
  });

  it("pads seconds so the line doesn't jitter as it ticks", () => {
    expect(formatElapsed(134_000)).toBe("2m14s");
    expect(formatElapsed(125_000)).toBe("2m05s");
  });

  it("drops to hours and minutes for a full batch", () => {
    expect(formatElapsed(3_780_000)).toBe("1h03m");
  });
});

describe("renderLine", () => {
  it("shows the count, the elapsed time and what just finished", () => {
    const line = renderLine({ done: 12, total: 96, label: "tavily" }, 134_000, 0, 100);
    expect(line).toContain("12/96");
    expect(line).toContain("2m14s");
    expect(line).toContain("tavily");
  });

  it("still renders before the first arm lands, which is the longest wait", () => {
    const line = renderLine(null, 3_000, 0, 100);
    expect(line).toContain("3s");
    expect(line).not.toContain("/");
  });

  it("advances the spinner frame so a stalled count still looks alive", () => {
    const a = renderLine(null, 1_000, 0, 100);
    const b = renderLine(null, 1_000, 1, 100);
    expect(a).not.toBe(b);
  });

  it("truncates to the terminal width — a wrapped line cannot be erased by \\r", () => {
    const line = renderLine(
      { done: 1, total: 2, label: "x".repeat(500) },
      1_000,
      0,
      40,
    );
    expect(line.length).toBeLessThanOrEqual(40);
    expect(line.endsWith("…")).toBe(true);
  });
});

describe("createProgress — TTY", () => {
  const harness = () => {
    const out: string[] = [];
    let tick: (() => void) | undefined;
    let cleared = false;
    const p = createProgress({
      tty: true,
      write: (s) => out.push(s),
      width: 80,
      now: () => 0,
      setInterval: (fn): TimerHandle => {
        tick = fn;
        return {};
      },
      clearInterval: () => {
        cleared = true;
      },
    });
    return { out, p, tick: () => tick?.(), wasCleared: () => cleared };
  };

  it("draws immediately, before any work has finished", () => {
    const { out } = harness();
    expect(out.length).toBe(1);
  });

  it("redraws on the timer even when nothing completes", () => {
    const h = harness();
    const before = h.out.length;
    h.tick();
    expect(h.out.length).toBe(before + 1);
  });

  it("rewrites one line rather than scrolling", () => {
    const h = harness();
    h.p.update({ done: 1, total: 2, label: "tavily" });
    for (const s of h.out) expect(s.startsWith("\r")).toBe(true);
  });

  it("erases the line on stop, so the scorecard isn't printed under a live spinner", () => {
    const h = harness();
    h.p.update({ done: 2, total: 2, label: "exa" });
    h.p.stop();
    expect(h.out[h.out.length - 1]).toBe("\r\x1b[2K");
    expect(h.wasCleared()).toBe(true);
  });

  it("ignores a second stop and any update after it", () => {
    const h = harness();
    h.p.stop();
    const after = h.out.length;
    h.p.stop();
    h.p.update({ done: 1, total: 1, label: "late" });
    h.tick();
    expect(h.out.length).toBe(after);
  });
});

describe("createProgress — not a TTY", () => {
  it("writes one plain line per event and never an escape code", () => {
    const out: string[] = [];
    const p = createProgress({ tty: false, write: (s) => out.push(s), now: () => 0 });
    p.update({ done: 1, total: 2, label: "tavily · what is the latest Node LTS?" });
    p.update({ done: 2, total: 2, label: "exa · what is the latest Node LTS?" });
    p.stop();
    expect(out).toEqual([
      "[1/2] tavily · what is the latest Node LTS?\n",
      "[2/2] exa · what is the latest Node LTS?\n",
    ]);
  });

  it("starts no timer, so a piped run cannot be held open by it", () => {
    let started = false;
    const p = createProgress({
      tty: false,
      write: () => {},
      setInterval: (): TimerHandle => {
        started = true;
        return {};
      },
    });
    p.stop();
    expect(started).toBe(false);
  });
});
