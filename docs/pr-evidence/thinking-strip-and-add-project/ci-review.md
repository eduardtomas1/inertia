# Thinking strip and Add project CI review

The product change makes the Thinking strip readable with a 1,100 ms ordinary dwell and a bounded 2,600 ms unfinished-fragment dwell, and adds inset space to the Add project search. The source changes are `AddProjectDialog.css`, `response-timeline/activity.tsx` and `styles.css` under `src/renderer/src`. The feature-owned Electron geometry test and loading-state DOM tests cover the two original review findings.

Two existing test fixtures also needed isolation during validation:

- `tests/renderer/streaming-render-isolation.dom.test.tsx` freezes only interval timers during the 200-token profiler measurement, then restores them after cleanup. An unrelated elapsed-label interval had added one profiler commit. The exact 200-render and component-isolation assertions remain unchanged.
- `tests/server/package-smoke-history.test.ts` independently seeds the successful-upgrade and damaged-history scenarios. Predecessor setup runs in the normal bounded setup hook; each test exercises one candidate/damaged reopen. The successful case still proves four speed-switch/compaction/resume turns with one provider session, unchanged historical bytes and five persisted turns overall. The corruption case still rejects modified history before admitting any further turn, verifies the unchanged turn count, and rejects damaged/missing attachments. No application code, package smoke deadlines, test timeout settings, or CI policy were changed by this fixture repair.

## Failure evidence

On `a31982ef`, hosted CI run `35097409225` attempt 1 passed all application tests and packaging checks on six platforms. The macOS x64 job passed 9,120 unit tests, 64 display scenarios, 92 isolated scenarios, four destructive recovery scenarios and the desktop benchmark. Its only failure was the final artifact upload: `CreateArtifact: ENOTFOUND`.

One targeted unchanged-job retry reached a different failure: the original composite history test exceeded its 15-second default timeout (16,210 ms reported, versus 6,931 ms in the earlier successful run). The log does not identify which phase incurred that extra latency. The DNS upload failure did not recur; the retry uploaded its partial performance evidence.

The composite test's aggregate timer was reproduced locally: consume 4,800 ms inside each history call's existing 8,000 ms deadline, then run the real provider/runtime operation. The original combined test times out at 15,011 ms. With independent scenario setup, both corrected cases pass under the same injected delay, with no deadline increase. This demonstrates the timer-composition defect; it does not establish the exact source of hosted runner latency. The injection was removed before final validation.

## Verification

- Final focused history file: 11 tests passed, including all unchanged negative transport/admission cases.
- Earlier focused product DOM coverage: 21 tests passed.
- Earlier native Linux ARM64 evidence: three Add project scenarios and two background-content/motion scenarios passed; the fixture repair does not modify those product paths.
- Final Node 22 `npm run check`: 854 files / 9,121 tests passed, with 144 platform skips; architecture, lineage, lint, types, themes, build and original bundle limits passed.
- Hosted macOS x64 and the other required jobs must pass on the final commit before merge. Local execution uses macOS ARM64; it is not a substitute for the hosted native matrix.

## CI follow-up: Add project entry animation

Run `35117533968` passed Linux x64/ARM64, Windows x64/ARM64 and all Windows unit shards. macOS ARM64 failed only the Add project geometry case: the measured text origin moved 4.4398 px between placeholder and typed-text samples. The dialog enters with a scale transform, so these samples must compare its settled layout.

A controlled native macOS ARM64 probe extends the existing entry animation to one second and waits before typing. The original test fails with a 4.4443 px difference. Waiting for the actual dialog animations to finish before the first measurement passes under the same probe. The probe's injected style and delay were removed; the final complete Add project spec passes all three scenarios. The focus-ring insets, icon separation, filtering and subpixel alignment assertions are unchanged. No product CSS, timeouts, or CI policy changed.

After the animation-readiness correction, the full Node 22 gate passes again: 854 files / 9,121 tests, 144 expected platform skips, and all architecture, lineage, lint, types, themes, production build and original bundle limits. The unchanged provider/server source retains the prior 1,368-test portable result. Fresh hosted CI is required on the new commit before merge.
