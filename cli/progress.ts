import type { ProgressEvent } from "@core/types";

// Progress for the two commands that make you wait: `run` (seconds) and `batch`
// (minutes to an hour). Before this, both printed nothing between the command
// and the scorecard, so a slow provider and a hung process looked identical —
// and a batch that had actually died was left running overnight because of it.
//
// Pure by construction: `write` and `now` are injected, so the whole thing
// snapshots in tests without touching process state or the clock. Nothing here
// is imported by core; the MCP server shares that engine and stdout there IS the
// protocol.

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const TICK_MS = 120;

/** "8s", "2m14s", "1h03m" — always three pieces or fewer, never a bare 4700ms. */
export function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/**
 * One progress line, rendered for a terminal.
 *
 * `frame` is the spinner index; it advances on a timer rather than on completed
 * work, because "is this still alive?" is the question being answered and a
 * batch can go a minute between arms.
 */
export function renderLine(
  event: ProgressEvent | null,
  elapsedMs: number,
  frame: number,
  width: number,
): string {
  const spin = FRAMES[frame % FRAMES.length];
  const count = event ? `${event.done}/${event.total}` : "";
  const head = `${spin} ${count ? `${count}  ` : ""}${formatElapsed(elapsedMs)}`;
  const label = event?.label ?? "";
  const line = label ? `${head}  ${label}` : head;
  // One line, never wrapped: a wrapped line can't be erased by a single \r and
  // leaves shredded output behind it.
  return line.length > width - 1 ? line.slice(0, Math.max(0, width - 2)) + "…" : line;
}

export interface Progress {
  /** Feed it a core ProgressEvent. */
  update(event: ProgressEvent): void;
  /** Erase the line (TTY) and stop the timer. Safe to call twice. */
  stop(): void;
}

/** Whatever the injected timer hands back. Node's is a Timeout; a test's is a stub. */
export interface TimerHandle {
  unref?: () => void;
}

export interface ProgressOptions {
  /** False for pipes, CI and `--no-progress`: one plain line per event, no timer. */
  tty: boolean;
  write: (s: string) => void;
  width?: number;
  now?: () => number;
  /** Injected so tests drive the spinner without a real timer. */
  setInterval?: (fn: () => void, ms: number) => TimerHandle;
  clearInterval?: (handle: TimerHandle) => void;
}

/**
 * Live progress on a TTY, plain lines everywhere else.
 *
 * The non-TTY path matters as much as the TTY one: CI and `| tee run.log` are
 * where a silent hour actually costs something, and a redrawn spinner in a log
 * file is thousands of lines of escape codes.
 */
export function createProgress(opts: ProgressOptions): Progress {
  const {
    tty,
    write,
    width = 100,
    now = Date.now,
    setInterval: setTimer = (fn, ms) => globalThis.setInterval(fn, ms) as unknown as TimerHandle,
    clearInterval: clearTimer = (h) =>
      globalThis.clearInterval(h as unknown as ReturnType<typeof globalThis.setInterval>),
  } = opts;

  const started = now();
  let last: ProgressEvent | null = null;
  let frame = 0;
  let stopped = false;

  const draw = () => {
    if (stopped) return;
    write(`\r\x1b[2K${renderLine(last, now() - started, frame, width)}`);
  };

  let handle: TimerHandle | undefined;
  if (tty) {
    draw();
    handle = setTimer(() => {
      frame++;
      draw();
    }, TICK_MS);
    // Never hold the process open on our account.
    handle?.unref?.();
  }

  return {
    update(event) {
      if (stopped) return;
      last = event;
      if (tty) draw();
      else write(`[${event.done}/${event.total}] ${event.label}\n`);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      if (handle !== undefined) clearTimer(handle);
      // Erase rather than leaving a finished-looking line: whatever the command
      // prints next is the real result, and a stale spinner above it reads as
      // still-running.
      if (tty) write("\r\x1b[2K");
    },
  };
}
