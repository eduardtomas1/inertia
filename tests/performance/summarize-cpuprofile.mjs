import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { SourceMapConsumer } from "source-map";

const [rendererDirectory, ...profiles] = process.argv.slice(2);
if (!rendererDirectory || profiles.length === 0) {
  console.error("Usage: node tests/performance/summarize-cpuprofile.mjs <out/renderer> <profile.cpuprofile>...");
  process.exit(2);
}

const consumers = new Map();
async function consumerFor(url) {
  const file = url.replace(/^[a-z-]+:\/\/[^/]+\//u, "");
  if (consumers.has(file)) return consumers.get(file);
  const mapPath = join(resolve(rendererDirectory), `${file}.map`);
  const consumer = existsSync(mapPath) ? await new SourceMapConsumer(JSON.parse(readFileSync(mapPath, "utf8"))) : null;
  consumers.set(file, consumer);
  return consumer;
}

async function locate(frame) {
  if (!frame.url) return frame.functionName || "(native)";
  const consumer = await consumerFor(frame.url);
  if (consumer) {
    const original = consumer.originalPositionFor({ line: frame.lineNumber + 1, column: frame.columnNumber });
    if (original.source) {
      const source = original.source.replace(/^.*?\/(src|node_modules)\//u, "$1/");
      return `${original.name ?? frame.functionName ?? "(anonymous)"} ${source}:${original.line}`;
    }
  }
  return `${frame.functionName || "(anonymous)"} ${basename(frame.url)}:${frame.lineNumber + 1}:${frame.columnNumber + 1}`;
}

for (const path of profiles) {
  const profile = JSON.parse(readFileSync(path, "utf8"));
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const parents = new Map();
  for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id);
  const caller = (id) => {
    let current = parents.get(id);
    while (current !== undefined && !nodes.get(current).callFrame.url) current = parents.get(current);
    return current === undefined ? null : nodes.get(current);
  };
  const self = new Map();
  let total = 0;
  profile.samples.forEach((id, index) => {
    const delta = (profile.timeDeltas[index + 1] ?? profile.timeDeltas[index] ?? 0) / 1000;
    self.set(id, (self.get(id) ?? 0) + delta);
    total += delta;
  });
  const byLocation = new Map();
  for (const [id, ms] of self) {
    const node = nodes.get(id);
    const parent = !node.callFrame.url && !node.callFrame.functionName.startsWith("(") ? caller(id) : null;
    const key = parent ? `${node.callFrame.functionName} <- ${await locate(parent.callFrame)}` : await locate(node.callFrame);
    byLocation.set(key, (byLocation.get(key) ?? 0) + ms);
  }
  const busy = total - (byLocation.get("(idle)") ?? 0);
  console.log(`\n${basename(path)}: ${total.toFixed(1)} ms sampled, ${busy.toFixed(1)} ms busy`);
  for (const [key, ms] of [...byLocation].filter(([key]) => key !== "(idle)").sort((a, b) => b[1] - a[1]).slice(0, 25)) {
    console.log(`${ms.toFixed(1).padStart(8)} ms ${(100 * ms / Math.max(1, busy)).toFixed(1).padStart(5)}%  ${key}`);
  }
}
