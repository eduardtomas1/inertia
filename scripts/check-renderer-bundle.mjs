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
  mascotFirstLoadJavaScript: 6 * kibibyte,
  mascotJavaScript: 6 * kibibyte,
  mascotSettingsJavaScript: 4 * kibibyte,
  // The keyboard-complete themed project selector, draft ownership guards,
  // media queue admission, deletion cleanup, native-provider route state, and
  // detachment ownership live here while their larger UI stays deferred.
  // Complete favorite profiles add validation and restore access, mode and
  // response speed across draft, split and detached chats. The workbench
  // Snapshot lease routing and compaction receipt projection bring the
  // workbench to 738.3 KiB and detached route to 565.1 KiB on macOS ARM64.
  // Keep less than 2 KiB of headroom on each.
  // Diagnostics deep links and status-only Files refresh add ~2 KiB; their
  // larger settings UI/catalog stay deferred and have separate ceilings below.
  // Project preference validation, independent appearance and chat-owned stash
  // state add ~2 KiB here; the project editor and thread menus stay deferred.
  mainWorkbenchFirstLoadJavaScript: 744.5 * kibibyte,
  // Immediate prompt-history caret placement is also used in detached chats.
  // With Snapshot integration this route measures 579,589 bytes on macOS ARM64;
  // allow the new behavior 0.25 KiB while retaining only 251 bytes of headroom.
  detachedChatFirstLoadJavaScript: 569 * kibibyte,
  // The surface and reduced-motion-safe transition system measure 344.7 KiB
  // on Linux x64; keep only narrow cross-platform headroom.
  entryCss: 346 * kibibyte,
  // The eagerly preloaded five-theme syntax and status palette is kept
  // separate from the generated entry stylesheet. It measures 11.4 KiB.
  colorThemesCss: 12 * kibibyte,
  detachedChatCss: 8 * kibibyte,
  settingsJavaScript: 50 * kibibyte,
  deferredIssueReportJavaScript: 13 * kibibyte,
  // Account quotas, source setup and deliberate reset confirmation load on demand.
  deferredUsageLimitsJavaScript: 15.5 * kibibyte,
  deferredDiagnosticsJavaScript: 13 * kibibyte,
  deferredProjectSettingsJavaScript: 12.5 * kibibyte,
  deferredThreadActionsJavaScript: 8 * kibibyte,
  deferredDiagnosticCatalogJavaScript: 12 * kibibyte,
  filesFirstLoadJavaScript: 115 * kibibyte,
  deferredMarkdownJavaScript: 440 * kibibyte,
  transcriptJavaScript: 600 * kibibyte,
  deferredFailureDiagnosticsJavaScript: 8 * kibibyte,
  // Inspectable snapshot accessibility context brings the deferred preview to 12.0 KiB.
  deferredAttachmentPreviewJavaScript: 13 * kibibyte,
  deferredPreviewJavaScript: 8 * kibibyte,
  deferredBrowserEvidenceJavaScript: 5 * kibibyte,
  deferredSpreadsheetJavaScript: 510 * kibibyte,
  deferredDiscordSettingsJavaScript: 6 * kibibyte,
  deferredCanaryRollbackJavaScript: 4 * kibibyte,
  deferredLifecycleIntegritySettingsJavaScript: 5 * kibibyte,
  // Replaces the 6 KiB notice allowance with the stateful footer control,
  // keyboard/hover details and restart confirmation (10.5 KiB measured).
  // Entry and core ceilings are unchanged; Markdown still loads only on demand.
  deferredSidebarUpdateControlJavaScript: 10.75 * kibibyte,
  // Provider OAuth validation and its terminal UI remain off the initial route.
  deferredProviderAuthJavaScript: 12 * kibibyte,
  deferredProviderMaintenanceJavaScript: 5 * kibibyte,
  deferredComposerQueueJavaScript: 8 * kibibyte,
  // Explicit recovery of pre-v55 saved prompts loads with the deferred stash menu.
  // Account only this new module here; all existing ceilings remain unchanged.
  deferredLegacyPromptStashJavaScript: 1.5 * kibibyte,
  // The terminal owns reload recovery, bounded replay, and provider-resume UI.
  // Keep that optional surface isolated from the workbench and capped here.
  deferredTerminalJavaScript: 25 * kibibyte,
  // Branch search/tracking and the Git overview load only when opened.
  deferredGitMenusJavaScript: 8.875 * kibibyte,
  detachedChatJavaScript: 16 * kibibyte,
  preMergeConfidenceJavaScript: 28 * kibibyte,
  morphiconsJavaScript: 20 * kibibyte,
  morphingIconFeedbackJavaScript: 8 * kibibyte,
  // Snapshot validation, optional setup, arrival UI and persisted compaction
  // receipts bring shared core to 1,985.9 KiB on macOS ARM64; keep <2 KiB headroom.
  // Bounded file badges, native textarea color mirroring and diagnostic links.
  // The independently capped deferred center/catalog are subtracted below.
  // Shared thread organization and project/appearance contracts add <6 KiB.
  // New optional editor/menu bytes have their own narrow caps above.
  // Update-state wiring and interactive recent attachments bring shared core
  // to 2,000.7 KiB; the footer control and Markdown notes stay deferred.
  // Limits adds 2,458 raw bytes (757 gzip) of boundary contracts/context.
  // Its complete optional closure is separately capped; first-load caps stay fixed.
  // The Work status cue (pixel glyph, elapsed time, arrival cue) adds ~1.1 KiB:
  // shared core measures 2,004.6 KiB on macOS ARM64; keep <2 KiB headroom.
  coreJavaScript: 2_005.5 * kibibyte,
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
  (name) => /^evidence-.*\.js$/u.test(name),
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
const deferredLifecycleIntegritySettingsJavaScript = assetNames.find(
  (name) => /^LifecycleIntegritySettings-.*\.js$/u.test(name),
);
const deferredSidebarUpdateControlJavaScript = assetNames.find(
  (name) => /^SidebarUpdateControl-.*\.js$/u.test(name),
);
const deferredProviderAuthJavaScript = assetNames.find(
  (name) => /^ProviderAuthDialog-.*\.js$/u.test(name),
);
const deferredProviderMaintenanceJavaScript = assetNames.find(
  (name) => /^ProviderMaintenanceNotice-.*\.js$/u.test(name),
);
const deferredComposerQueueJavaScript = assetNames.find(
  (name) => /^ComposerQueuedActions-.*\.js$/u.test(name),
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
if (!deferredLifecycleIntegritySettingsJavaScript) {
  throw new Error(
    "Renderer bundle check could not find the deferred lifecycle integrity settings chunk.",
  );
}
if (!deferredSidebarUpdateControlJavaScript) {
  throw new Error(
    "Renderer bundle check could not find the deferred sidebar update control chunk.",
  );
}
if (!deferredProviderAuthJavaScript) {
  throw new Error(
    "Renderer bundle check could not find the deferred provider auth chunk.",
  );
}
if (!deferredComposerQueueJavaScript) {
  throw new Error(
    "Renderer bundle check could not find the deferred composer queue chunk.",
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

if (!deferredProviderMaintenanceJavaScript) {
  throw new Error(
    "Renderer bundle check could not find the deferred provider maintenance notice chunk.",
  );
}

const entryCssBytes = await assetBytes(entryCss);
const colorThemesCssBytes = await assetBytes("color-themes.css");
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
const deferredLifecycleIntegritySettingsJavaScriptBytes = await assetBytes(
  `assets/${deferredLifecycleIntegritySettingsJavaScript}`,
);
const deferredSidebarUpdateControlJavaScriptBytes = await assetBytes(
  `assets/${deferredSidebarUpdateControlJavaScript}`,
);
const deferredProviderAuthJavaScriptBytes = await assetBytes(
  `assets/${deferredProviderAuthJavaScript}`,
);
const deferredProviderMaintenanceJavaScriptBytes = await assetBytes(
  `assets/${deferredProviderMaintenanceJavaScript}`,
);
const deferredComposerQueueJavaScriptBytes = await assetBytes(
  `assets/${deferredComposerQueueJavaScript}`,
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
// The optional mascot is a separate document with no workbench imports. Give
// its unique bytes their own strict ceiling; shared bootstrap stays in core.
const mascotHtml = await readFile(resolve(outputDirectory, "mascot.html"), "utf8");
const mascotEntry = mascotHtml.match(/<script[^>]+src="\.\/assets\/([^" ]+\.js)"/u)?.[1];
const mascotSettingsEntry = assetNames.find((name) => /^MascotSettings-.*\.js$/u.test(name));
if (!mascotEntry || !mascotSettingsEntry) throw new Error("Missing optional mascot surface");
const mascotClosure = await javaScriptClosure(mascotEntry);
const mascotSettingsClosure = await javaScriptClosure(mascotSettingsEntry);
const mascotJavaScriptBytes = await closureBytes(mascotClosure, entryJavaScriptClosure);
const mascotSettingsJavaScriptBytes = await closureBytes(mascotSettingsClosure, new Set([
  ...entryJavaScriptClosure, ...mainWorkbenchJavaScriptClosure, ...mascotClosure,
]));
const gitMenuEntries = ["WorkspaceBranchMenu", "WorkspaceGitActionMenu"].map((prefix) => {
  const entry = assetNames.find((name) => name.startsWith(`${prefix}-`) && name.endsWith(".js"));
  if (!entry) throw new Error(`Missing deferred Git menu: ${prefix}`);
  if (mainWorkbenchJavaScriptClosure.has(entry)) throw new Error(`Git menu is eagerly loaded: ${prefix}`);
  return entry;
});
const gitMenuClosures = await Promise.all(gitMenuEntries.map(javaScriptClosure));
const deferredGitMenusJavaScriptBytes = await closureBytes(
  new Set(gitMenuClosures.flatMap((closure) => [...closure])),
  new Set([...entryJavaScriptClosure, ...mainWorkbenchJavaScriptClosure, ...detachedChatJavaScriptClosure]),
);
const issueReportEntry = assetNames.find((name) => /^IssueReportSettings-.*\.js$/u.test(name));
if (!issueReportEntry) throw new Error("Missing deferred issue report surface");
if (mainWorkbenchJavaScriptClosure.has(issueReportEntry)) throw new Error("Issue reporting must remain deferred");
const deferredIssueReportJavaScriptBytes = await assetBytes(`assets/${issueReportEntry}`);
const diagnosticEntries = ["DiagnosticsSettings", "application-diagnostics"].map((prefix) => {
  const entry = assetNames.find((name) => name.startsWith(`${prefix}-`) && name.endsWith(".js"));
  if (!entry) throw new Error(`Missing deferred diagnostics surface: ${prefix}`);
  if (mainWorkbenchJavaScriptClosure.has(entry) || detachedChatJavaScriptClosure.has(entry)) {
    throw new Error(`Diagnostics must stay off the initial workbench: ${prefix}`);
  }
  return entry;
});
const deferredDiagnosticsJavaScriptBytes = await assetBytes(`assets/${diagnosticEntries[0]}`);
const deferredDiagnosticCatalogJavaScriptBytes = await assetBytes(`assets/${diagnosticEntries[1]}`);
const projectFeatureEntries = ["ProjectSettings", "ConversationActionsMenu"].map((prefix) => {
  const entry = assetNames.find((name) => name.startsWith(`${prefix}-`) && name.endsWith(".js"));
  if (!entry) throw new Error(`Missing deferred project/thread surface: ${prefix}`);
  if (mainWorkbenchJavaScriptClosure.has(entry) || detachedChatJavaScriptClosure.has(entry)) {
    throw new Error(`Project/thread settings must remain deferred: ${prefix}`);
  }
  return entry;
});
const deferredProjectSettingsJavaScriptBytes = await assetBytes(`assets/${projectFeatureEntries[0]}`);
const deferredThreadActionsJavaScriptBytes = await assetBytes(`assets/${projectFeatureEntries[1]}`);
const legacyPromptStashEntry = assetNames.find((name) => /^LegacyPromptStash-.*\.js$/u.test(name));
if (!legacyPromptStashEntry) throw new Error("Missing deferred legacy prompt recovery");
if (mainWorkbenchJavaScriptClosure.has(legacyPromptStashEntry) || detachedChatJavaScriptClosure.has(legacyPromptStashEntry)) {
  throw new Error("Legacy prompt recovery must stay off the initial workbench");
}
const deferredLegacyPromptStashJavaScriptBytes = await assetBytes(`assets/${legacyPromptStashEntry}`);
const usageLimitsEntry = assetNames.find((name) => /^UsageLimitsPanel-.*\.js$/u.test(name));
if (!usageLimitsEntry) throw new Error("Missing deferred provider Limits surface");
if (mainWorkbenchJavaScriptClosure.has(usageLimitsEntry) || detachedChatJavaScriptClosure.has(usageLimitsEntry)) {
  throw new Error("Provider Limits must remain deferred from the initial workbench");
}
const deferredUsageLimitsJavaScriptBytes = await closureBytes(await javaScriptClosure(usageLimitsEntry), new Set([...entryJavaScriptClosure, ...mainWorkbenchJavaScriptClosure, ...detachedChatJavaScriptClosure]));
const coreJavaScriptBytes =
  totalJavaScriptBytes
  - deferredLegacyPromptStashJavaScriptBytes
  - deferredUsageLimitsJavaScriptBytes
  - deferredProjectSettingsJavaScriptBytes
  - deferredThreadActionsJavaScriptBytes
  - deferredDiagnosticsJavaScriptBytes
  - deferredDiagnosticCatalogJavaScriptBytes
  - deferredIssueReportJavaScriptBytes
  - mascotJavaScriptBytes
  - mascotSettingsJavaScriptBytes
  - deferredPdfJavaScriptBytes
  - deferredFailureDiagnosticsJavaScriptBytes
  - deferredAttachmentPreviewJavaScriptBytes
  - deferredPreviewJavaScriptBytes
  - deferredBrowserEvidenceJavaScriptBytes
  - deferredSpreadsheetJavaScriptBytes
  - deferredDiscordSettingsJavaScriptBytes
  - deferredCanaryRollbackJavaScriptBytes
  - deferredLifecycleIntegritySettingsJavaScriptBytes
  - deferredSidebarUpdateControlJavaScriptBytes
  - deferredProviderAuthJavaScriptBytes
  - deferredProviderMaintenanceJavaScriptBytes
  - deferredComposerQueueJavaScriptBytes
  - deferredTerminalJavaScriptBytes
  - deferredGitMenusJavaScriptBytes
  - detachedChatJavaScriptBytes
  - preMergeConfidenceJavaScriptBytes
  // The dependency and feature adapter each have strict ceilings above, so do
  // not charge the same isolated bytes to multiple independent budgets.
  - morphiconsJavaScriptBytes
  - morphingIconFeedbackJavaScriptBytes;
const measurements = {
  deferredLegacyPromptStashJavaScript: deferredLegacyPromptStashJavaScriptBytes,
  deferredUsageLimitsJavaScript: deferredUsageLimitsJavaScriptBytes,
  deferredProjectSettingsJavaScript: deferredProjectSettingsJavaScriptBytes,
  deferredThreadActionsJavaScript: deferredThreadActionsJavaScriptBytes,
  deferredDiagnosticsJavaScript: deferredDiagnosticsJavaScriptBytes,
  deferredDiagnosticCatalogJavaScript: deferredDiagnosticCatalogJavaScriptBytes,
  deferredIssueReportJavaScript: deferredIssueReportJavaScriptBytes,
  mascotFirstLoadJavaScript: await closureBytes(mascotClosure),
  mascotJavaScript: mascotJavaScriptBytes,
  mascotSettingsJavaScript: mascotSettingsJavaScriptBytes,
  entryJavaScript: entryJavaScriptBytes,
  mainWorkbenchFirstLoadJavaScript: mainWorkbenchFirstLoadJavaScriptBytes,
  detachedChatFirstLoadJavaScript: detachedChatFirstLoadJavaScriptBytes,
  entryCss: entryCssBytes,
  colorThemesCss: colorThemesCssBytes,
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
  deferredLifecycleIntegritySettingsJavaScript:
    deferredLifecycleIntegritySettingsJavaScriptBytes,
  deferredSidebarUpdateControlJavaScript: deferredSidebarUpdateControlJavaScriptBytes,
  deferredProviderAuthJavaScript: deferredProviderAuthJavaScriptBytes,
  deferredProviderMaintenanceJavaScript: deferredProviderMaintenanceJavaScriptBytes,
  deferredComposerQueueJavaScript: deferredComposerQueueJavaScriptBytes,
  deferredTerminalJavaScript: deferredTerminalJavaScriptBytes,
  deferredGitMenusJavaScript: deferredGitMenusJavaScriptBytes,
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
