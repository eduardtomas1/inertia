# Sidebar updates and interactive recent attachments

Based on `main` at `cf3cb1ef0e2736ac6b12b188fd0dc01b718b6698`.
No release/version changes, dependency additions, provider-protocol changes, or personal-profile changes.

## Behavior

- The footer button checks directly, animates complete check rotations, shows a download badge and real progress ring, and becomes a restart action after download.
- Hover or keyboard focus opens compact anchored details. Arrow Up/Down enters the panel; Escape, outside click, and the close button dismiss it. Moving between the button and panel keeps it open. Reduced motion does not wait for an animation callback.
- Release notes belong to the exact offered version. Main bounds the response and text, reuses native metadata, and can request the canonical exact GitHub tag when feed metadata omits notes. Missing notes never invalidate an update. Cached metadata stays usable offline.
- Notes use the existing Markdown parser on demand, with raw HTML, images and links excluded. Only the existing main-authored release-page action opens a browser. No extra preload methods or network calls originate in the renderer.
- Restart requires explicit confirmation, defaults to **Not now**, and still goes through the existing main-process install coordinator. Active-work blocks and uncertain shutdown outcomes remain authoritative. Downloads remain cancellable.
- The old persistent floating update notice and dismissal storage are removed. Failure notifications remain available; a passive update badge no longer suspends the native browser preview. Open trusted details/confirmation still do.
- Recent attachments use the existing chat attachment cards: real image thumbnails, type/size labels, image/document previews, keyboard activation, focus restoration and missing-file feedback. The existing three-item bound and deduplication stay intact.
- Preview-only components now accept just the metadata they need. The environment summary still excludes filesystem paths and snapshot context; main resolves the existing attachment ID through the secure preview route.

Interaction reference: [T3 Code sidebar updater](https://github.com/pingdotgg/t3code/tree/6c583620ff7ad3235b135af7107c0543467eecfa/apps/web/src/components/sidebar). This implements that interaction pattern using Inertia's existing updater and theme tokens; it does not replace its platform update machinery.

## Verification and limits

The focused Electron scenarios run the real built application with an isolated profile and display. The update fixture uses the production service, install coordinator and IPC handlers; only the release transport/native downloader and an active-work gate are controlled. It checks real native popover/dialog geometry, hover, keyboard access, cancellation, download failure, progress, restart confirmation, and refusal before cleanup. It does **not** download a public installer or restart the user's app.

The attachment scenario imports and sends real fixture files, opens the retained secure previews, reloads them, and moves only a fixture copy to verify missing-file behavior. No real prompts, credentials, conversations or user screenshots are published.

Commands:

```sh
npm run check
npx playwright test tests/e2e/sidebar-update.spec.ts tests/e2e/recent-attachments.spec.ts --workers=1
```

Results: `npm run check` passed with **8,251 tests passed, 83 existing skips**, 760 passing files and 8 skipped files; migration, architecture, both lint passes, all TypeScript projects and renderer bundle gates passed. The final quality gate was repeated after the screenshot geometry assertions. Both Electron scenarios passed together in **22.6 seconds**, including centered confirmation and aligned-button assertions. The focused updater/main-install/IPC/controller batch passed **64 tests**.

Focused tests also cover note classification/bounds/exact tags/cache/timeouts, safe Markdown display, status/action mapping, stale invocation rejection, reduced motion, hover timing, keyboard dismissal, download cancellation, confirmation invalidation, main install/IPC safety, and environment preview/navigation.

Local platform: Linux x64, Node 22.23.2, Electron 44.2.0. Native macOS/Windows execution and signed/public installed-update delivery were not exercised. The new UI feature's deferred bundle allowance is measured separately (10.5 KiB, 10.75 KiB ceiling); existing entry, workbench, core and other feature ceilings are unchanged.

### CI follow-up: scoped assertions and native hover/focus ownership

The initial native CI failures on all six targets included the same post-restart preview selector: the shared attachment-card class now appears in both the transcript and Recent attachments. The old global selector matched both legitimate buttons. Local reproduction also exposed the equivalent retained-PDF ambiguity and global status selectors colliding with the new updater's accessibility announcement in tests that CI had not reached.

Attachment/health tests now use the existing Request/Message attachments list names, scope import status to the composer and health status to Local data. The native clipboard scenario explicitly asserts one matching preview in each surface before opening the original request's attachment. File hashes, dimensions, retention/restart, missing-file handling, IPC and process-cleanup assertions remain intact.

The final macOS x64 job also exposed a dismissed updater hover panel, subsequently reproduced locally. Moving from the panel back to its trigger stays inside their shared wrapper, so the wrapper's pointer-enter handler did not cancel the panel's close timer. The trigger now explicitly cancels that timer on entry, and the control retains pointer ownership across native focus loss when actions change. The controlled return-to-trigger regression failed before this fix and passed after it; an explicit native blur while hovering exercises this on every platform. Keyboard/outside dismissal remains covered. Another macOS failure concerned the transient diagnostics-copy label. That Electron assertion now verifies the actual native clipboard contents and exact turn/run identity, starting with a sentinel; the existing controlled DOM test continues to verify success feedback. There are no skipped tests or raised timeouts. Existing screenshots still represent the unchanged layout.

Final follow-up verification: `npm run check` passed with **8,253 tests passed and 83 existing skips**, including the final source, type checks and unchanged bundle ceilings. The focused update/diagnostics DOM batch passed **16 tests**. All **10 Electron scenarios passed together in 1.9 minutes** on the rebuilt app, covering image send/restart, retained PDF, attachment cleanup/runtime recovery, recent previews, update controls, local health and Quiet Ledger. An earlier run concurrent with another full check exceeded two existing desktop deadlines; the final run used an exclusive verification window and the same deadlines. Native macOS/Windows confirmation remains for CI; no next-run monitoring, merge, release or user-app restart was performed.

## Screenshots

Screenshots are captured by the scenarios above with synthetic release metadata and disposable local attachments. Versions `1.2.2`/`1.2.3` are fixture candidates, not released versions. The application itself retains its current version.

| Surface | Evidence |
| --- | --- |
| Current / checking | [Current](update-current-dark.png), [checking](update-checking-dark.png) |
| Available with notes / downloading | [Notes](update-available-dark.png), [progress](update-downloading-dark.png) |
| Ready, dark / light | [Dark](update-ready-dark.png), [light](update-ready-light.png) |
| Restart confirmation, dark / light | [Dark](update-confirm-dark.png), [light](update-confirm-light.png) |
| Download failure / active-work block / compact | [Failure](update-failed-dark.png), [block](update-blocked-light.png), [compact](update-compact-light.png) |
| Recent attachment cards, dark / light | [Dark](recent-attachments-dark.png), [light](recent-attachments-light.png) |
| Open image, dark / light | [Dark](recent-image-preview-dark.png), [light](recent-image-preview-light.png) |
| Document / unavailable file | [PDF](recent-document-preview-light.png), [missing](recent-missing-preview-light.png) |

## Changed areas

- `src/main/app-update.ts`, `app-update-release-notes.ts`, `electron-app-updater.ts`, `src/shared/desktop.ts`: bounded, version-matched note delivery through the existing status contract.
- `src/renderer/src/components/sidebar/SidebarUpdateControl*`, `UpdateStatusIcon.tsx`, `UpdateRestartConfirmation.tsx`, `UpdateReleaseNotes.tsx`, `appUpdatePresentation.ts`: deferred state-aware control and details.
- `Sidebar.tsx`, `SidebarProps.ts`, `AppLayout.tsx`, `AppStatusOverlays.tsx`, `hooks/useAppUpdate.ts`, `app-update.ts`, styles: integration and removal of the former notice.
- `EnvironmentPanel.tsx`, `SentMessageAttachmentList.tsx`, `AttachmentPreviewDialog.tsx`, `DocumentAttachmentPreview.tsx`, `utils/environmentSummary.ts`, `utils/composerAttachments.ts`: reusable, interactive attachment previews without exposing file paths.
- `electron.vite.config.ts`, `scripts/check-renderer-bundle.mjs`: keep the replacement update surface deferred and independently capped.
- `tests/main/app-update*`, renderer update/notes/environment/sidebar/overlay tests, `tests/e2e/{sidebar-update,recent-attachments}.spec.ts`, and their fixture helpers: deterministic behavioral and native UI evidence. The obsolete notice-only markup tests are replaced by controller/DOM/Electron behavior tests.

This PR is to remain open: no merge, release or CI monitoring requested.
