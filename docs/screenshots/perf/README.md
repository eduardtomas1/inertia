# Performance evidence

## Startup (PW5)

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
