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
