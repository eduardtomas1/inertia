import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const [rootArgument, ...prefixes] = process.argv.slice(2);
if (!rootArgument || prefixes.length === 0) {
  console.error("Usage: node tests/performance/summarize-scroll-runs.mjs <scroll-profile directory> <label prefix>...");
  process.exit(2);
}
const root = resolve(rootArgument);
const metrics = [
  ["p95FrameMs", (frames) => frames.p95FrameMs],
  ["p99FrameMs", (frames) => frames.p99FrameMs],
  ["missedVsyncPct", (frames) => {
    const vsync = 1_000 / (frames.displayFrequency || 60);
    const missed = frames.intervals.reduce((total, value) => total + Math.max(0, Math.round(value / vsync) - 1), 0);
    return missed / Math.max(1, frames.intervals.length + missed) * 100;
  }],
  ["over25Ms", (frames) => frames.framesOver25Ms],
  ["maxFrameMs", (frames) => frames.maximumFrameMs],
  ["rowMounts", (frames) => frames.rowMounts],
];

function stats(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
  return { n: sorted.length, median: at(0.5), p95: at(0.95), min: sorted[0], max: sorted.at(-1) };
}

const round = (value) => Number(value.toFixed(2));
for (const prefix of prefixes) {
  const runs = readdirSync(root)
    .filter((name) => name.startsWith(prefix) && existsSync(join(root, name, "summary.json")))
    .sort();
  const passes = new Map();
  for (const run of runs) {
    const summary = JSON.parse(readFileSync(join(root, run, "summary.json"), "utf8"));
    for (const result of summary.results) {
      if (!passes.has(result.pass)) passes.set(result.pass, []);
      const recorded = JSON.parse(readFileSync(join(root, run, `${result.pass}.frames.json`), "utf8"));
      passes.get(result.pass).push({
        ...result.frames,
        intervals: recorded.intervals,
        displayFrequency: summary.environment?.displayFrequency,
      });
    }
  }
  console.log(`\n## ${prefix} (${runs.length} runs: ${runs.join(", ")})`);
  for (const [pass, samples] of passes) {
    const cells = metrics.map(([name, read]) => {
      const values = samples.map(read);
      const summary = stats(values);
      return `${name} median ${round(summary.median)} p95 ${round(summary.p95)} [${values.map(round).join(", ")}]`;
    });
    console.log(`- ${pass}: ${cells.join(" | ")}`);
  }
}
