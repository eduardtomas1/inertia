import { readFile, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";

const outputDirectory = resolve("out/renderer");
const assetDirectory = resolve(outputDirectory, "assets");
const kibibyte = 1024;
const budgets = {
  entryJavaScript: 700 * kibibyte,
  entryCss: 330 * kibibyte,
  transcriptJavaScript: 600 * kibibyte,
  totalJavaScript: 1_900 * kibibyte,
};

function formatBytes(bytes) {
  return `${(bytes / kibibyte).toFixed(1)} KiB`;
}

async function assetBytes(assetPath) {
  return (await stat(resolve(outputDirectory, assetPath))).size;
}

const html = await readFile(resolve(outputDirectory, "index.html"), "utf8");
const entryJavaScript = html.match(
  /<script[^>]+src="\.\/([^"]+\.js)"/u,
)?.[1];
const entryCss = html.match(
  /<link[^>]+rel="stylesheet"[^>]+href="\.\/([^"]+\.css)"/u,
)?.[1];

if (!entryJavaScript || !entryCss) {
  throw new Error(
    "Renderer bundle check could not resolve the entry JavaScript and CSS.",
  );
}

const assetNames = await readdir(assetDirectory);
const transcriptJavaScript = assetNames.find(
  (name) => /^ResponseTimeline-.*\.js$/u.test(name),
);
if (!transcriptJavaScript) {
  throw new Error(
    "Renderer bundle check could not find the deferred transcript chunk.",
  );
}

const entryJavaScriptBytes = await assetBytes(entryJavaScript);
const entryCssBytes = await assetBytes(entryCss);
const transcriptJavaScriptBytes = await assetBytes(
  `assets/${transcriptJavaScript}`,
);
const javaScriptSizes = await Promise.all(
  assetNames
    .filter((name) => name.endsWith(".js"))
    .map(async (name) => (await stat(resolve(assetDirectory, name))).size),
);
const totalJavaScriptBytes = javaScriptSizes.reduce(
  (total, bytes) => total + bytes,
  0,
);
const measurements = {
  entryJavaScript: entryJavaScriptBytes,
  entryCss: entryCssBytes,
  transcriptJavaScript: transcriptJavaScriptBytes,
  totalJavaScript: totalJavaScriptBytes,
};
const failures = Object.entries(measurements)
  .filter(([name, bytes]) => bytes > budgets[name])
  .map(
    ([name, bytes]) =>
      `${name}: ${formatBytes(bytes)} exceeds ${formatBytes(budgets[name])}`,
  );

if (failures.length > 0) {
  throw new Error(`Renderer bundle budgets failed:\n${failures.join("\n")}`);
}

console.log(
  [
    "Renderer bundle budgets passed:",
    ...Object.entries(measurements).map(
      ([name, bytes]) =>
        `  ${name}: ${formatBytes(bytes)} / ${formatBytes(budgets[name])}`,
    ),
  ].join("\n"),
);
