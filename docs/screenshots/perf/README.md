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

## PW6: provider refresh

Instrument: `tests/performance/provider-refresh.benchmark.test.ts` (`INERTIA_PROVIDER_REFRESH_RUNS=3 npx vitest run --config vitest.benchmark.config.ts tests/performance/provider-refresh.benchmark.test.ts`; `INERTIA_PROVIDER_REFRESH_SCALES` picks the slow-down factors). It drives the production `ProviderManager`, `detectProvider`, `ProviderMetadataCache` and `createProviderInfoRefresh` against a fake Claude CLI (`tests/helpers/claude-refresh-fixture.ts`) that answers `--version`, `auth status --json` and the pinned Agent SDK control protocol (`initialize`, `get_usage`), with every process owned by the macOS runtime guardian as in the app. No real provider CLI runs. The fake's delays are assumptions, not measurements of the real CLI: process start 150 ms, sign-in check 400 ms, SDK `initialize` 1,000 ms, usage read 500 ms, exit after EOF 150 ms. "5x" and "10x" multiply every delay (a slow or saturated machine, emulated by delays, never by CPU load). "With Cursor" adds a fake `cursor-agent` (start 300 ms, `status` 800 ms, same factor) to show one slower provider beside Claude. Times are from the start of the refresh, median of 3 runs (1 run at 20x), Apple M5 Pro, 1-minute load 2.1 to 2.5. States are the provider label the renderer would show (`providerStateLabel`). Raw JSON stays in the untracked `performance-results/`.

The pipeline for one Claude refresh, before and after: three processes, strictly in sequence. `claude --version` (credential-free; about 100 ms of guardian, journal and spawn cost before each process), then `claude auth status --json` (credentialed, only after the version answer identified the executable), then one SDK session that answers the model catalog and the usage windows together (`initialize` and `get_usage` in parallel); the Usage screen and skills discovery are separate reads and are not part of a refresh. "Refresh" and "Refresh all providers" force the catalog read; launch, post-turn and idle reads honour the catalog TTL (5 minutes) and the usage TTL.

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
