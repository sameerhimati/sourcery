import type { Command } from "commander";
import { calibrateJudges, loadAnchors } from "@core/anchors";
import { requiredEnvKeys } from "@core/llm";
import { loadEnv, requireKeys } from "../env";

// Test the judges before trusting them: every candidate judge model is scored
// against the anchor set — question-page pairs with human-settled ratings —
// plus the probes: keyword-stuffed pages that answer nothing, whose correct
// rating is 0. Cheap to run, and it has to pass before `pooled` results mean
// anything: a judge that scores a probe above 0 is grading keyword density.
export function registerCalibrate(program: Command): void {
  program
    .command("calibrate", { hidden: true })
    .description("Score candidate judge models against the anchor set (and its probes)")
    .option("--judges <list>", "comma-separated judge model refs to test")
    .option("--anchors <file>", "anchor set file", "datasets/anchors.json")
    .option("--concurrency <n>", "judge calls in flight", "4")
    .action(async (opts: CalibrateOptions) => {
      loadEnv();
      const judges = (opts.judges ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (!judges.length) throw new Error("Provide judges to test: --judges <ref>,<ref>,…");
      requireKeys(requiredEnvKeys(judges), judges);

      const anchors = loadAnchors(opts.anchors);
      if (anchors.some((a) => a.id.startsWith("example-"))) {
        process.stderr.write(
          `⚠ ${opts.anchors} still contains the shipped example entries. They demonstrate\n` +
            `  the format; a calibration against them proves nothing. Replace them with\n` +
            `  pairs whose ratings you have settled yourself.\n\n`,
        );
      }
      const probes = anchors.filter((a) => a.kind === "probe").length;
      process.stdout.write(
        `Calibrating ${judges.length} judge(s) against ${anchors.length} entries ` +
          `(${anchors.length - probes} anchors, ${probes} probes)…\n\n`,
      );

      const results = await calibrateJudges(anchors, judges, {
        concurrency: Number(opts.concurrency) || 4,
      });

      for (const r of results) {
        const verdict = r.probe_failures.length
          ? "DISQUALIFIED — scored a keyword-stuffed page above 0"
          : "probes clean";
        process.stdout.write(
          `${r.judge}\n` +
            `  hit the settled rating exactly on ${(r.exact_rate * 100).toFixed(0)}% of entries; ` +
            `average miss ${r.mean_abs_dev.toFixed(2)} rungs` +
            (r.n_null ? `; ${r.n_null} verdict(s) weren't a rung at all` : "") +
            `\n  ${verdict}\n`,
        );
        for (const m of r.misses.slice(0, 5)) {
          process.stdout.write(
            `    ${m.id} (${m.kind}): expected ${m.expected}, got ${m.got ?? "none"}` +
              (m.rationale ? ` — ${m.rationale.slice(0, 80)}` : "") +
              `\n`,
          );
        }
        process.stdout.write("\n");
      }
    });
}

interface CalibrateOptions {
  judges?: string;
  anchors: string;
  concurrency: string;
}
