import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SourceMapConsumer } from "source-map";

const [profilePath, windowArgument, topArgument] = process.argv.slice(2);
if (!profilePath) {
  console.error("Usage: node scripts/map-cpuprofile.mjs <file.cpuprofile> [windowMs] [top]");
  process.exit(1);
}
const windowUs = windowArgument ? Number(windowArgument) * 1_000 : Number.POSITIVE_INFINITY;
const top = topArgument ? Number(topArgument) : 25;
const profile = JSON.parse(readFileSync(profilePath, "utf8"));
const outDirectory = resolve("out");

function localPath(url) {
  if (!url) return null;
  if (url.startsWith("file://")) return fileURLToPath(url);
  const scheme = /^inertia(?:-canary)?:\/\/app\/(.+)$/u.exec(url);
  if (scheme) return join(outDirectory, "renderer", scheme[1]);
  return null;
}

const consumers = new Map();
async function consumerFor(path) {
  if (consumers.has(path)) return consumers.get(path);
  let consumer = null;
  const mapPath = `${path}.map`;
  if (existsSync(mapPath)) consumer = await new SourceMapConsumer(JSON.parse(readFileSync(mapPath, "utf8")));
  consumers.set(path, consumer);
  return consumer;
}

const self = new Map();
let elapsed = 0;
for (let index = 0; index < profile.samples.length; index += 1) {
  elapsed += profile.timeDeltas[index] ?? 0;
  if (elapsed > windowUs) break;
  const id = profile.samples[index];
  self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[index + 1] ?? 0));
}
const byFunction = new Map();
const byFile = new Map();
let busy = 0;
for (const node of profile.nodes) {
  const us = self.get(node.id);
  if (!us) continue;
  const { functionName, url, lineNumber, columnNumber } = node.callFrame;
  if (functionName === "(idle)") continue;
  busy += us;
  let source = url ? basename(url) : functionName;
  let line = lineNumber + 1;
  let name = functionName || "(anonymous)";
  const path = localPath(url);
  if (path) {
    const consumer = await consumerFor(path);
    if (consumer && lineNumber >= 0) {
      const original = consumer.originalPositionFor({ line: lineNumber + 1, column: Math.max(0, columnNumber) });
      if (original.source) {
        source = original.source.replace(/^(\.\.\/)+/u, "");
        line = original.line ?? line;
        name = original.name ?? name;
      }
    }
  }
  const key = `${name} ${source}:${line}`;
  byFunction.set(key, (byFunction.get(key) ?? 0) + us);
  const fileKey = source.includes("node_modules/") ? source.slice(source.indexOf("node_modules/")).split("/").slice(0, source.includes("node_modules/@") ? 3 : 2).join("/") : source;
  byFile.set(fileKey, (byFile.get(fileKey) ?? 0) + us);
}
const print = (title, entries) => {
  console.log(`\n${title}`);
  console.log("| self ms | share | location |");
  console.log("|---:|---:|---|");
  for (const [key, us] of [...entries].sort((left, right) => right[1] - left[1]).slice(0, top)) {
    console.log(`| ${(us / 1_000).toFixed(1)} | ${((us / busy) * 100).toFixed(1)}% | ${key} |`);
  }
};
console.log(`# ${profilePath}: busy ${(busy / 1_000).toFixed(1)} ms in window ${(Math.min(elapsed, windowUs) / 1_000).toFixed(0)} ms`);
print("Top functions by self time", byFunction);
print("Top source files/packages by self time", byFile);
