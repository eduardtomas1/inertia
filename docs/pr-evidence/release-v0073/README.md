# v0.0.73 release preparation

This branch starts from `v0.0.72` (`b3ffd630`, also `main`). It carries the
fixes found while using v0.0.72, the terminal launch improvement, every open
Dependabot update, the package and lockfile root version bump from 0.0.72 to
0.0.73, the curated 0.0.73 changelog section and this report. It adds no
database migration.

## Changes

| Commit | Change | Main evidence |
| --- | --- | --- |
| `32d8893f` | Turn minimap visible without hover | `timeline-minimap-presentation.test.ts`; `transcript.spec.ts` checks the track is opaque with the pointer away |
| `3f81922f` | Active panel tab never masked | `workspace-panel-tabs.dom.test.tsx`; packaged-renderer probe at a 160 px row: scrolled to the start the active tab shows cut at the edge instead of blank |
| `4bc2ca4e` | Window size kept after a whole-screen screenshot | `snapshot-review.test.ts`; on X11 the maximized window came back at 1440×932 before and stays 1920×969 after, through the real picker |
| `07994401` | More tools tray shared and never squeezed | `composer-shell.dom.test.tsx`; width sweep from 1440 px to the 260 px composer minimum with no tray or options overlap |
| `4081d661` | Send now on a queued message during a turn | `queued-message-runtime.test.ts`, `runtime-composer-queue.dom.test.tsx`, `composer-shell.dom.test.tsx`; `image-follow-up-regression.spec.ts` steers a queued message with two images into a running fake Codex turn |
| `32e4d879` | `--new-chat` and detached terminal launch | `launch-request.test.ts`, `launch-requests.dom.test.tsx`, `app-update-startup.test.ts`; the packaged app's AppRun under a pseudo-terminal returned the terminal in 0.3 s, added the folder as a project, and a second launch from a subfolder opened a chat in the running instance |
| `9e849ac7` | Dependabot #621 to #628 | full check, budgets measured per package, E2E below |

## Dependencies

| Package | From | To | Dependabot PR |
| --- | --- | --- | --- |
| `vitest`, `@vitest/coverage-v8` | 5.0.4 | 5.0.5 | #621 |
| `@tanstack/react-virtual` | 3.14.13 | 3.14.20 | #622 |
| `lucide-react` | 1.56.0 | 1.57.0 | #622 |
| `react`, `react-dom` | ^19.3.0 | ^19.3.1 | #622 |
| `@playwright/test` | ^1.64.0 | ^1.64.1 | #623 |
| `@opencode-ai/sdk` | 1.19.0 | 1.19.2 | #624 |
| `happy-dom` | 20.14.6 | 21.0.3 | #625 |
| `@anthropic-ai/claude-agent-sdk` | 0.3.296 | 0.3.301 | #626 |
| `morphicons` | 1.7.1 | 2.0.0 | #627 |
| `@anthropic-ai/sdk` | 0.133.0 | 0.135.0 | #628 |

- #624 and #626 failed CI on their own only because the capability manifests
  pin the bundled SDK version; the manifests now record 1.19.2 and 0.3.301,
  and the provider contract tests pass.
- #622 and #627 failed on renderer bundle budgets. Rebuilding with only
  `@tanstack/react-virtual` reverted attributed about 8.7 KB of first-load
  growth to `@tanstack/virtual-core` 3.17.11 to 3.19.5; react-dom 19.3.1 is
  byte-identical to 19.3.0.
- morphicons 2 loads its filled-icon region code on demand, but the
  morphicons manual chunk had pulled it into the workbench chunk (32.7 KiB).
  It is now the deferred `iconRegion` chunk (12,995 bytes), checked to stay
  out of the entry, main workbench and detached chat closures. Inertia morphs
  stroked Lucide icons only, which morphicons 2 leaves unchanged.
- happy-dom 21 disables CSS and iframe loading by default; the test setup set
  neither option, and the DOM suites pass unchanged.

## Verification

- `npm run check` passes: lint, typecheck, every unit and DOM suite, build
  and bundle budgets. Under load averages of 20 to 37, `inertia-connection`,
  `settings-composite-updates` and `prompt-stash-scope` timed out once each
  and passed when run alone three times.
- `npm run test:linux-package` passes.
- E2E on the final dependency set: `transcript`, `composer-stop-and-send`,
  both `image-follow-up-regression` tests and `panel-tab-drag`. The panel tab
  spec timed out once while four specs ran back to back at load 29 and passed
  three times alone.

## Not exercised

- The mounted (FUSE) AppImage relaunch: FUSE mounts are refused in the
  verification shell, so the AppImage path is covered by unit tests and the
  extracted AppRun run above.
- macOS terminal launch and Windows, where a second launch already returns
  the terminal.
