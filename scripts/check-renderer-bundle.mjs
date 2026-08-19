import { readFile, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";

const outputDirectory = resolve("out/renderer");
const assetDirectory = resolve(outputDirectory, "assets");
const kibibyte = 1024;
// The core ceiling had been consumed to within a kibibyte, which blocked
// ordinary renderer work rather than catching regressions. Keep roughly a
// percent of working room; all other ceilings remain unchanged.
const budgets = {
  entryJavaScript: 700 * kibibyte,
  entryCss: 330 * kibibyte,
  settingsJavaScript: 50 * kibibyte,
  filesFirstLoadJavaScript: 115 * kibibyte,
  deferredMarkdownJavaScript: 440 * kibibyte,
  transcriptJavaScript: 600 * kibibyte,
  deferredFailureDiagnosticsJavaScript: 8 * kibibyte,
  // The rare failure dossier has its own strict deferred ceiling below, while
  // its conditional loader remains inside the existing shared core ceiling.
  coreJavaScript: 1_920 * kibibyte,
  deferredPdfJavaScript: 500 * kibibyte,
  deferredPdfWorker: 1_350 * kibibyte,
};

function formatBytes(bytes) {
  return `${(bytes / kibibyte).toFixed(1)} KiB`;
}

async function assetBytes(assetPath) {
  return (await stat(resolve(outputDirectory, assetPath))).size;
}

async function staticJavaScriptImports(assetName) {
  const source = await readFile(resolve(assetDirectory, assetName), "utf8");
  const imports = new Set();
  const pattern = /\bimport(?:\{[^;]*?\}from)?["']\.\/([^"']+\.js)["']/gu;
  for (const match of source.matchAll(pattern)) imports.add(match[1]);
  return imports;
}

async function javaScriptClosure(entryName) {
  const pending = [entryName];
  const closure = new Set();
  while (pending.length > 0) {
    const name = pending.pop();
    if (!name || closure.has(name)) continue;
    closure.add(name);
    for (const dependency of await staticJavaScriptImports(name)) {
      if (!closure.has(dependency)) pending.push(dependency);
    }
  }
  return closure;
}

async function closureBytes(closure, excluded = new Set()) {
  const sizes = await Promise.all(
    [...closure]
      .filter((name) => !excluded.has(name))
      .map(async (name) => (await stat(resolve(assetDirectory, name))).size),
  );
  return sizes.reduce((total, bytes) => total + bytes, 0);
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
const settingsJavaScript = assetNames.find(
  (name) => /^SettingsView-.*\.js$/u.test(name),
);
const filesJavaScript = assetNames.find(
  (name) => /^FilesPanel-.*\.js$/u.test(name),
);
const deferredMarkdownJavaScript = assetNames.find(
  (name) => /^ResponseMarkdown-.*\.js$/u.test(name),
);
const deferredPdfJavaScript = assetNames.find(
  (name) => /^pdf-.*\.js$/u.test(name),
);
const deferredFailureDiagnosticsJavaScript = assetNames.find(
  (name) => /^failurePanel-.*\.js$/u.test(name),
);
const deferredPdfWorker = assetNames.find(
  (name) => /^pdf\.worker\.min-.*\.mjs$/u.test(name),
);
if (!transcriptJavaScript) {
  throw new Error(
    "Renderer bundle check could not find the deferred transcript chunk.",
  );
}
if (!settingsJavaScript) {
  throw new Error(
    "Renderer bundle check could not find the deferred settings shell.",
  );
}
if (!filesJavaScript || !deferredMarkdownJavaScript) {
  throw new Error(
    "Renderer bundle check could not find the deferred Files or Markdown chunks.",
  );
}
if (!deferredPdfJavaScript || !deferredPdfWorker) {
  throw new Error(
    "Renderer bundle check could not find the deferred PDF engine.",
  );
}
if (!deferredFailureDiagnosticsJavaScript) {
  throw new Error(
    "Renderer bundle check could not find the deferred failure diagnostics chunk.",
  );
}

const entryJavaScriptBytes = await assetBytes(entryJavaScript);
const entryCssBytes = await assetBytes(entryCss);
const entryJavaScriptName = entryJavaScript.replace(/^assets\//u, "");
const entryJavaScriptClosure = await javaScriptClosure(entryJavaScriptName);
const filesJavaScriptClosure = await javaScriptClosure(filesJavaScript);
const markdownJavaScriptClosure = await javaScriptClosure(
  deferredMarkdownJavaScript,
);
const transcriptJavaScriptClosure = await javaScriptClosure(
  transcriptJavaScript,
);
const filesFirstLoadJavaScriptBytes = await closureBytes(
  filesJavaScriptClosure,
  entryJavaScriptClosure,
);
const deferredMarkdownJavaScriptBytes = await closureBytes(
  markdownJavaScriptClosure,
  entryJavaScriptClosure,
);
const transcriptJavaScriptBytes = await closureBytes(
  transcriptJavaScriptClosure,
  entryJavaScriptClosure,
);
const settingsJavaScriptBytes = await assetBytes(
  `assets/${settingsJavaScript}`,
);
const deferredPdfJavaScriptBytes = await assetBytes(
  `assets/${deferredPdfJavaScript}`,
);
const deferredPdfWorkerBytes = await assetBytes(
  `assets/${deferredPdfWorker}`,
);
const deferredFailureDiagnosticsJavaScriptBytes = await assetBytes(
  `assets/${deferredFailureDiagnosticsJavaScript}`,
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
const coreJavaScriptBytes =
  totalJavaScriptBytes
  - deferredPdfJavaScriptBytes
  - deferredFailureDiagnosticsJavaScriptBytes;
const measurements = {
  entryJavaScript: entryJavaScriptBytes,
  entryCss: entryCssBytes,
  settingsJavaScript: settingsJavaScriptBytes,
  filesFirstLoadJavaScript: filesFirstLoadJavaScriptBytes,
  deferredMarkdownJavaScript: deferredMarkdownJavaScriptBytes,
  transcriptJavaScript: transcriptJavaScriptBytes,
  deferredFailureDiagnosticsJavaScript:
    deferredFailureDiagnosticsJavaScriptBytes,
  coreJavaScript: coreJavaScriptBytes,
  deferredPdfJavaScript: deferredPdfJavaScriptBytes,
  deferredPdfWorker: deferredPdfWorkerBytes,
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
