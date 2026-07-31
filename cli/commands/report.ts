import type { Command } from "commander";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { readRecords, RUNS_PATH } from "../persist";
import { buildReport } from "../report-html";
import { detectColor, renderReportTui } from "../report-tui";

const REPORT_PATH = ".sourcery/report.html";

/** Best-effort open in the default browser; never fails the command. */
function openInBrowser(path: string): void {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  try {
    spawn(cmd, [path], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref();
  } catch {
    /* headless / no opener — the printed path is the fallback */
  }
}

export function registerReport(program: Command): void {
  program
    .command("report")
    .description("Report on .sourcery/runs.jsonl — in the terminal, or as a self-contained HTML page")
    .option("--tui", "render in the terminal instead of writing HTML")
    .option("--no-open", "write the file but don't open it in a browser")
    .action((opts: { open?: boolean; tui?: boolean }) => {
      const records = readRecords();
      if (!records.length) {
        process.stdout.write(
          `No records in ${RUNS_PATH} yet — run \`sourcery run\` or \`sourcery batch\` first.\n`,
        );
        return;
      }

      if (opts.tui) {
        process.stdout.write(
          renderReportTui(records, {
            color: detectColor(process.env, Boolean(process.stdout.isTTY)),
            width: process.stdout.columns ?? 100,
          }) + "\n",
        );
        return;
      }

      const html = buildReport(records, new Date().toISOString());
      mkdirSync(dirname(REPORT_PATH), { recursive: true });
      writeFileSync(REPORT_PATH, html);

      const abs = resolve(REPORT_PATH);
      process.stdout.write(`wrote ${REPORT_PATH} (${records.length} records)\n`);
      if (opts.open !== false) {
        openInBrowser(abs);
        process.stdout.write(`opening ${abs}\n`);
      }
    });
}
