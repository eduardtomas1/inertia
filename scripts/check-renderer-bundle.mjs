import { readFile, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";

const outputDirectory = resolve("out/renderer");
const assetDirectory = resolve(outputDirectory, "assets");
const kibibyte = 1024;
// Route closures include their statically imported dependencies. Keeping the
// bootstrap and both window surfaces separate makes a detached chat regression
// visible even when Rollup moves shared modules between chunks.
const budgets = {
  entryJavaScript: 205 * kibibyte,
  // The in-chat project selector adds its draft-routing controller to the
  // workbench path while keeping the visual styling in the deferred App CSS.
  mainWorkbenchFirstLoadJavaScript: 703 * kibibyte,
  detachedChatFirstLoadJavaScript: 535 * kibibyte,
  entryCss: 340 * kibibyte,
  detachedChatCss: 8 * kibibyte,
  settingsJavaScript: 50 * kibibyte,
  filesFirstLoadJavaScript: 115 * kibibyte,
  deferredMarkdownJavaScript: 440 * kibibyte,
  transcriptJavaScript: 600 * kibibyte,
  deferredFailureDiagnosticsJavaScript: 8 * kibibyte,
  deferredAttachmentPreviewJavaScript: 12 * kibibyte,
  deferredPreviewJavaScript: 8 * kibibyte,
  deferredBrowserEvidenceJavaScript: 5 * kibibyte,
  deferredSpreadsheetJavaScript: 510 * kibibyte,
  deferredDiscordSettingsJavaScript: 6 * kibibyte,
  deferredCanaryRollbackJavaScript: 4 * kibibyte,
  deferredAppUpdateNoticeJavaScript: 6 * kibibyte,
  // The terminal owns reload recovery, bounded replay, and provider-resume UI.
  // Keep that optional surface isolated from the workbench and capped here.
  deferredTerminalJavaScript: 25 * kibibyte,
  detachedChatJavaScript: 16 * kibibyte,
  preMergeConfidenceJavaScript: 28 * kibibyte,
  morphiconsJavaScript: 20 * kibibyte,
  morphingIconFeedbackJavaScript: 8 * kibibyte,
  // Rare deferred surfaces have strict ceilings below, while their shared
  // dependencies remain inside the existing core ceiling.
  coreJavaScript: 1_940 * kibibyte,
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
const deferredAttachmentPreviewJavaScript = assetNames.find(
  (name) => /^DocumentAttachmentPreview-.*\.js$/u.test(name),
);
const deferredPreviewJavaScript = assetNames.find(
  (name) => /^PreviewPanel-.*\.js$/u.test(name),
);
const deferredBrowserEvidenceJavaScript = assetNames.find(
  (name) => /^BrowserEvidenceTimeline-.*\.js$/u.test(name),
);
const deferredSpreadsheetJavaScript = assetNames.find(
  (name) => /^xlsx-.*\.js$/u.test(name),
);
const deferredDiscordSettingsJavaScript = assetNames.find(
  (name) => /^DiscordSettings-.*\.js$/u.test(name),
);
const deferredCanaryRollbackJavaScript = assetNames.find(
  (name) => /^CanaryRollbackSetting-.*\.js$/u.test(name),
);
const deferredAppUpdateNoticeJavaScript = assetNames.find(
  (name) => /^AppUpdateNotice-.*\.js$/u.test(name),
);
const deferredTerminalJavaScript = assetNames.find(
  (name) => /^TerminalPanel-.*\.js$/u.test(name),
);
const mainWorkbenchJavaScript = assetNames.find(
  (name) => /^App-.*\.js$/u.test(name),
);
const detachedChatJavaScript = assetNames.find(
  (name) => /^DetachedChatApp-.*\.js$/u.test(name),
);
const preMergeConfidenceJavaScript = assetNames.find(
  (name) => /^PreMergeConfidenceLauncher-.*\.js$/u.test(name),
);
const detachedChatCss = assetNames.find(
  (name) => /^DetachedChatApp-.*\.css$/u.test(name),
);
const morphiconsJavaScript = assetNames.find(
  (name) => /^morphicons-.*\.js$/u.test(name),
);
const morphingIconFeedbackJavaScript = assetNames.find(
  (name) => /^ComposerSendActions-.*\.js$/u.test(name),
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
if (!deferredAttachmentPreviewJavaScript || !deferredSpreadsheetJavaScript) {
  throw new Error(
    "Renderer bundle check could not find the deferred attachment preview chunks.",
  );
}
if (!deferredPreviewJavaScript) {
  throw new Error(
    "Renderer bundle check could not find the deferred Preview chunk.",
  );
}
if (!deferredBrowserEvidenceJavaScript) {
  throw new Error(
    "Renderer bundle check could not find the deferred Browser evidence chunk.",
  );
}
if (!deferredDiscordSettingsJavaScript) {
  throw new Error(
    "Renderer bundle check could not find the deferred Discord settings chunk.",
  );
}
if (!deferredCanaryRollbackJavaScript) {
  throw new Error(
    "Renderer bundle check could not find the deferred Canary rollback chunk.",
  );
}
if (!deferredAppUpdateNoticeJavaScript) {
  throw new Error(
    "Renderer bundle check could not find the deferred update notice chunk.",
  );
}
if (!deferredTerminalJavaScript) {
  throw new Error(
    "Renderer bundle check could not find the deferred Terminal chunk.",
  );
}
if (!mainWorkbenchJavaScript) {
  throw new Error(
    "Renderer bundle check could not find the deferred main workbench surface.",
  );
}
if (!detachedChatJavaScript) {
  throw new Error(
    "Renderer bundle check could not find the detached-chat surface.",
  );
}
if (!preMergeConfidenceJavaScript) {
  throw new Error(
    "Renderer bundle check could not find the deferred pre-merge confidence surface.",
  );
}
if (!detachedChatCss) {
  throw new Error(
    "Renderer bundle check could not find the detached-chat stylesheet.",
  );
}
if (!morphiconsJavaScript) {
  throw new Error(
    "Renderer bundle check could not find the isolated Morphicons chunk.",
  );
}
if (!morphingIconFeedbackJavaScript) {
  throw new Error(
    "Renderer bundle check could not find the isolated morphing icon feedback chunk.",
  );
}

const entryCssBytes = await assetBytes(entryCss);
const detachedChatCssBytes = await assetBytes(`assets/${detachedChatCss}`);
const entryJavaScriptName = entryJavaScript.replace(/^assets\//u, "");
const entryJavaScriptClosure = await javaScriptClosure(entryJavaScriptName);
const mainWorkbenchJavaScriptClosure = await javaScriptClosure(
  mainWorkbenchJavaScript,
);
const detachedChatJavaScriptClosure = await javaScriptClosure(
  detachedChatJavaScript,
);
const preMergeConfidenceJavaScriptClosure = await javaScriptClosure(
  preMergeConfidenceJavaScript,
);
if (mainWorkbenchJavaScriptClosure.has(detachedChatJavaScript)) {
  throw new Error(
    "Renderer bundle check found the detached-chat surface in the main workbench route.",
  );
}
if (detachedChatJavaScriptClosure.has(mainWorkbenchJavaScript)) {
  throw new Error(
    "Renderer bundle check found the main workbench surface in the detached-chat route.",
  );
}
if (mainWorkbenchJavaScriptClosure.has(preMergeConfidenceJavaScript)) {
  throw new Error(
    "Renderer bundle check found the pre-merge confidence surface in the main workbench route.",
  );
}
const filesJavaScriptClosure = await javaScriptClosure(filesJavaScript);
const markdownJavaScriptClosure = await javaScriptClosure(
  deferredMarkdownJavaScript,
);
const transcriptJavaScriptClosure = await javaScriptClosure(
  transcriptJavaScript,
);
const entryJavaScriptBytes = await closureBytes(entryJavaScriptClosure);
const mainWorkbenchFirstLoadJavaScriptBytes = await closureBytes(
  mainWorkbenchJavaScriptClosure,
);
const detachedChatFirstLoadJavaScriptBytes = await closureBytes(
  detachedChatJavaScriptClosure,
);
const filesFirstLoadJavaScriptBytes = await closureBytes(
  filesJavaScriptClosure,
  mainWorkbenchJavaScriptClosure,
);
const deferredMarkdownJavaScriptBytes = await closureBytes(
  markdownJavaScriptClosure,
  mainWorkbenchJavaScriptClosure,
);
const transcriptJavaScriptBytes = await closureBytes(
  transcriptJavaScriptClosure,
  mainWorkbenchJavaScriptClosure,
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
const deferredAttachmentPreviewJavaScriptBytes = await assetBytes(
  `assets/${deferredAttachmentPreviewJavaScript}`,
);
const deferredPreviewJavaScriptBytes = await assetBytes(
  `assets/${deferredPreviewJavaScript}`,
);
const deferredBrowserEvidenceJavaScriptBytes = await assetBytes(
  `assets/${deferredBrowserEvidenceJavaScript}`,
);
const deferredSpreadsheetJavaScriptBytes = await assetBytes(
  `assets/${deferredSpreadsheetJavaScript}`,
);
const deferredDiscordSettingsJavaScriptBytes = await assetBytes(
  `assets/${deferredDiscordSettingsJavaScript}`,
);
const deferredCanaryRollbackJavaScriptBytes = await assetBytes(
  `assets/${deferredCanaryRollbackJavaScript}`,
);
const deferredAppUpdateNoticeJavaScriptBytes = await assetBytes(
  `assets/${deferredAppUpdateNoticeJavaScript}`,
);
const deferredTerminalJavaScriptBytes = await assetBytes(
  `assets/${deferredTerminalJavaScript}`,
);
const detachedChatJavaScriptBytes = await closureBytes(
  detachedChatJavaScriptClosure,
  mainWorkbenchJavaScriptClosure,
);
const preMergeConfidenceJavaScriptBytes = await closureBytes(
  preMergeConfidenceJavaScriptClosure,
  mainWorkbenchJavaScriptClosure,
);
const morphiconsJavaScriptBytes = await assetBytes(
  `assets/${morphiconsJavaScript}`,
);
const morphingIconFeedbackJavaScriptClosure = await javaScriptClosure(
  morphingIconFeedbackJavaScript,
);
const morphingIconFeedbackJavaScriptBytes = await closureBytes(
  morphingIconFeedbackJavaScriptClosure,
  new Set([
    ...entryJavaScriptClosure,
    ...mainWorkbenchJavaScriptClosure,
    ...detachedChatJavaScriptClosure,
    morphiconsJavaScript,
  ]),
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
  - deferredFailureDiagnosticsJavaScriptBytes
  - deferredAttachmentPreviewJavaScriptBytes
  - deferredPreviewJavaScriptBytes
  - deferredBrowserEvidenceJavaScriptBytes
  - deferredSpreadsheetJavaScriptBytes
  - deferredDiscordSettingsJavaScriptBytes
  - deferredCanaryRollbackJavaScriptBytes
  - deferredAppUpdateNoticeJavaScriptBytes
  - deferredTerminalJavaScriptBytes
  - detachedChatJavaScriptBytes
  - preMergeConfidenceJavaScriptBytes
  // The dependency and feature adapter each have strict ceilings above, so do
  // not charge the same isolated bytes to multiple independent budgets.
  - morphiconsJavaScriptBytes
  - morphingIconFeedbackJavaScriptBytes;
const measurements = {
  entryJavaScript: entryJavaScriptBytes,
  mainWorkbenchFirstLoadJavaScript: mainWorkbenchFirstLoadJavaScriptBytes,
  detachedChatFirstLoadJavaScript: detachedChatFirstLoadJavaScriptBytes,
  entryCss: entryCssBytes,
  detachedChatCss: detachedChatCssBytes,
  settingsJavaScript: settingsJavaScriptBytes,
  filesFirstLoadJavaScript: filesFirstLoadJavaScriptBytes,
  deferredMarkdownJavaScript: deferredMarkdownJavaScriptBytes,
  transcriptJavaScript: transcriptJavaScriptBytes,
  deferredFailureDiagnosticsJavaScript:
    deferredFailureDiagnosticsJavaScriptBytes,
  deferredAttachmentPreviewJavaScript:
    deferredAttachmentPreviewJavaScriptBytes,
  deferredPreviewJavaScript: deferredPreviewJavaScriptBytes,
  deferredBrowserEvidenceJavaScript: deferredBrowserEvidenceJavaScriptBytes,
  deferredSpreadsheetJavaScript: deferredSpreadsheetJavaScriptBytes,
  deferredDiscordSettingsJavaScript: deferredDiscordSettingsJavaScriptBytes,
  deferredCanaryRollbackJavaScript: deferredCanaryRollbackJavaScriptBytes,
  deferredAppUpdateNoticeJavaScript: deferredAppUpdateNoticeJavaScriptBytes,
  deferredTerminalJavaScript: deferredTerminalJavaScriptBytes,
  detachedChatJavaScript: detachedChatJavaScriptBytes,
  preMergeConfidenceJavaScript: preMergeConfidenceJavaScriptBytes,
  morphiconsJavaScript: morphiconsJavaScriptBytes,
  morphingIconFeedbackJavaScript: morphingIconFeedbackJavaScriptBytes,
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
