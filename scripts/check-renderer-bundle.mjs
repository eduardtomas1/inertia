import { readFile, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { staticJavaScriptImports } from "./renderer-bundle-imports.mjs";

const outputDirectory = resolve("out/renderer");
const assetDirectory = resolve(outputDirectory, "assets");
const kibibyte = 1024;
// Route closures include their statically imported dependencies. Keeping the
// bootstrap and both window surfaces separate makes a detached chat regression
// visible even when Rollup moves shared modules between chunks.
const budgets = {
  // React 19.3 adds 29,322 emitted bytes on identical application source.
  // The dependency batch measures 217.3 KiB; retain 224 bytes of headroom.
  // See docs/pr-evidence/dependency-batch-v0.0.56-renderer.json.
  entryJavaScript: 217.5 * kibibyte,
  mascotFirstLoadJavaScript: 6 * kibibyte + 5_418,
  mascotJavaScript: 6 * kibibyte + 5_418,
  mascotSettingsJavaScript: 6.8 * kibibyte + 841,
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
  // Against published welcome-guide main 1d5daeaa, the review adds 1,672 bytes
  // here and 1,195 bytes to detached first load. Required error/optional-storage
  // guards are the only added eager modules; optional editor UI stays deferred.
  // Measured 755.5 / 569.9 KiB; retain <0.3 KiB headroom per initial route.
  // See docs/pr-evidence/issue-356-358-renderer-bundle-welcome.json.
  // React, Zod, Lucide and TanStack dependency updates add 36,303 bytes to
  // this closure and 35,972 to detached first load. Application module bytes
  // are unchanged against merged Antigravity/file-link main 00270aa6.
  // Measured closures: 810,794 / 620,226 bytes; retain <0.3 KiB headroom.
  // Project-scope tracking adds 301 workbench bytes (811,095 total), with
  // detached first load unchanged. See workspace-383/review.md evidence.
  // Caret-aware skills, quota identity and bounded transcript navigation add
  // 1,204 / 1,125 startup bytes; shared core is essentially unchanged. Keep ~0.2 KiB
  // headroom per route. See chat-input-and-continuity/renderer-bundle.json.
  // Post-v57 reference ownership and hydration guards add 1,032 eager bytes
  // on the identical dependency graph. Preserve the previous headroom; the
  // exact before/after accounting is in post57-corrections/renderer-bundle.json.
  // Explicit workspace consent and bounded live-activity disclosure add
  // 806 / 699 bytes to the routes. Preserve headroom; see the matching-dependency
  // post57-corrections/pro-review-renderer-bundle.json measurements.
  // Reviewed production dependency batch adds exactly 1,156 emitted bytes
  // on identical application source. Preserve existing headroom; see
  // docs/pr-evidence/dependency-pr420/renderer-bundle.json.
  // The release audit's attachment refusal reasons, ambiguous queued-send
  // marking, keyboard-intent goal control and bounded missing-chat retries
  // add 1,357 / 1,023 eager bytes on the same dependency graph. Measured
  // 833,962 / 639,573 bytes on Linux x64 (macOS arm64 rounds to the same
  // KiB); allow 1,600 / 1,270 and retain ~0.25 KiB of headroom per route.
  // The plain-text attachment extension and declared-type tables in the shared
  // attachments module add 535 bytes to each first-load route (834,497 /
  // 640,108 measured on Linux x64); the import validator itself stays in main.
  // Removing unused Environment projections moves Git action helpers to their
  // actual deferred consumers. Transfer 2,900 bytes of allowance from startup
  // and core to those deferred closures; the combined ceiling does not grow.
  // See docs/pr-evidence/workspace-surfaces/renderer-bundle.json.
  // Visual replies add the turn model split, the frame height estimate and the
  // page reference validator to first load; the frame, dialog and theme bridge
  // stay in the transcript and lazy chunks. Measured 875,074 / 2,293,275 bytes
  // on Linux x64; allow 1,298 / 11,702 and retain 0.25 KiB of headroom each.
  // The frame's link token, its retry after a temporary outage and the work-log
  // title match add 750 core bytes (2,294,025 measured on macOS arm64, where
  // the previous build measures the same 2,293,275 bytes as Linux x64).
  // See docs/pr-evidence/visual-replies/renderer-bundle.json.
  // Tools-offer wave 1: palette workspace commands, the open-surface shortcut
  // and the derived-plan label add 7,975 bytes to this route (897,901
  // measured on Linux x64 against 889,926 on main e165a0aa). The palette now
  // imports headerGitActions eagerly, so the deferred header actions closure
  // shrinks by 3,233 bytes and keeps its cap.
  // Terminal-to-chat links: the workspace.path.resolve command schema, its
  // result validator and the terminal's Files opener add 139 bytes.
  // Tools-offer wave 2: Files line selection and content search, task creation
  // from messages and plan steps, and attachment re-attach add 5,485 bytes to
  // this route (903,525 measured on Linux x64 against 897,901 at be447f83,
  // including the 139 terminal bytes above).
  // Tools-offer wave 2 polish: content results in the Files main area and
  // the Attachments gallery tile fix add 3 bytes (903,528 measured on Linux x64).
  // Tools-offer wave 4: diff readability (the Changes view-mode prop and its
  // per-chat scope) adds 94 bytes to this route, measured on Linux x64 with
  // and without the change on the same tree.
  // Tools-offer wave 4: commit authoring and staging, history and blame, and
  // the worktree list add 1,902 bytes to this route (905,524 measured on Linux
  // x64 against 903,528 at 4e73ea07, including the 94 diff readability bytes
  // above).
  // Tools-offer wave 4 polish: the split-view file strip and per-column
  // scrollers, the row actions cluster, the narrower blame gutter and the
  // Main checkout label add 57 bytes (905,581 measured on Linux x64).
  mainWorkbenchFirstLoadJavaScript: 800.2 * kibibyte + 1_032 + 806 + 1_156 + 3_324 + 1_744 + 4_975 + 164 + 1_600 + 535 - 2_900 + 8_261 + 369 + 141 + 48 + 315 + 10_522 + 2_061 + 1_664 + 351 + 3_465 + 1_252 + 18 + 193 + 7_770 + 142 + 117 + 302 + 112 + 570 + 926 + 936 + 489 + 367 + 553 + 329 + 310 + 90 + 263 - 12_249 + 323 + 242 + 647 + 918 + 604 + 744 + 1_122 + 378 + 853 + 215 + 234 + 869 + 419 + 233 + 494 + 379 + 860 + 4_736 + 3_421 + 960 + 9_004 + 381 + 342 + 21 + 7_975 + 139 + 5_485 + 3 + 94 + 1_902 + 57,
  // Immediate prompt-history caret placement is also used in detached chats.
  // With Snapshot integration this route measures 579,589 bytes on macOS ARM64;
  // allow the new behavior 0.25 KiB while retaining only 251 bytes of headroom.
  // Global storage settings add shared command/result guards; measured 642,614 bytes.
  // The 5 KiB management UI is separately deferred and capped below.
  // Tools-offer wave 1: the open-surface keybinding default and its global
  // shortcut dispatch add 596 bytes to this route (682,589 measured against
  // 681,993 on main e165a0aa).
  // Terminal-to-chat links add the shared path-resolve contract: 47 bytes.
  // Tools-offer wave 2: Files line selection and content search, task creation
  // from messages and plan steps, and attachment re-attach add 2,299 bytes to
  // this route (684,935 measured on Linux x64 against 682,589 at be447f83,
  // including the 47 terminal bytes above).
  // Tools-offer wave 4: diff readability adds 20 bytes to this route.
  // Tools-offer wave 4: commit authoring and staging, history and blame, and
  // the worktree list add 186 bytes to this route (685,141 measured on Linux
  // x64 against 684,935 at 4e73ea07, including the 20 bytes above).
  detachedChatFirstLoadJavaScript: 613.8 * kibibyte + 1_032 + 699 + 1_156 + 566 + 1_691 + 4_875 + 1_270 + 535 + 109 + 1_056 + 824 + 129 + 256 + 7_023 + 369 + 141 + 48 + 315 + 7_489 + 2_041 + 1_536 + 351 + 1_929 + 1_059 + 3_748 + 296 + 104 + 3_430 + 8_892 + 151 + 342 + 596 + 47 + 2_299 + 20 + 186,
  // The token pass and the plain surfaces measure 241,004 bytes on every
  // platform; keep only narrow cross-platform headroom.
  // The terminal find bar's floating rules add 781 bytes.
  // Tools-offer wave 2: Files line selection and content search, task creation
  // from messages and plan steps, and attachment re-attach add 2,712 bytes to
  // this stylesheet beyond the previous cap (244,753 measured on Linux x64
  // against 241,102 at be447f83, including the 781 terminal bytes above and
  // the 158 bytes of earlier headroom).
  // Tools-offer wave 2 polish: content results in the Files main area and
  // the Attachments gallery tile fix add 1,443 bytes (246,196 measured on Linux x64).
  // Tools-offer wave 4: diff readability (intraline marks, the Unified | Split
  // toggle and the split grid) adds 2,263 bytes, measured on Linux x64.
  // Tools-offer wave 4: commit authoring and staging, history and blame, and
  // the worktree list add 915 bytes (249,374 measured on Linux x64 against
  // 246,196 at 4e73ea07, including the 2,263 diff readability bytes above).
  // Tools-offer wave 4 polish: the split-view file strip and per-column
  // scrollers, the row actions cluster, the narrower blame gutter and the
  // Main checkout label add 2,896 bytes (252,270 measured on Linux x64).
  entryCss: 241_004 + 256 + 781 + 2_712 + 1_443 + 2_263 + 915 + 2_896,
  // The eagerly preloaded five-theme syntax and status palette is kept
  // separate from the generated entry stylesheet and measures 8,675 bytes.
  // Its scoped LF rule keeps Windows identical; keep narrow headroom.
  colorThemesCss: 8 * kibibyte + 120 + 552,
  detachedChatCss: 8 * kibibyte,
  settingsJavaScript: 50 * kibibyte + 6_939 + 8_296 + 2_962 + 12_114,
  deferredIssueReportJavaScript: 13 * kibibyte + 824,
  // Account quotas, source setup and deliberate reset confirmation load on demand.
  deferredUsageLimitsJavaScript: 19.7 * kibibyte + 1_591 + 6,
  // Tools-offer wave 1: the open-surface help topic adds 338 bytes (38,361
  // measured against 38,023 on main); raise the cap by the 3-byte overflow.
  deferredWelcomeGuideJavaScript: 13 * kibibyte + 2_133 + 13_691 + 192 + 6_856 + 539 + 197 + 89 + 39 + 198 + 785 + 125 + 202 + 3,
  deferredWorkingOrbJavaScript: 22 * kibibyte,
  // Dedicated capture setup stays off both chat routes (4.9 KiB measured).
  deferredSnapshotSettingsJavaScript: 5.2 * kibibyte + 886,
  deferredSnapshotControlJavaScript: 7.2 * kibibyte,
  // Global disk usage, quota selection and deletion confirmation load only in Archive & data.
  deferredAttachmentStorageSettingsJavaScript: 5 * kibibyte + 172 + 128 + 84,
  // Keeping an expanded running task's moving line adds 49 bytes (19,340
  // measured).
  // Tools-offer wave 2: Files line selection and content search, task creation
  // from messages and plan steps, and attachment re-attach add 22 bytes to
  // this chunk, one static import of a new shared chunk (19,430 measured on
  // Linux x64 against 19,408 at be447f83).
  deferredBackgroundTasksJavaScript: 18 * kibibyte + 859 + 49 + 24 + 23 + 21 + 22,
  // Tools-offer wave 1: longer minified import aliases from the grown shared
  // chunk add 2 bytes (21,128 measured against 21,126 on main).
  deferredTasksViewJavaScript: 20 * kibibyte + 469 + 108 + 52 + 17 + 2,
  deferredDiagnosticsJavaScript: 13 * kibibyte + 6_546,
  // Tools-offer wave 4: commit authoring and staging, history and blame, and
  // the worktree list add 6,436 bytes to this chunk, the Project settings
  // worktree section (23,569 measured on Linux x64 against 17,133 at
  // 4e73ea07); raise the cap by the 5,911-byte overflow.
  // Tools-offer wave 4 polish: the split-view file strip and per-column
  // scrollers, the row actions cluster, the narrower blame gutter and the
  // Main checkout label add 289 bytes (23,858 measured on Linux x64).
  deferredProjectSettingsJavaScript: 12.5 * kibibyte + 567 + 3_226 + 1_065 + 5_911 + 289,
  deferredCliConversationImportJavaScript: 9_797 + 256,
  deferredThreadActionsJavaScript: 8 * kibibyte + 75,
  deferredProjectCustomizeJavaScript: 11.125 * kibibyte + 363 + 406,
  deferredProjectColorContrastJavaScript: 1.875 * kibibyte,
  deferredReviewNoteJavaScript: 1.5 * kibibyte,
  deferredDiagnosticCatalogJavaScript: 12 * kibibyte,
  // Tools-offer wave 2: Files line selection and content search, task creation
  // from messages and plan steps, and attachment re-attach add 7,555 bytes to
  // this closure (118,432 measured on Linux x64 against 110,877 at be447f83);
  // raise the cap by the 672-byte overflow.
  // Tools-offer wave 2 polish: content results in the Files main area and
  // the Attachments gallery tile fix add 1,597 bytes (120,029 measured on Linux x64).
  // Tools-offer wave 4: diff readability adds 55 bytes to this closure.
  // Tools-offer wave 4: commit authoring and staging, history and blame, and
  // the worktree list add 6,709 bytes to this closure (126,793 measured on
  // Linux x64 against 120,029 at 4e73ea07, including the 55 bytes above).
  // Tools-offer wave 4 polish: the split-view file strip and per-column
  // scrollers, the row actions cluster, the narrower blame gutter and the
  // Main checkout label add 394 bytes (127,187 measured on Linux x64).
  filesFirstLoadJavaScript: 115 * kibibyte + 672 + 1_597 + 55 + 6_709 + 394,
  deferredMarkdownJavaScript: 440 * kibibyte,
  transcriptJavaScript: 600 * kibibyte,
  deferredFailureDiagnosticsJavaScript: 8 * kibibyte,
  // Inspectable snapshot accessibility context brings the deferred preview to 12.0 KiB.
  // Pointer/keyboard image zoom and its pan arithmetic add 4,418 measured
  // bytes to the same deferred chunk. Existing headroom is unchanged, and the
  // lightbox still loads only when an attachment preview is opened.
  deferredAttachmentPreviewJavaScript: 13 * kibibyte + 4_418 + 512 + 459,
  deferredPreviewJavaScript: 8 * kibibyte,
  deferredBrowserEvidenceJavaScript: 5 * kibibyte,
  deferredSpreadsheetJavaScript: 510 * kibibyte,
  deferredDiscordSettingsJavaScript: 6 * kibibyte + 2_567,
  deferredCanaryRollbackJavaScript: 4 * kibibyte,
  deferredLifecycleIntegritySettingsJavaScript: 5 * kibibyte + 1_102,
  // Replaces the 6 KiB notice allowance with the stateful footer control,
  // keyboard/hover details and restart confirmation (10.5 KiB measured).
  // Entry and core ceilings are unchanged; Markdown still loads only on demand.
  deferredSidebarUpdateControlJavaScript: 10.75 * kibibyte + 4_883,
  // Provider OAuth validation and its terminal UI remain off the initial route.
  deferredProviderAuthJavaScript: 12 * kibibyte,
  deferredProviderMaintenanceJavaScript: 5 * kibibyte,
  deferredComposerQueueJavaScript: 8 * kibibyte + 4_995,
  // Explicit recovery of pre-v55 saved prompts loads with the deferred stash menu.
  // Account only this new module here; all existing ceilings remain unchanged.
  deferredLegacyPromptStashJavaScript: 1.5 * kibibyte,
  // The terminal owns reload recovery, bounded replay, and provider-resume UI.
  // Keep that optional surface isolated from the workbench and capped here.
  // Roving terminal tabs and keyboard close add ~0.3 KiB (25.3 KiB measured).
  // Docking under the chat moves session controls into the tab row and adds
  // Hide: 494 bytes (26,456 measured).
  // Connecting the terminal to the chat adds @xterm/addon-search 0.16.0
  // (~38 KiB minified), @xterm/addon-web-links 0.12.0, runtime-resolved file
  // links, the find bar and Add selection to prompt: 41,125 bytes on Linux x64
  // (27,107 -> 68,232) against the same application source.
  deferredTerminalJavaScript: 25.5 * kibibyte + 494 + 106 + 159 + 198 + 160 + 41_125,
  // Branch search/tracking and the Git overview load only when opened.
  deferredGitMenusJavaScript: 8.875 * kibibyte + 245 + 50,
  deferredWorkspaceHeaderActionsJavaScript: 18.75 * kibibyte + 2_850 + 32,
  detachedChatJavaScript: 16 * kibibyte,
  preMergeConfidenceJavaScript: 28 * kibibyte,
  morphiconsJavaScript: 20 * kibibyte + 205,
  deferredIconRegionJavaScript: 12_995,
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
  // Review corrections add 2,936 bytes over published welcome-guide main.
  // Core measures 2,025.0 KiB with no duplicated rendered modules; retain
  // <0.3 KiB headroom. Deferred guide, editor and terminal caps stay separate.
  // The same dependency batch adds 37,916 bytes to shared core. Its measured
  // 2,114,728 bytes retain 242 bytes of headroom; deferred caps stay separate.
  // Project-scope tracking adds 318 core bytes (2,115,046 total), leaving
  // 26 bytes under the revised cap. See workspace-383/review.md evidence.
  // The same guards, preview feedback and visible expansion anchors add
  // 1,186 core bytes. All pre-existing bundle headroom remains unchanged.
  // Consent, deferred card error/retry states and active-operation disclosure
  // add 2,633 measured bytes in total, including the initial route additions.
  // The lazy sidebar's focused-only aurora scheduler adds 722 bytes on the
  // same source/dependency baseline. Both first-load routes are unchanged.
  // Preserve headroom; see release-v0058/aurora-renderer-bundle.json.
  // The expandable attachment gallery adds 1,017 core bytes on the same
  // baseline; the zoomable lightbox stays in its deferred chunk above.
  // The same release-audit additions add 2,065 core bytes (2,160,000
  // measured on Linux x64); allow 2,310 and keep ~0.25 KiB of headroom.
  // The plain-text attachment tables add 571 core bytes (2,160,571 measured).
  // Storage contracts and its deferred loader bring core to 2,165,834 bytes.
  // Retain about 0.2 KiB headroom; settings UI has its own 5 KiB ceiling.
  // Tools-offer wave 1: palette workspace commands, the open-surface shortcut
  // and the derived-plan label add 9,887 core bytes (2,325,741 measured on
  // Linux x64 against 2,315,854 on main e165a0aa).
  // Terminal-to-chat links add 1,199 core bytes on the same baseline: the
  // shared path-resolve contract, result validator and context-menu flag.
  // Tools-offer wave 2: Files line selection and content search, task creation
  // from messages and plan steps, and attachment re-attach add 19,710 core
  // bytes (2,346,650 measured on Linux x64 against 2,325,741 at be447f83,
  // including the 1,199 terminal bytes above).
  // Tools-offer wave 2 polish: content results in the Files main area and
  // the Attachments gallery tile fix add 1,424 bytes (2,348,074 measured on Linux x64).
  // Tools-offer wave 3: the managed context-read access value in the shared
  // contracts adds 10 core bytes (2,348,084 measured on Linux x64).
  // Tools-offer wave 4: diff readability (diff syntax highlighting, the bounded
  // intraline word diff and the split view) adds 8,714 core bytes, measured on
  // Linux x64 with and without the change on the same tree.
  // Tools-offer wave 4: commit authoring and staging, history and blame, and
  // the worktree list add 22,367 core bytes (2,379,165 measured on Linux x64
  // against 2,348,084 at 4e73ea07, including the 8,714 diff readability
  // bytes above).
  // Tools-offer wave 4 polish: the split-view file strip and per-column
  // scrollers, the row actions cluster, the narrower blame gutter and the
  // Main checkout label add 3,470 bytes (2,382,635 measured on Linux x64).
  coreJavaScript: 2_294_495 + 256 + 368 + 303 + 432 + 843 + 1_985 + 3_788 + 74 + 294 + 20 + 1_114 + 10_267 + 381 + 474 + 34 + 605 + 94 + 27 + 9_887 + 1_199 + 19_710 + 1_424 + 10 + 8_714 + 22_367 + 3_470,
  deferredPdfJavaScript: 500 * kibibyte,
  deferredPdfWorker: 1_350 * kibibyte,
};

function formatBytes(bytes) {
  return `${(bytes / kibibyte).toFixed(1)} KiB (${Math.floor(bytes)} bytes)`;
}

async function assetBytes(assetPath) {
  return (await stat(resolve(outputDirectory, assetPath))).size;
}

async function assetJavaScriptImports(assetName) {
  const source = await readFile(resolve(assetDirectory, assetName), "utf8");
  return staticJavaScriptImports(source);
}

async function javaScriptClosure(entryName) {
  const pending = [entryName];
  const closure = new Set();
  while (pending.length > 0) {
    const name = pending.pop();
    if (!name || closure.has(name)) continue;
    closure.add(name);
    for (const dependency of await assetJavaScriptImports(name)) {
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
const headerActionsEntry = assetNames.find((name) => /^WorkspaceHeaderActions-.*\.js$/u.test(name));
if (!headerActionsEntry) throw new Error("Missing deferred workspace header actions");
if (mainWorkbenchJavaScriptClosure.has(headerActionsEntry) || detachedChatJavaScriptClosure.has(headerActionsEntry)) {
  throw new Error("Workspace header actions must remain deferred from the initial routes");
}
const headerActionsJavaScriptClosure = await javaScriptClosure(headerActionsEntry);
const deferredWorkspaceHeaderActionsJavaScriptBytes = await closureBytes(
  headerActionsJavaScriptClosure,
  new Set([...entryJavaScriptClosure, ...mainWorkbenchJavaScriptClosure, ...detachedChatJavaScriptClosure]),
);
const gitMenuEntries = ["WorkspaceBranchMenu", "WorkspaceGitActionMenu"].map((prefix) => {
  const entry = assetNames.find((name) => name.startsWith(`${prefix}-`) && name.endsWith(".js"));
  if (!entry) throw new Error(`Missing deferred Git menu: ${prefix}`);
  if (mainWorkbenchJavaScriptClosure.has(entry)) throw new Error(`Git menu is eagerly loaded: ${prefix}`);
  return entry;
});
const gitMenuClosures = await Promise.all(gitMenuEntries.map(javaScriptClosure));
const deferredGitMenusJavaScriptBytes = await closureBytes(
  new Set(gitMenuClosures.flatMap((closure) => [...closure])),
  new Set([
    ...entryJavaScriptClosure,
    ...mainWorkbenchJavaScriptClosure,
    ...detachedChatJavaScriptClosure,
    ...headerActionsJavaScriptClosure,
  ]),
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
const projectFeatureEntries = ["ProjectSettings", "ConversationActionsMenu", "ReviewNoteDialog", "CliConversationImportDialog"].map((prefix) => {
  const entry = assetNames.find((name) => name.startsWith(`${prefix}-`) && name.endsWith(".js"));
  if (!entry) throw new Error(`Missing deferred project/thread surface: ${prefix}`);
  if (mainWorkbenchJavaScriptClosure.has(entry) || detachedChatJavaScriptClosure.has(entry)) {
    throw new Error(`Project/thread settings must remain deferred: ${prefix}`);
  }
  return entry;
});
const deferredCliConversationImportJavaScriptBytes = await assetBytes(`assets/${projectFeatureEntries[3]}`);
const deferredProjectSettingsJavaScriptBytes = await assetBytes(`assets/${projectFeatureEntries[0]}`);
const deferredThreadActionsJavaScriptBytes = await assetBytes(`assets/${projectFeatureEntries[1]}`);
const deferredReviewNoteJavaScriptBytes = await assetBytes(`assets/${projectFeatureEntries[2]}`);
const [projectCustomizeEntry, projectColorContrastEntry] = ["ProjectCustomizePanel", "project-color-contrast"].map((prefix) => {
  const entry = assetNames.find((name) => name.startsWith(`${prefix}-`) && name.endsWith(".js"));
  if (!entry) throw new Error(`Missing deferred project appearance surface: ${prefix}`);
  if (entryJavaScriptClosure.has(entry) || mainWorkbenchJavaScriptClosure.has(entry) || detachedChatJavaScriptClosure.has(entry)) {
    throw new Error(`Project appearance customisation must stay off the initial chat routes: ${prefix}`);
  }
  return entry;
});
const deferredProjectCustomizeJavaScriptBytes = await closureBytes(
  await javaScriptClosure(projectCustomizeEntry),
  new Set([...entryJavaScriptClosure, ...mainWorkbenchJavaScriptClosure, ...detachedChatJavaScriptClosure]),
);
const deferredProjectColorContrastJavaScriptBytes = await assetBytes(`assets/${projectColorContrastEntry}`);
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
const welcomeGuideEntry = assetNames.find((name) => /^WelcomeGuide-.*\.js$/u.test(name));
if (!welcomeGuideEntry) throw new Error("Missing deferred welcome guide");
if (mainWorkbenchJavaScriptClosure.has(welcomeGuideEntry) || detachedChatJavaScriptClosure.has(welcomeGuideEntry)) {
  throw new Error("The welcome guide must remain deferred from the initial workbench");
}
const deferredWelcomeGuideJavaScriptBytes = await closureBytes(await javaScriptClosure(welcomeGuideEntry), new Set([...entryJavaScriptClosure, ...mainWorkbenchJavaScriptClosure, ...detachedChatJavaScriptClosure]));
const workingOrbEntry = assetNames.find((name) => /^OrbCanvas-.*\.js$/u.test(name));
if (!workingOrbEntry) throw new Error("Missing deferred working indicator orb renderer");
if (entryJavaScriptClosure.has(workingOrbEntry) || mainWorkbenchJavaScriptClosure.has(workingOrbEntry) || detachedChatJavaScriptClosure.has(workingOrbEntry)) {
  throw new Error("The working indicator orb renderer must stay off the initial chat routes");
}
const deferredWorkingOrbJavaScriptBytes = await closureBytes(await javaScriptClosure(workingOrbEntry), new Set([...entryJavaScriptClosure, ...mainWorkbenchJavaScriptClosure, ...detachedChatJavaScriptClosure]));
const snapshotSettingsEntry = assetNames.find((name) => /^SnapshotSettings-.*\.js$/u.test(name));
if (!snapshotSettingsEntry) throw new Error("Missing deferred Snapshots settings");
if (entryJavaScriptClosure.has(snapshotSettingsEntry) || mainWorkbenchJavaScriptClosure.has(snapshotSettingsEntry) || detachedChatJavaScriptClosure.has(snapshotSettingsEntry)) {
  throw new Error("Snapshots settings must remain deferred from the initial chat routes");
}
// Charge only this feature's new module separately. Shared helpers stay in core.
const deferredSnapshotSettingsJavaScriptBytes = await assetBytes(`assets/${snapshotSettingsEntry}`);
const snapshotControlEntry = assetNames.find((name) => /^SnapshotControl-.*\.js$/u.test(name));
if (!snapshotControlEntry) throw new Error("Missing deferred screenshot review");
if (entryJavaScriptClosure.has(snapshotControlEntry) || mainWorkbenchJavaScriptClosure.has(snapshotControlEntry) || detachedChatJavaScriptClosure.has(snapshotControlEntry)) {
  throw new Error("Screenshot review must remain deferred from the initial chat routes");
}
const deferredSnapshotControlJavaScriptBytes = await assetBytes(`assets/${snapshotControlEntry}`);
const attachmentStorageSettingsEntry = assetNames.find((name) => /^AttachmentStorageSettings-.*\.js$/u.test(name));
if (!attachmentStorageSettingsEntry) throw new Error("Missing deferred attachment storage settings");
if (entryJavaScriptClosure.has(attachmentStorageSettingsEntry) || mainWorkbenchJavaScriptClosure.has(attachmentStorageSettingsEntry) || detachedChatJavaScriptClosure.has(attachmentStorageSettingsEntry)) {
  throw new Error("Attachment storage settings must remain deferred from the initial chat routes");
}
const deferredAttachmentStorageSettingsJavaScriptBytes = await assetBytes(`assets/${attachmentStorageSettingsEntry}`);
const backgroundTasksEntry = assetNames.find((name) => /^tasks-.*\.js$/u.test(name));
if (!backgroundTasksEntry) throw new Error("Missing deferred Background tasks surface");
if (entryJavaScriptClosure.has(backgroundTasksEntry) || mainWorkbenchJavaScriptClosure.has(backgroundTasksEntry) || detachedChatJavaScriptClosure.has(backgroundTasksEntry)) {
  throw new Error("Background tasks must remain deferred from the initial chat routes");
}
const deferredBackgroundTasksJavaScriptBytes = await assetBytes(`assets/${backgroundTasksEntry}`);
const tasksViewEntry = assetNames.find((name) => /^todo-.*\.js$/u.test(name));
if (!tasksViewEntry) throw new Error("Missing deferred Tasks view");
if (entryJavaScriptClosure.has(tasksViewEntry) || mainWorkbenchJavaScriptClosure.has(tasksViewEntry) || detachedChatJavaScriptClosure.has(tasksViewEntry)) {
  throw new Error("The Tasks view must remain deferred from the initial chat routes");
}
const deferredTasksViewJavaScriptBytes = await assetBytes(`assets/${tasksViewEntry}`);
const iconRegionEntry = assetNames.find((name) => /^iconRegion-.*\.js$/u.test(name));
if (!iconRegionEntry) throw new Error("Missing deferred Morphicons filled-icon region chunk");
if (entryJavaScriptClosure.has(iconRegionEntry) || mainWorkbenchJavaScriptClosure.has(iconRegionEntry) || detachedChatJavaScriptClosure.has(iconRegionEntry)) {
  throw new Error("The Morphicons filled-icon region code must load only when a filled icon morphs");
}
const deferredIconRegionJavaScriptBytes = await assetBytes(`assets/${iconRegionEntry}`);
const coreJavaScriptBytes =
  totalJavaScriptBytes
  - deferredLegacyPromptStashJavaScriptBytes
  - deferredUsageLimitsJavaScriptBytes
  - deferredWelcomeGuideJavaScriptBytes
  - deferredWorkingOrbJavaScriptBytes
  - deferredSnapshotSettingsJavaScriptBytes
  - deferredSnapshotControlJavaScriptBytes
  - deferredAttachmentStorageSettingsJavaScriptBytes
  - deferredCliConversationImportJavaScriptBytes
  - deferredBackgroundTasksJavaScriptBytes
  - deferredTasksViewJavaScriptBytes
  - deferredIconRegionJavaScriptBytes
  - deferredProjectSettingsJavaScriptBytes
  - deferredReviewNoteJavaScriptBytes
  - deferredThreadActionsJavaScriptBytes
  - deferredProjectCustomizeJavaScriptBytes
  - deferredProjectColorContrastJavaScriptBytes
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
  - deferredWorkspaceHeaderActionsJavaScriptBytes
  - detachedChatJavaScriptBytes
  - preMergeConfidenceJavaScriptBytes
  // The dependency and feature adapter each have strict ceilings above, so do
  // not charge the same isolated bytes to multiple independent budgets.
  - morphiconsJavaScriptBytes
  - morphingIconFeedbackJavaScriptBytes;
const measurements = {
  deferredLegacyPromptStashJavaScript: deferredLegacyPromptStashJavaScriptBytes,
  deferredUsageLimitsJavaScript: deferredUsageLimitsJavaScriptBytes,
  deferredWelcomeGuideJavaScript: deferredWelcomeGuideJavaScriptBytes,
  deferredWorkingOrbJavaScript: deferredWorkingOrbJavaScriptBytes,
  deferredSnapshotSettingsJavaScript: deferredSnapshotSettingsJavaScriptBytes,
  deferredSnapshotControlJavaScript: deferredSnapshotControlJavaScriptBytes,
  deferredAttachmentStorageSettingsJavaScript: deferredAttachmentStorageSettingsJavaScriptBytes,
  deferredBackgroundTasksJavaScript: deferredBackgroundTasksJavaScriptBytes,
  deferredTasksViewJavaScript: deferredTasksViewJavaScriptBytes,
  deferredIconRegionJavaScript: deferredIconRegionJavaScriptBytes,
  deferredProjectSettingsJavaScript: deferredProjectSettingsJavaScriptBytes,
  deferredCliConversationImportJavaScript: deferredCliConversationImportJavaScriptBytes,
  deferredReviewNoteJavaScript: deferredReviewNoteJavaScriptBytes,
  deferredThreadActionsJavaScript: deferredThreadActionsJavaScriptBytes,
  deferredProjectCustomizeJavaScript: deferredProjectCustomizeJavaScriptBytes,
  deferredProjectColorContrastJavaScript: deferredProjectColorContrastJavaScriptBytes,
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
  deferredWorkspaceHeaderActionsJavaScript: deferredWorkspaceHeaderActionsJavaScriptBytes,
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
