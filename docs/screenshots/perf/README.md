# Performance fixes: before and after

## PW4: fewer Git processes per refresh

Change: the Git metadata identity check (`repositoryMetadataMarkerIdentity`) asks for `--git-dir` and `--git-common-dir` in one `git rev-parse` instead of two, and falls back to the two separate probes when the output is not exactly two lines. `inspectRepositoryStatusAndHead` reads whether HEAD exists from the `# branch.oid` header of the status it already ran, instead of a separate `git rev-parse --verify HEAD`.

Git inspections per command on a one-repository fixture with a remote (`tests/server/git-refresh-spawn-count.test.ts` asserts the refresh count):

| Command | Before | After |
| --- | ---: | ---: |
| `git.refresh` | 10 | 7 |
| `git.workspace.refresh` | 9 | 6 |
| `git.diff` | 15 | 11 |
| `git.workspace.diff` | 17 | 13 |

Screen-open harness (`INERTIA_SCREEN_OPEN_RUNS=5 INERTIA_SCREEN_OPEN_ONLY=panel-changes,chat-switch-short,chat-switch-long npx playwright test --config playwright.screens.config.ts --max-failures=1`), production build, M5 Pro, N=5, input to paint in ms. Before is `perf/faster-app-2026-10` at 3f3a0e701 (1-minute load 3.0 to 3.5); after is this change (load 3.6 to 4.7).

| Screen | Before median | Before p95 | After median | After p95 |
| --- | ---: | ---: | ---: | ---: |
| Changes panel, cold | 1380.6 | 1414.4 | 1089.8 | 1106.4 |
| Changes panel, warm | 1722.3 | 1814.0 | 1381.3 | 1447.8 |
| Chat switch short, cold | 59.5 | 105.2 | 59.2 | 60.9 |
| Chat switch short, warm | 37.9 | 39.5 | 39.8 | 43.8 |
| Chat switch long, cold | 39.8 | 41.7 | 40.2 | 41.0 |
| Chat switch long, warm | 40.4 | 41.6 | 41.4 | 41.5 |

Raw values (ms): Changes cold before 1397.6, 1272.3, 1414.4, 1380.6, 1297; after 1106.4, 1062.9, 1089.8, 1097, 1089. Changes warm before 1722.3, 1655.5, 1814, 1771.9, 1647.1; after 1447.8, 1272.1, 1394.9, 1355.1, 1381.3.

Median round trip of the background `git.refresh` that every chat switch starts: 377 ms before, 279 ms after. On the Changes panel: `git.refresh` 461 to 289 ms, `git.diff` 903 to 702 ms, `git.workspace.diff` 898 to 780 ms. Chat switch paint does not wait for Git, so its rows are unchanged within noise.

### Tried and dropped

- Adaptive guardian sleep (1, 2, 4, 8, 16 ms, then the 20 ms cap) in the macOS `ready` poll. The guardian already waits for the payload exit with a kqueue `NOTE_EXIT` event, and a trace of every sleep on the Git path showed none of the 20 ms sleeps runs in the normal case; the `ready` helper misses its first check in about 1 of 30 inspections. `runGitInspection` with the guardian (30 samples, three interleaved A/B rounds, load 4.1 to 4.6): baseline 43.2, 43.0, 43.0 ms median; adaptive 44.0, 61.0, 43.0 ms. No gain, so no native change.
- Requesting the root `git.diff` as soon as `git.refresh` returns instead of after `git.workspace.refresh`: Changes cold 1105.5 ms median (p95 1114.4), warm 1336.8 (p95 1405.6), against 1089.8 and 1381.3 without it. Both refreshes finish at about the same time, so there is nothing to overlap.

### Where the remaining Git time goes

One guardian-owned `git rev-parse` costs 44.0 ms median (p95 46.5) against 3.0 ms unguarded (`tests/performance/git-spawn.benchmark.test.ts`, 30 samples, load 4.6). Of that, about 22 ms is three synchronous runtime-ownership journal writes (begin 7.6, claim 7.8, release 7.0 ms median, each a durable fsync on the runtime's event loop), about 15 ms is the guardian process itself (Git plus three process-tree censuses during the bounded drain), and about 4.5 ms is three helper processes (`ready` and two `identity` reads).

## PW5: startup

Instrument: `tests/performance/startup-profile.spec.ts` in spawn mode (`INERTIA_STARTUP_MODE=spawn`, no Playwright attached, `--use-mock-keychain` on macOS), with the local startup marks patch applied to a production `npm run build:bundle` build. 300-turn active chat (25 chats in 3 projects) unless noted; 3,000-turn runs use `INERTIA_STARTUP_LONG_TURNS=3000`. Cold is a fresh Electron profile and a database the app has never opened; warm relaunches the same profile and database. Times are ms from launch, median / p95. Apple M5 Pro, macOS 27, Electron 44.7. The harness waits for a 1-minute load below 4 before each launch; the load columns give the range seen before and after the launches. Raw JSON stays in the untracked `performance-results/startup/`.

The first cold launch of each baseline series is the first launch after a fresh build (about 1.5 s); it inflates the cold p95 of the baseline columns.

### All startup fixes together

Baseline is the branch with only the mock keychain harness change; after is `work/perf-fix-startup` at the last fix.

| metric (ms from launch, median / p95) | before | after | N | load (1 min) |
|---|---:|---:|---:|---|
| Window ready-to-show, warm | 301.6 / 331.1 | 300.4 / 307.3 | 7 / 7 | 1.9-3.9 / 1.4-2.5 |
| App shell painted, warm | 350.7 / 380.0 | 346.8 / 355.0 | 7 / 7 | 1.9-3.9 / 1.4-2.5 |
| Runtime ready posted, warm | 545.7 / 573.6 | 472.4 / 481.9 | 7 / 7 | 1.9-3.9 / 1.4-2.5 |
| Sidebar and composer painted, warm | 610.9 / 722.3 | 517.3 / 526.8 | 7 / 7 | 1.9-3.9 / 1.4-2.5 |
| First transcript row, warm | 682.1 / 722.4 | 570.4 / 585.4 | 7 / 7 | 1.9-3.9 / 1.4-2.5 |
| Sidebar and composer painted, cold | 627.7 / 2352.8 | 512.5 / 727.1 | 7 / 7 | 1.9-6.0 / 1.4-2.5 |
| First transcript row, cold | 683.7 / 2352.9 | 563.6 / 776.3 | 7 / 7 | 1.9-6.0 / 1.4-2.5 |
| 3,000 turns: WebSocket created, cold | 552.6 / 563.9 | 477.9 / 701.5 | 7 / 7 | 1.9-2.4 / 1.6-2.1 |
| 3,000 turns: WebSocket accepted, cold | 789.1 / 798.3 | 482.1 / 705.7 | 7 / 7 | 1.9-2.4 / 1.6-2.1 |
| 3,000 turns: first transcript row, cold | 874.6 / 885.6 | 574.8 / 801.8 | 7 / 7 | 1.9-2.4 / 1.6-2.1 |
| 3,000 turns: first transcript row, warm | 679.3 / 700.8 | 581.2 / 607.0 | 7 / 7 | 1.9-2.4 / 1.6-2.1 |

Full shell snapshots sent after the welcome on warm launches: 2 in every launch before, 0 in every launch after.

### Missing turn artifacts in one transaction

Before: baseline. After: this fix alone.

| metric (ms from launch, median / p95) | before | after | N | load (1 min) |
|---|---:|---:|---:|---|
| 3,000 turns: WebSocket created, cold | 552.6 / 563.9 | 550.9 / 562.5 | 7 / 7 | 1.9-2.4 / 2.2-2.6 |
| 3,000 turns: WebSocket accepted, cold | 789.1 / 798.3 | 617.7 / 626.6 | 7 / 7 | 1.9-2.4 / 2.2-2.6 |
| 3,000 turns: sidebar and composer painted, cold | 824.9 / 833.3 | 653.6 / 662.0 | 7 / 7 | 1.9-2.4 / 2.2-2.6 |
| 3,000 turns: first transcript row, cold | 874.6 / 885.6 | 706.5 / 716.5 | 7 / 7 | 1.9-2.4 / 2.2-2.6 |
| 3,000 turns: first transcript row, warm | 679.3 / 700.8 | 682.7 / 690.3 | 7 / 7 | 1.9-2.4 / 2.2-2.6 |
| 300 turns: WebSocket accepted, cold | 591.9 / 2230.7 | 578.5 / 811.3 | 7 / 7 | 1.9-6.0 / 2.0-3.8 |
| 300 turns: first transcript row, cold | 683.7 / 2352.9 | 667.1 / 900.9 | 7 / 7 | 1.9-6.0 / 2.0-3.8 |

The reconcile of 3,000 missing rows measured in a unit run: 280 ms before, 116 ms after, of which the batched insert is 28 ms, the turn query 12 ms and the asynchronous patch-directory prune the rest. With the post-ready deferral below, none of it delays the first connection any more.

### Runtime started before the main window

Before: artifact fix. After: plus this fix.

| metric (ms from launch, median / p95) | before | after | N | load (1 min) |
|---|---:|---:|---:|---|
| Runtime fork requested, warm | 297.5 / 302.9 | 222.5 / 239.8 | 7 / 7 | 2.0-3.7 / 2.2-3.2 |
| Window ready-to-show, warm | 299.1 / 304.6 | 303.1 / 319.2 | 7 / 7 | 2.0-3.7 / 2.2-3.2 |
| App shell painted, warm | 348.2 / 353.6 | 342.6 / 365.6 | 7 / 7 | 2.0-3.7 / 2.2-3.2 |
| Runtime ready posted, warm | 542.6 / 548.5 | 470.9 / 508.4 | 7 / 7 | 2.0-3.7 / 2.2-3.2 |
| Sidebar and composer painted, warm | 606.6 / 612.8 | 537.3 / 590.6 | 7 / 7 | 2.0-3.7 / 2.2-3.2 |
| First transcript row, warm | 670.2 / 820.2 | 600.7 / 649.2 | 7 / 7 | 2.0-3.7 / 2.2-3.2 |
| Window ready-to-show, cold | 299.4 / 302.6 | 304.2 / 328.5 | 7 / 7 | 2.0-3.8 / 2.2-3.2 |
| App shell painted, cold | 348.9 / 378.0 | 347.1 / 361.9 | 7 / 7 | 2.0-3.8 / 2.2-3.2 |
| Sidebar and composer painted, cold | 612.8 / 846.2 | 569.1 / 749.6 | 7 / 7 | 2.0-3.8 / 2.2-3.2 |
| First transcript row, cold | 667.1 / 900.9 | 626.9 / 799.6 | 7 / 7 | 2.0-3.8 / 2.2-3.2 |

### Unchanged snapshot broadcasts skipped

Before: runtime-first fix. After: plus this fix. The gain is renderer work after first paint (two 52 KB snapshot parses and full re-renders per launch), not first paint.

| metric (ms from launch, median / p95) | before | after | N | load (1 min) |
|---|---:|---:|---:|---|
| Sidebar and composer painted, warm | 537.3 / 590.6 | 543.2 / 546.5 | 7 / 7 | 2.2-3.2 / 1.8-2.6 |
| First transcript row, warm | 600.7 / 649.2 | 598.3 / 890.0 | 7 / 7 | 2.2-3.2 / 1.8-2.6 |
| First transcript row, cold | 626.9 / 799.6 | 596.6 / 1179.7 | 7 / 7 | 2.2-3.2 / 1.8-2.6 |

Full snapshots after the welcome, warm: 2,2,2,1,1,2,2 before and 0 in all seven after. First launches still send them because their post-ready work changes the snapshot. The p95 values come from launches whose transcript row appeared about 300 ms after its detail arrived; the same pattern shows in the artifact-fix run (820 ms warm) and did not recur in the 21 warm launches of the later runs, which include this change.

### First client before post-ready work

Before: snapshot fix. After: plus this fix.

| metric (ms from launch, median / p95) | before | after | N | load (1 min) |
|---|---:|---:|---:|---|
| WebSocket created, warm | 477.2 / 479.0 | 476.3 / 479.5 | 7 / 7 | 1.8-2.6 / 1.9-2.4 |
| WebSocket accepted, warm | 506.7 / 510.6 | 478.7 / 482.6 | 7 / 7 | 1.8-2.6 / 1.9-2.4 |
| Detail request reaches the runtime, warm | 542.5 / 550.9 | 527.2 / 539.5 | 7 / 7 | 1.8-2.6 / 1.9-2.4 |
| Sidebar and composer painted, warm | 543.2 / 546.5 | 515.7 / 519.3 | 7 / 7 | 1.8-2.6 / 1.9-2.4 |
| First transcript row, warm | 598.3 / 890.0 | 573.4 / 589.1 | 7 / 7 | 1.8-2.6 / 1.9-2.4 |
| WebSocket accepted, cold | 502.5 / 922.2 | 472.8 / 724.2 | 7 / 7 | 1.8-2.6 / 1.9-2.5 |
| First transcript row, cold | 596.6 / 1179.7 | 564.6 / 815.3 | 7 / 7 | 1.8-2.6 / 1.9-2.5 |

### Startup: tried and dropped

Both measured against the baseline above (300 turns, 7 launches, spawn mode), as ablations that remove the cost outright, so each figure is an upper bound on what a real fix could gain.

| ablation | metric (median / p95 ms) | baseline | ablation | load (1 min) |
|---|---|---:|---:|---|
| Do not wait for `prepareGitExecutable` at all | runtime ready posted, warm | 545.7 / 573.6 | 521.2 / 527.3 | 1.9-3.9 / 2.2-3.5 |
| | runtime ready posted, cold | 540.2 / 2183.0 | 520.1 / 714.1 | 1.9-6.0 / 2.2-3.5 |
| Start `prepareGitExecutable` early and join it before listening | runtime ready posted, warm | 545.7 / 573.6 | 535.0 / 553.9 | 1.9-3.9 / 2.3-3.6 |
| Answer the snapshot permission check without asking macOS | detail received to first transcript row, warm | 60.0 | 60.2 | 1.9-3.9 / 2.6-3.9 |

Git location off the readiness path: the plan required at least 25 ms on the runtime-ready mark. Dropping the wait entirely gains 24.5 ms warm, because most of the step is synchronous journal work on the same thread, and doing so would turn a startup failure into a later one and let early Git commands spend their own deadlines waiting for discovery. The variant that keeps the startup guarantees gains 10.7 ms. Not shipped.

Snapshot permission caching: removing both macOS permission calls changes nothing measurable on the path to the first transcript row, so caching them cannot either. Not shipped.

## Screen opens: preloaded screens render without the Suspense delay (PW3)

React 19 holds back a lazy component for up to 300 ms after its Suspense fallback appears, and `React.lazy` suspends on its first render even when the code has already been fetched. Usage, the Usage Limits tab, the Limits dialog, Daily work, Tasks, the terminal dock and the model chooser's source list now render through `useLoadedSurface` (the hook Settings and the command palette already use), and the idle prefetch loads their code. A chunk that fails to load still reaches the window error boundary.

Measured with `INERTIA_SCREEN_OPEN_RUNS=5 npx playwright test --config playwright.screens.config.ts --max-failures=1` on an Apple M5 Pro (macOS 27), production build, input to the painted, settled screen. Before is `perf/faster-app-2026-10` at 3f3a0e701; after is the same harness on this change.

| Screen | Phase | Before median / p95 (ms) | After median / p95 (ms) | N | Load (1 min) before / after |
| --- | --- | ---: | ---: | ---: | --- |
| usage | cold | 338.9 / 339.3 | 31.3 / 39.2 | 5 | 1.6-2.5 / 2.2-2.8 |
| usage | warm | 30.2 / 38.5 | 30.6 / 36.3 | 5 | 1.6-2.5 / 2.2-2.8 |
| usage-limits-tab | cold | 314.2 / 323.8 | 14.2 / 15.7 | 5 | 1.6-2.5 / 2.2-2.8 |
| usage-limits-tab | warm | 13.6 / 14.7 | 14.4 / 14.8 | 5 | 1.6-2.5 / 2.2-2.8 |
| limits-dialog | cold | 339 / 339.3 | 30 / 36.2 | 5 | 1.6-2.5 / 2.2-2.8 |
| limits-dialog | warm | 30.5 / 31.3 | 30.7 / 36.2 | 5 | 1.6-2.5 / 2.2-2.8 |
| daily-work | cold | 338.5 / 339.1 | 37.6 / 39.1 | 5 | 1.6-2.5 / 2.2-2.8 |
| daily-work | warm | 31.1 / 32.1 | 31.6 / 37.7 | 5 | 1.6-2.5 / 2.2-2.8 |
| tasks | cold | 322 / 322.7 | 31.2 / 142.9 | 5 | 1.6-2.5 / 2.2-2.8 |
| tasks | warm | 30 / 30.9 | 31.3 / 36 | 5 | 1.6-2.5 / 2.2-2.8 |
| terminal | cold | 355.2 / 356 | 54.5 / 55.4 | 5 | 1.6-2.5 / 2.2-2.8 |
| terminal | warm | 39.5 / 46.9 | 39.6 / 47.7 | 5 | 1.6-2.5 / 2.2-2.8 |
| model-chooser | cold | 314.7 / 323 | 31 / 31.3 | 5 | 1.6-2.5 / 2.2-2.8 |
| model-chooser | warm | 29.7 / 31 | 31.3 / 32.2 | 5 | 1.6-2.5 / 2.2-2.8 |

The one slow Tasks sample (142.9 ms) had its content at 14.8 ms and a late paint; the baseline Settings row shows the same kind of single late paint (310 ms p95) without this change.

## Screen opens: detached chat window transcript (PW3)

A Chromium trace of the detached window on the baseline showed the chat area mounted at about 142 ms after navigation, React installed a 273 ms timer at that moment, and the 49 ms render that put the transcript on screen ran when that timer fired at 416 ms: the same 300 ms fallback throttle on the lazy `ResponseTimeline`. The window now starts loading the transcript code as soon as its own code runs, and `ChatWorkspace` renders the transcript through `useLoadedSurface`.

Same harness and machine. Before is the screen-open change above; after adds this change.

| Screen | Phase | Before median / p95 (ms) | After median / p95 (ms) | N | Load (1 min) before / after |
| --- | --- | ---: | ---: | ---: | --- |
| detached-window | cold | 489.8 / 496.4 | 188.9 / 192.8 | 5 | 2.2-2.8 / 2.0-4.2 |
| detached-window | warm | 494.6 / 498.2 | 188 / 193.5 | 5 | 2.2-2.8 / 2.0-4.2 |
| chat-switch-short | cold | 60.8 / 61.2 | 60 / 63.5 | 5 | 2.2-2.8 / 2.0-4.2 |
| chat-switch-short | warm | 40.9 / 41.6 | 38.4 / 40.2 | 5 | 2.2-2.8 / 2.0-4.2 |
| chat-switch-long | cold | 41.4 / 41.8 | 39.3 / 41.1 | 5 | 2.2-2.8 / 2.0-4.2 |
| chat-switch-long | warm | 41.7 / 42.2 | 41.4 / 42.6 | 5 | 2.2-2.8 / 2.0-4.2 |

Time from navigation start to the transcript: about 464 ms before, about 159 ms after.

## Tried and dropped: Settings section scroll after the commit (PW3)

Moving the Settings navigation `scrollIntoView` from a layout effect to the next animation frame did not change the Settings open time; the forced style and layout it triggers (about 8 ms) is work the first paint needs anyway. The change was reverted.

| Screen | Phase | Before median / p95 (ms) | After median / p95 (ms) | N | Load (1 min) before / after |
| --- | --- | ---: | ---: | ---: | --- |
| settings | cold | 55 / 55.7 | 55.5 / 55.9 | 5 | 2.0-4.2 / 2.5-3.4 |
| settings | warm | 47.1 / 47.2 | 47.6 / 48.4 | 5 | 2.0-4.2 / 2.5-3.4 |

## Screen opens: bundle and desktop benchmark (PW3)

The screens stay in their own chunks and no renderer budget changed. Against 3f3a0e701: main workbench first load 871,662 → 872,111 bytes (+449), detached chat first load 666,811 → 666,924 (+113), detached chat chunk 11,110 → 11,123 (+13), shared core 2,289,856 → 2,289,764 (−92), Tasks chunk 20,954 → 20,944 (−10); the background tasks, thread actions and terminal chunks grew by 1 byte each.

`npm run benchmark:desktop:built`, three runs per build (load 2.2–5.5):

| Metric | Before (runs) | After (runs) |
| --- | --- | --- |
| Terminal startup (ms) | 371.7, 367.7, 382.0 | 72.6, 63.3, 59.4 |
| Split chat interactive (ms) | 270.3, 264.8, 281.0 | 368.1, 365.3, 367.9 |
| Long conversation scroll p95 frame (ms) | 8.8, 8.4, 8.5 | 9.3, 8.4, 8.4 |
| First streamed delta to paint (ms) | 20, 19, 17 | 17, 19, 21 |
| Streaming p95 visible gap (ms) | 75.9, 75.7, 75.7 | 75.6, 75.5, 75.6 |
| Warm startup first window (ms) | 297.6, 279.8, 302.0 | 279.1, 290.3, 301.0 |

The benchmark opens the split immediately after the terminal. With a 1.5 s pause inserted before the split (local experiment, not committed) the split takes 388.3 ms before and 292.0 ms after, so the split itself is not slower; its time depends on what is still in flight when it starts, and the terminal now finishes about 300 ms sooner.

## PW6: provider refresh

Instrument: `tests/performance/provider-refresh.benchmark.test.ts` (`INERTIA_PROVIDER_REFRESH_RUNS=3 npx vitest run --config vitest.benchmark.config.ts tests/performance/provider-refresh.benchmark.test.ts`; `INERTIA_PROVIDER_REFRESH_SCALES` picks the slow-down factors). It drives the production `ProviderManager`, `detectProvider`, `ProviderMetadataCache` and `createProviderInfoRefresh` against a fake Claude CLI (`tests/helpers/claude-refresh-fixture.ts`) that answers `--version`, `auth status --json` and the pinned Agent SDK control protocol (`initialize`, `get_usage`), with every process owned by the macOS runtime guardian as in the app. No real provider CLI runs. The fake's delays are assumptions, not measurements of the real CLI: process start 150 ms, sign-in check 400 ms, SDK `initialize` 1,000 ms, usage read 500 ms, exit after EOF 150 ms. "5x" and "10x" multiply every delay (a slow or saturated machine, emulated by delays, never by CPU load). "With Cursor" adds a fake `cursor-agent` (start 300 ms, `status` 800 ms, same factor) to show one slower provider beside Claude. Times are from the start of the refresh, median of 3 runs (1 run at 20x), Apple M5 Pro, 1-minute load 2.1 to 2.5. States are the provider label the renderer would show (`providerStateLabel`). Raw JSON stays in the untracked `performance-results/`.

The pipeline for one Claude refresh, before and after: three processes, strictly in sequence. `claude --version` (credential-free), then `claude auth status --json` (credentialed, only after the version answer identified the executable), then one SDK session that answers the model catalog and the usage windows together (`initialize` and `get_usage` in parallel); the Usage screen and skills discovery are separate reads and are not part of a refresh. About 100 ms pass between one fake process exiting and the next one starting (guardian, ownership journal and the fake's own Node start). "Refresh" and "Refresh all providers" force the catalog read; launch, post-turn and idle reads honour the catalog TTL (5 minutes) and the usage TTL.

| Deadline | Before | After |
| --- | --- | --- |
| `--version` | 4 s | 4 s |
| `auth status`, `acp`/`app-server`/`serve --help` | 4 s | 4 s, stretched by the version answer's latency over 500 ms (1.25 s answer: 10 s), at most 30 s |
| SDK catalog and usage session | 6 s, all answers dropped on timeout | 6 s, stretched the same way, at most 30 s; an answered catalog is kept when usage misses the deadline |
| Timed-out detection retries (1, 3, 9 s apart) | 4 s each | 8, 16, 16 s |
| Failed catalog read | kept stale until the next refresh or turn | retried in the background 1, 3, 9 s later with 2x, 4x, 8x the deadline |
| Post-turn and idle catalog reads | 6 s | stretched by the latest detection's version latency |

Results, Connected / models shown / settled (last state change), and the processes the fake Claude saw:

| Scenario | Before | After |
| --- | --- | --- |
| 1x launch | 1.14 / 2.57 / 2.57 s, 3 processes, Connected with models | 1.10 / 2.52 / 2.52 s, 3 processes, same |
| 1x Refresh (forced catalog) | 0.92 / 0.92 / 2.34 s, 3 processes | 0.93 / 0.93 / 2.36 s, 3 processes |
| 1x launch with Cursor | 2.19 / 3.61 / 3.61 s | 1.10 / 2.50 / 2.50 s |
| 5x launch | 3.94 / 10.57 / 10.57 s | 3.94 / 10.55 / 10.55 s |
| 5x Refresh | 3.74 / 3.74 / 10.36 s | 3.74 / 3.74 / 10.37 s |
| 5x launch with Cursor | 7.97 / 14.60 / 16.78 s | 3.91 / 10.53 / 10.53 s |
| 10x launch | never; Checking, then Connection issue at 37.9 s, 4 version and 4 sign-in processes, no models | 7.44 / 20.56 / 20.56 s, 3 processes, Connected with models |
| 10x Refresh | never; Connection issue at 37.7 s, no models | 7.24 / 7.24 / 20.37 s, Connected with models |
| 10x launch with Cursor | never; Connection issue at 42.4 s | 7.47 / 20.59 / 20.59 s |
| 20x launch | never; Connection issue at 43.9 s | 14.45 / 39.83 / 39.83 s, Connected with models |
| 20x Refresh | never; Connection issue at 43.7 s | 14.23 / 14.23 / 39.62 s, Connected with models |

State sequences: before, 10x and 20x go Checking ("slow to respond; checking again") three times and end on Connection issue, because every retry gave the sign-in check the same 4 s while it needed 5.5 s (11 s at 20x). After, every scale goes Checking, Connected, Connected with models at launch, and stays Connected with the cached models throughout a refresh. Nothing reports Not responding, Detection failed or Connection issue at 5x, 10x or 20x.

With a second, slower provider installed, Claude used to stay Checking until every provider's detection finished, because the broad refresh published all providers together; it now publishes each provider as its own detection completes (Connected 50 to 51% sooner at 1x and 5x, models 28 to 31% sooner) and a provider whose detection fails no longer turns every other provider into "Agent discovery failed". The launch sends a few more snapshots as providers arrive (6 instead of 3 in the 1x Cursor scenario; arrivals in the same event-loop turn share one broadcast).

The plan's 50% target for a single forced Claude refresh at normal speed is not met: 2.34 s before, 2.36 s after. The three processes are strictly ordered by design (the credentialed sign-in check only after the credential-free version probe identified the executable; the catalog read only for a signed-in, runnable install), and the SDK session alone is 1.42 of the 2.34 s. Measured for a decision, not shipped: a refresh that honours the catalog and usage TTLs when the executable, version and sign-in are unchanged finishes in 0.93 s at 1x, 3.74 s at 5x and 7.24 s at 10x (60 to 64% less), because it skips the SDK session; it re-reads at once when the version, executable or sign-in changed, but it can show usage windows up to the usage TTL old after a press of Refresh. That is a product decision.

### Provider refresh: tried and dropped

- Reusing the `--version` answer for an unchanged executable file: worth about 330 ms of the 2.34 s refresh at 1x (14%), but the probe is also the liveness and identity proof the installation authority settles on, and a broken binary with an unchanged file would then be classified by the sign-in check instead ("Sign in required" rather than "Detection failed"). Not done.
- Starting the sign-in check or the SDK session alongside the version probe: would hand credentials to a candidate before it answered `--version`, and the best case still leaves the SDK session on the critical path (about 37% at 1x). Not done.

## Scrolling: render rows synchronously only when the viewport leaves them

Before: the transcript virtualizer flushed a synchronous React render on
every scroll event that moved its range. After: scroll events that stay
inside the rows already rendered (overscan included) paint first and
render in the next task; leaving the rendered rows or a row measurement
still renders synchronously.

| Metric | Before | After | N | Load |
| --- | --- | --- | --- | --- |
| Missed refreshes, 300 turns, wheel up | 4.19% (4.32) | 1.66% (2.46) | 5 | 1.8-5.2 |
| Missed refreshes, 300 turns, wheel down | 3.59% (3.73) | 1.93% (2.26) | 5 | 1.8-5.2 |
| Missed refreshes, 300 turns, thumb drag up | 15.66% (23.25) | 11.13% (11.48) | 5 | 1.8-5.2 |
| Missed refreshes, 300 turns, thumb drag down | 12.13% (12.78) | 2.29% (2.99) | 5 | 1.8-5.2 |
| Missed refreshes, 2,000 turns, wheel up | 4.07% (4.28) | 1.52% (1.86) | 5 | 1.8-5.2 |
| Missed refreshes, 2,000 turns, wheel down | 3.01% (3.26) | 1.27% (1.47) | 5 | 1.8-5.2 |
| Missed refreshes, 2,000 turns, thumb drag up | 57.02% (57.48) | 56.34% (57.07) | 5 | 1.8-5.2 |
| Mean blank viewport, 2,000 turns, thumb drag up | 6.75% (7.29) | 6.71% (7.19) | 5 | 1.8-5.2 |
| p95 frame, 300 turns, thumb drag down | 16.7 ms | 10.2 ms | 5 | 1.8-5.2 |
| Missed refreshes, streaming, wheel up | 3.86% (6.25) | 3.37% (3.81) | 5 | 1.8-5.2 |

Tried and dropped: turning synchronous renders off entirely
(`useFlushSync: false`) reached 1.26% missed on the 300-turn drag up but
raised the mean blank viewport on the 2,000-turn drag up from 6.75% to
33.3% (N=5, load 2.1-4.1).

## Transcript navigation: keep the state when a scroll does not change the mode

Before: every intentional scroll event created a new navigation state,
so `ChatWorkspace` and its unmemoised children rendered on each wheel
tick. After: the reducer returns the current state when the mode is
unchanged.

| Metric | Before | After | N | Load |
| --- | --- | --- | --- | --- |
| Components rendered, 300 turns, wheel up | 10,343 | 1,913 | 5 / 4 | 2.0-3.2 |
| Components rendered, 300 turns, wheel down | 10,688 | 2,228 | 5 / 4 | 2.0-3.2 |
| Components rendered, 2,000 turns, wheel up | 10,415 | 1,914 | 5 | 2.0-3.2 |
| Components rendered, 2,000 turns, wheel down | 10,060 | 2,308 | 5 | 2.0-3.2 |
| Main-thread busy, 2,000 turns, wheel up | 2,922 ms | 2,850 ms | 3 | 1.7-2.9 |
| Main-thread busy, 2,000 turns, wheel down | 2,544 ms | 2,465 ms | 3 | 1.7-2.9 |

Frame timings were already inside the refresh budget on wheel scrolling
and did not change. One after-run (300 turns) ended above load 6 and was
discarded, hence N=4 there.

## Markdown and code highlighting: reuse results when rows remount

Before: a row that scrolled back into view, or a chat opened again,
parsed its Markdown and highlighted its code again. After: settled
Markdown trees and highlighted code are kept in bounded caches (500
entries each, 1.5M and 4M characters); streaming Markdown is not cached.

| Metric | Before | After | N | Load |
| --- | --- | --- | --- | --- |
| Detail result to visible rows, 2,000-message chat, warm open | 26.5 ms (27.1) | 18.8 ms (19.4) | 5 | 1.7-2.6 |
| Detail result to visible rows, 300-message chat, warm open | 26.7 ms (28.6) | 19.1 ms (19.5) | 5 | 1.7-2.6 |
| Click to visible, 2,000-message chat, warm open | 67.5 ms (69.6) | 59.9 ms (62.0) | 5 | 1.7-2.6 |
| Click to visible, reopen after older pages | 64.1 ms (65.9) | 59.0 ms (60.3) | 5 | 1.7-2.6 |
| Detail result to visible rows, 2,000-message chat, cold open | 26.3 ms | 27.1 ms | 5 | 1.7-2.6 |
| Jump to latest after loading 2,000 turns | 59.7 ms | 48.8 ms | 5 | 2.0-5.5 |
| Main-thread busy, 2,000 turns, second drag over the same range | 5,327 ms | 4,959 ms | 3 | 1.7-2.6 |
| Missed refreshes, 2,000 turns, thumb drag down | 46.99% | 44.92% | 5 | 2.0-5.5 |

Wheel and thumb-drag frame timings were compared in interleaved runs
(before and after alternating) and stayed within noise.

## Row height estimates: price Markdown by the rendered answer typography

Before: Markdown prose and list lines were priced at 25 px, every heading
at 30 px, every list item and table line as its own block with a 12 px
gap, and table delimiter rows as rendered rows. The rendered answer uses
14.5 px text at 1.6 line height (23.2 px), 24 px and 20 px headings,
6 px between list items and 36 px table rows below a 24 px toolbar.
After: the estimate uses those values and prices a list or a table as
one block.

| Metric | Before | After | N | Load |
| --- | --- | --- | --- | --- |
| Estimated height before measuring, 300 turns (measured 358,282 px) | 388,139 px (+8.3%) | 363,351 px (+1.4%) | 5 | 2.2-4.3 |
| Estimated height before measuring, 2,000 turns (measured about 2,390,000 px) | 2,597,385 px (+8.4%) | 2,424,697 px (+1.5%) | 5 | 2.2-4.3 |
| Mean blank viewport, 2,000 turns, thumb drag up | 6.34% (8.31) | 1.41% (1.42) | 5 | 2.2-4.3 |
| Mean blank viewport, 2,000 turns, thumb drag down | 1.18% (2.04) | 0.42% (0.57) | 5 | 2.2-4.3 |
| Missed refreshes, 300 turns, thumb drag up | 8.03% (10.02) | 7.73% (11.84) | 5 | 2.2-4.3 |
| Missed refreshes, 2,000 turns, thumb drag up | 55.97% (56.68) | 55.51% (56.24) | 5 | 2.2-4.3 |
| Missed refreshes, 2,000 turns, wheel up | 2.52% (2.67) | 1.67% (3.26) | 5 | 2.2-4.3 |

Before and after runs alternated. Jump to latest after loading 2,000
turns was bimodal in both builds (45-59 ms after, 48-58 ms in earlier
runs of the same before build), so its median is not a reliable
comparison here; the desktop benchmark below covers it.

## Sidebar: reuse one relative-time formatter

Before: every sidebar row label built a new `Intl.RelativeTimeFormat`.
After: one module-level formatter is reused.

| Metric | Before | After | N | Load |
| --- | --- | --- | --- | --- |
| Main-thread busy, 500-chat sidebar, wheel down | 2,728 ms | 2,477 ms | 3 | 2.6-2.8 |
| Main-thread busy, 500-chat sidebar, wheel up | 2,678 ms | 2,146 ms | 3 | 2.6-2.8 |
| Main-thread busy, wheel down while streaming | 2,747 ms | 2,597 ms | 3 | 2.6-2.8 |

Tried and dropped: updating the sidebar window only when its visible
index range changes made no difference (678 commits per wheel pass
before and after, N=5), because at wheel speed the range changes on
almost every event. Keeping the window until the visible rows come
within four rows of its edge cut commits from 678 to 190 and rendered
components from 320,685 to 45,859 per pass, but each re-centre mounted
several rows at once and produced one 16.7 ms frame in most passes
(maximum frame 9.4 ms before; missed refreshes 0% to 0.28%, N=5), so it
was not kept.

## Desktop benchmark with all kept fixes

`npm run benchmark:desktop:built`, before (feature branch) and after
(this branch) alternating, N=3 runs, five follow-latest samples per run,
load 2.1-5.3.

| Metric | Before | After | N |
| --- | --- | --- | --- |
| Jump to latest | 41.8 ms (max 46.2) | 42.2 ms (max 44.6) | 15 |
| Reader navigation | 151.2 ms (max 192.7) | 139.9 ms (max 173.0) | 15 |
| Long conversation p95 frame | 8.8 ms | 8.4 ms | 3 |
| Long conversation maximum frame | 16.7 ms | 9.4 ms | 3 |
| Streaming first delta to paint | 18 ms | 19 ms | 3 |
| Streaming completion to final paint | 285 ms | 270 ms | 3 |
| Streaming p95 visible gap | 76.7 ms | 75.6 ms | 3 |

## PW2: older content

Content loading: `tests/performance/content-loading.benchmark.spec.ts` (`playwright.content-benchmark.config.ts`), production build, M5 Pro, 5 launches per run, chats of 50, 300 and 2,000 messages, all 24 older pages of the 2,000-message chat. `INERTIA_CONTENT_BENCHMARK_OLDER_TRIGGER=scroll` replaces the click on "Load earlier messages" with a reader scrolling up 120 px per frame. Median/p95 in ms; runs with a 1-minute load above 6 were discarded and repeated. Raw JSON stays in the untracked `performance-results/`.

### Load older pages near the top and prefetch the next one (kept)

Before: older messages appeared only after a click on "Load earlier
messages" at the very top. After: scrolling up (wheel, touch, scrollbar
or keyboard) to within one viewport of the top requests the next page,
and the page before it is fetched at idle and held until it is asked
for. The button stays for keyboard users and as the fallback.

Reader scrolling up through the 2,000-message chat (load 2.6-3.4):

| | Before | After |
| --- | --- | --- |
| Older pages loaded without a click | 0 of 24 | 24 of 24, 40 turns each |
| Reader reached the top and waited | 5 of 5 launches, nothing loads | never |
| Time from one viewport of the top to new turns | needs a click (click to turns 39.8/45.0) | 38.0/46.8 |
| First page (no prefetch yet) | 36.4/36.8 after the click | 55.9/57.5, while the reader is still a viewport away |
| Pages 2-24 (prefetched) | 35.8-44.8 after each click | 33.4-44.7 |
| Detail requests in flight at once | 1 | 1 |
| Anchor drift after settling | 0 px | 0 px |

While the reader keeps scrolling, one frame per page shows the tracked row 53-102 px off before the anchor restore lands (the click path shows the same one-frame sample at 188-283 px). `npm run benchmark:desktop:built`, 3 runs before and 6 after (load 1.8-3.6): long-conversation p95 frame 8.6 -> 8.5 ms, jump to latest 43.1 -> 42.1 ms, first window and shutdown within noise; reader navigation 141.9/175.1 -> 150.4/183.6 ms in both after series, not explained yet.

### Tried, dropped

#### Keep the last three chats' loaded pages (branch `work/perf-fix-content-cache`)

Acceptance was a warm reopen of the 2,000-message chat at least 25 ms
faster. Painting the cached detail removes the detail round trip, but the
reopen still waits for the snapshot round trip and the full-app re-render
it causes, so at 60 Hz it saves one frame, not two. Load 2.2-4.3.

| | Before | After |
| --- | --- | --- |
| Open 2,000-message chat, warm | 68.1/70.6 | 48.3/52.2 |
| Open 300-message chat, warm | 67.0/67.8 | 46.9/50.0 |
| Open 50-message chat, warm | 58.0/69.2 | 40.4/49.5 |
| Turns shown after loading 1,000, switching away and back | 40 | 1,000 |

Seeding the cache during render instead of in a layout effect made the
2,000-message reopen slower (69.2/87.4), so that variant was dropped too.

#### Reuse row estimates when older pages are prepended (branch `work/perf-fix-content-pages`)

Acceptance was page 24 within 20% of page 1. Result to turns in the DOM,
two runs of 5 launches, load 1.6-4.3:

| | Before | After (run 1) | After (run 2) |
| --- | --- | --- | --- |
| Page 1 | 20.1/20.4 | 18.9/21.0 | 18.6/20.0 |
| Page 24 | 27.9/28.1 | 22.7/24.9 | 24.5/25.8 |
| Page 24 over page 1 | +39% | +20% | +32% |
| All pages, click to turns | 39.8/45.0 | 37.9/41.2 | 38.0/41.0 |

The remaining growth is layout reads in the viewport's anchor restore and
garbage collection from rebuilding the whole timeline per page.
