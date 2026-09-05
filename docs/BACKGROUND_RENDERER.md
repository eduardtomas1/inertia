# Background renderer measurements

Issue [#248](https://github.com/eduardtomas1/inertia/issues/248) reports sustained
renderer/GPU activity in a mapped, unfocused Linux window. A synthetic X11
reproduction attributes one continuous source to the Ultra composer frame:
its masked gradient keeps painting while `visibilityState` remains `visible`.

The fix uses the existing document-presence subscription to pause CSS animations
at the document root when unfocused or hidden, including portals and detached
chats. Animation progress is retained. `LiveElapsed` stops its intervals and
refreshes elapsed wall time on return; sidebar FLIP work cancels and records a
fresh position baseline after focus returns. The foreground styles and reduced
motion rules remain in effect.

## Method

The reproduction uses Electron 44.1.0, Node 22, Debian ARM64, Xvfb at 1600×1000,
and Openbox in a local container. Renderer source from `e996bd3b` is compared
with the focused presence/motion changes, using the same seeded conversation,
instrumentation, window state, and five-second sampling duration per state.
The large fixture has 128 completed turns, 9,472 activities, and 1,024 messages;
the small fixture has two turns, 148 activities, and 16 messages. Both select
Ultra reasoning. There is no provider execution or user content.

The test focuses a small second Electron window while keeping Inertia mapped,
then minimizes Inertia, restores it, and verifies foreground animation resumes.
Bare Xvfb without a window manager uses native window hiding when minimization
is unavailable, and records which native state was reached.
Playwright disables Chromium background/occlusion throttling; the test disables
its synthetic focus emulation and records actual focus and visibility. On this
X11 fixture the minimized document still reports `visible`, so hidden-document
behavior is independently exercised in the DOM tests.

CPU is the change in each process's cumulative CPU seconds divided by elapsed
wall time, expressed as a percentage of one CPU core. Renderer and GPU are
reported independently. RSS/PSS come from `/proc/<pid>/smaps_rollup`; JavaScript
heap comes from CDP `Runtime.getHeapUsage`. CDP traces record layout, paint,
raster, JavaScript callbacks, and GC. React's commit hook and a RAF wrapper
count callbacks without retaining fibers or callback objects. Each trace is
bounded to 50,000 events; durations of nested or parallel events are not summed
into an inferred CPU percentage.

## Initial matched result

The first matched large-history comparison with React/RAF instrumentation was:

| Mapped, unfocused, five seconds | Before | After |
| --- | ---: | ---: |
| Renderer CPU, one core | 86.75% | 0.40% |
| GPU CPU, one core | 5.58% | 0.20% |
| Renderer RSS | 287.56 MiB | 278.85 MiB |
| Renderer PSS | 211.08 MiB | 207.76 MiB |
| JavaScript heap used | 48.03 MiB | 48.26 MiB |
| React commits | 0 | 0 |
| RAF callbacks | 0 | 0 |
| Paint events | 602 | 0 |
| Style updates | 301 | 1 |
| JavaScript `FunctionCall` duration | 0.074 ms | 0 ms |
| Minor/major GC events | 0 | 0 |
| Mounted transcript rows | 7 | 7 |

The animation inventory contained only `ultra-reasoning-frame-flow` during the
unfocused samples. Before the fix, its time advanced by five seconds and the
trace recorded repeated raster/paint work. Afterward it stayed paused at the
same time. This supports CSS paint as the cause in this reproduction; React,
RAF, and GC were already idle. Memory differences in short samples do not
establish a memory-leak fix. Foreground animation ran before and after the
change and resumed with advancing time on refocus.

A subsequent large-history regression run observed the paused state within
60 ms of requesting the focus change, including second-window creation and
polling. Its five-second renderer CPU samples were 0.40% mapped/unfocused and
0.00% minimized. This is an animation-pause observation latency, not a precise
CPU-settle timestamp. Before the fix, paint continued through the full sample.

## Bounds and regression coverage

`renderer-background.spec.ts` exercises both small and large histories, writes
JSON process/heap/callback summaries and CDP traces to `performance-results`,
and attaches traces to the Playwright results. It asserts paused/frozen background animation,
zero idle React commits/RAF callbacks, fewer than 24 mounted rows, advancing
foreground animation, and the Ultra reduced-motion rule. CPU and memory are
evidence rather than machine-dependent pass/fail thresholds.

The fixture first waits for the runtime snapshot to confirm its initial
validated backup, whose scheduled publication is startup work. Before each
sample, the regression fixture requires two seconds without a React
commit or RAF callback, bounded by a 15-second deadline. This lets initial
runtime replies and native focus effects settle before the full five-second
idle assertion begins. Reports retain up to 100 runtime event types and receipt
times, without payloads, to distinguish incoming data from recurring idle work.

The existing timeline mounts only seven rows for the large fixture. Its weight
and estimate caches use weak keys, with at most 12 layout estimates per item.
Conversation projections reset on conversation changes and discard hydrated
live overlays. Focus/anchor RAF paths are finite and event driven. Existing
long-transcript, turn-anchor, composer-responsive, and Work-sidebar Electron
geometry scenarios pass. DOM tests cover hidden/visible/focus transitions,
timer cleanup and catch-up, cancellation of active sidebar motion, and prompt
cancel/edit/ArrowUp/ArrowDown history behavior.

No virtualization or persisted run-state defect was established by this
reproduction. Startup recovery already excludes durable provider ownership
before interrupting unowned runs and their running activities. Runtime/provider
ownership changes belong to [#250](https://github.com/eduardtomas1/inertia/pull/250).
Age alone is not evidence that a running turn is stale.

## Follow-up: delegated-work elapsed clocks

An audit of `d4a19870` (including #254 and later compaction motion changes)
found a separate recurring source: `SubagentElapsed` used one shared interval
to write elapsed labels directly into the DOM every second. It subscribed
even inside a folded disclosure and while the window was unfocused. The
original completed-history fixture's React/RAF counters did not detect this
work. This is a small residual cost after #254, not an attribution of the
original greater-than-one-core field report.

The clock now subscribes only for an open disclosure in a visible, focused
document. Removing the last subscriber clears the shared interval. Reopening
or refocusing refreshes from wall time immediately and resumes one shared
clock. The change does not alter a trace's `isLive`, status, timestamps,
ownership, stop controls, or follow-up controls. Foreground CSS motion and
reduced-motion rules are unchanged.

The added native scenario generates 41 histories with 1,008 turns, 8,064
messages, and 67,552 activities, in addition to the ordinary app fixture's
initial conversation. The selected history has 128 turns and 9,472 activities.
Six synthetic live trace projections are installed after runtime recovery;
their parent remains a completed fixture turn to isolate the elapsed-label
clock from the parent's own live timer. No provider is launched: this is a
renderer scheduling test, not evidence that a running provider was recovered
or that a live provider is owned. Native runtime ownership is tested separately
in `runtime-safety.test.ts` and `turn-controller-cleanup-proof.test.ts`.

The final matched comparison uses production source from `0fe93246` (including
the approved #259 composer outline) before and after only the elapsed-clock
changes. Both runs use Node 22.23.2, Electron 44.1.0, Ubuntu 24.04.4 ARM64,
Xvfb at 1600×1000, and Openbox in a separate local container. Electron's sandbox
is disabled for this root-owned test container only. This is an unpackaged
synthetic X11 test with container graphics, not the original x64 AppImage or
its hardware GPU.

The first unfocused trace can include startup garbage collection after
React/RAF have settled. A second five-second trace follows in the same mapped,
unfocused state, after the same two-second quiet dwell. In the final pair:

| Second mapped/unfocused sample, five seconds | Before | After |
| --- | ---: | ---: |
| Renderer CPU, one core | 1.19% | 0.20% |
| GPU CPU, one core | 0.20% | 0.00% |
| Renderer RSS | 202.32 MiB | 199.71 MiB |
| Renderer PSS | 126.29 MiB | 123.71 MiB |
| JavaScript heap used | 22.74 MiB | 22.49 MiB |
| Interval callbacks / timer fires | 5 / 5 | 0 / 0 |
| React commits / RAF callbacks | 0 / 0 | 0 / 0 |
| Layout events | 5 | 0 |
| Paint / raster events | 35 / 30 | 0 / 0 |
| Style updates | 7 | 2 |
| Minor / major GC events | 0 / 0 | 0 / 0 |
| Mounted transcript rows | 7 | 7 |

The baseline interval writes six elapsed labels; each tick triggers layout
and paint. CSS animations are already paused on both sides. The baseline
fails the new zero-interval assertion; the patched scenario passes every
background, minimized, foreground, refocus, and reduced-motion assertion.
Foreground renderer CPU is 71.20% before and 71.01% after in this software
graphics workload; refocused CPU is 72.35% and 71.43%. These are individual
observations, not a throughput improvement claim. Minimized renderer CPU is
1.19% before and 0.20% after.

The first unfocused samples record 5.16% and 0.00% renderer CPU, with two and
zero major GC events respectively. A prior matched run had GC on both sides.
GC timing is variable, so the full first-sample CPU difference is not
attributed to the clock. The second samples contain no GC and retain the
recurring layout/paint difference. Their quiet-dwell observation times are
2.92 seconds on both sides, including the required two-second dwell and poll
latency; these are not precise CPU-settle timestamps. Small RSS/PSS/heap
differences in this short run do not establish a memory-leak fix.

The final local JSON reports and raw traces are retained under
`performance-results/issue248-final-before` and
`performance-results/issue248-final-after`. The normal E2E run also writes and
attaches its reports under `performance-results/renderer-background` for CI
artifact retention. Reproduce with Node 22: `npm run build`, then
`npx playwright test tests/e2e/renderer-background.spec.ts --workers=1` on an
isolated desktop. For a baseline, build `0fe93246` with the new test fixture
but without the two component changes; the interval assertion must fail.

The first PR #262 Windows x64 CI run exposed a fixture-construction cost:
the trace spent 328.803 seconds between the end of before-hooks and the first
Electron launch call, exceeding the unchanged 300-second test deadline before
startup or sampling began. Windows ARM64 spent 253.760 seconds in the same
prelaunch phase, then passed startup, the 29.122-second backup wait, foreground
sampling, and blur/pause checks. Its first background settle poll began about
297.546 seconds into the test and exhausted the overall deadline after 1.896
seconds; the observed quiet interval increased to 1,896.2 ms. Neither trace
establishes an idle-renderer regression. The original generator reopened `RuntimeStore` for
each of 41 histories and inserted 67,552 activities individually. The fixture
now keeps one store lifetime for conversation/turn/message creation and batches
the same activity payloads in one prepared-statement transaction, with foreign
keys enabled. Production startup, recovery, and backup behavior are unchanged.

A local Node 22 seeding-only comparison measured 11.165 seconds before and
2.158 seconds after. These are fixture setup times, not renderer performance
or native Windows timings. Persisted-data regression coverage verifies exact
counts, unique command titles, payloads, run/turn/conversation ownership, user
and terminal message ownership, preserved initial chat, selected detail, and
database integrity. A named Playwright seed step and a persisted-count/timing
attachment now distinguish this phase in CI. The complete mature dataset,
300-second deadline, native focus checks, backup wait, sample durations, and
zero-work/foreground-motion assertions remain in place.

Both Windows x64 and ARM64 native E2E jobs passed on `7dd1e604` in
[CI run 33991653852](https://github.com/eduardtomas1/inertia/actions/runs/33991653852).
Their mature seeding times were 47.351 and 28.548 seconds respectively, with
all 1,008 turns, 8,064 messages, and 67,552 activities retained. The new unit
fixture exceeded the generic test budgets on hosted macOS x64 (24.773 seconds)
and Windows (34.700 seconds). A local phase profile attributed 2.439 seconds
to seeding and only 0.071 seconds to activity validation. Replacing repeated
per-turn full-array scans and individual payload matchers with one grouping
and payload pass reduced that validation phase to 0.007 seconds, retaining
every exact title, payload, count, and identity assertion. The mature unit
fixture has a separate 90-second budget, less than twice the observed native
Windows setup time. Generic unit defaults and the renderer E2E deadline are
unchanged. These setup timings are independent of renderer performance.

macOS ARM64's small and large cases passed locally. The mature macOS baseline
also reproduced five timer callbacks and 35 paints, with 0.83% renderer CPU
and 1.00% GPU CPU while unfocused. The patched mature macOS attempt recorded
lost document focus during its foreground sample and an empty transcript
after restoration; a retry failed the paused-animation inventory check.
The cause of those native window-state failures was not established. Those
attempts do not count as a complete matched macOS validation, and their
foreground numbers are excluded. No native assertion was relaxed.

The scenario records interval callbacks and elapsed-label values alongside
the original process, trace, animation, React, and RAF measurements. All
background samples require zero interval callbacks and unchanged labels;
foreground and refocused live labels must advance. DOM tests also require
zero clocks while folded or hidden, catch-up after reopening/refocusing, a
single clock across rows, and cleanup after unmount. Generated histories use
fixed synthetic text and never read an installed application profile.

The retained-data audit still finds one subscribed detail per mounted pane,
reset live overlays on conversation changes, weak-key activity/estimate
caches, and seven mounted rows in this workload. No additional virtualization
or long-session retention defect has been established. The fixture's short
heap samples do not establish long-session retention behavior.

## Issue #248 acceptance audit

The combined changes in merged #254 and this follow-up address the reported
background renderer work. The issue asks for matched profiling and a
representative large workload; it does not require a 13-hour soak or access
to the original private profile as a prerequisite. The following maps its
actual criteria to the measurements and regression coverage above.

| Criterion | Evidence and coverage |
| --- | --- |
| Matched before/after traces | Each comparison above holds the generated profile, selected history, native window state, five-second duration, instrumentation, and graphics environment constant within its pair. Baseline and patched raw traces are retained. |
| Separate attribution | Animation inventory/time, RAF callbacks, layout/paint/raster events, React commits, and GC are recorded independently. The first fix attributes continuous paint to the Ultra CSS animation; the follow-up attributes one-second layout/paint to elapsed-label DOM writes. GC-variable samples are explicitly separated. |
| Focus/occlusion-aware scheduling | `useDocumentActivity` combines focus and visibility; root background-motion CSS also covers portals and detached chats. X11 native tests leave the main window mapped and visible while another Electron window owns focus. DOM tests separately exercise hidden documents. |
| Pause unobservable work; preserve motion | Root CSS pauses infinite animations with their progress retained. Sidebar FLIP cancels and resets its baseline. Elapsed timers unsubscribe while inactive, with delegated clocks also gated by disclosure state. Native tests require frozen background animation/labels and advancing foreground/refocused motion, including reduced-motion checks. |
| Validate virtualization and bound projections/idle work | `response-timeline/viewport.tsx` uses viewport virtualization with overscan 4, weak-key weight/estimate caches, and at most 12 layout estimates per item; layout-anchor restoration is bounded to 30 frames/600 ms. `useConversationProjection.ts` replaces detail on conversation changes, clears live overlays, and removes hydrated duplicates. `runtimeSnapshotProjection.ts` caps shell runs at 200. Tests cover 600 timeline rows/3,000 events, stable settled rows under updates, heavy short histories, and native mounting of seven rows in the mature workload. Idle samples require zero React, RAF, and interval callbacks. |
| Reconcile stale running state without hiding live work | `recovery-repository.ts` excludes durable provider-owned turns/runs before transactional interruption of unowned current turns and their running activities. `runtime-safety.test.ts` verifies exact receipt-bound retirement, failed recovery, crash/replay, and retained ownership. `turn-controller-cleanup-proof.test.ts` requires matching run/turn identity and settled cleanup before clearing authority; missing/mismatched proof retains active controls. `database.test.ts` verifies scoped recovery and rollback. No age heuristic or renderer status rewriting was introduced. |
| Deterministic large-history regression | DOM presence/clock/sidebar tests and the native 41-history profile cover background scheduling, cleanup, catch-up, and the complete activity dataset. The baseline fails the new zero-interval assertion. Persisted fixture tests independently verify counts, payloads, ownership, and integrity. |
| Preserve composer and navigation UX | The unit/DOM gate includes prompt cancel/edit and ArrowUp/ArrowDown history, sidebar/work-index motion, hydration, turn anchors, and virtualization. Linux Electron checks cover responsive composer geometry, delegated parent follow-up, both turn-anchor cases, long-transcript keyboard navigation, and Work sidebar geometry. |
| Report independent resource and settle measurements | Both result tables report renderer/GPU CPU and renderer RSS/PSS/heap independently. The initial pause was observed within 60 ms; the follow-up records the required two-second quiet dwell at 2.92 seconds on both sides. These observation times include polling and are not precise CPU-idle timestamps; baseline recurring work continues throughout its sample. |

The retained-data bounds apply to pane subscriptions, caches, mounted rows,
and recurring idle work. The selected conversation's data still scales with
that conversation's history; this is not a claim of constant total heap for
arbitrarily large conversations. The source/test audit found no additional
virtualization or ownership-recovery defect requiring a production change.

With current main `bd629858` (#263) integrated, the final local Node 22 gate
passed with two unit workers: 647 files and 6,783 tests passed, 102 tests
skipped, with quality, type, build, and bundle checks green. The Linux native
rerun passed all seven cases in two minutes: the six geometry/navigation/
parent-follow-up cases above plus the complete mature background scenario.
These reruns verify behavior on the integrated branch; the matched resource
measurements remain the controlled comparisons reported earlier. Final logs,
unit phase profiles, and native reports are retained under
`performance-results/issue248-validation-final`.

## Evidence limits

The original Ubuntu 24.04 x64 AppImage profile, its 13-hour session, and its
suspected stale running records were unavailable. The container's graphics
path also differs from that hardware. These measurements establish the
background-motion fix and bounded idle work for representative seeded
histories; they do not establish the cause of the original RSS growth or prove
that all of the original session's CPU load came from these recurring sources.
If RSS growth persists after the scheduling fixes, a sustained heap comparison
would investigate that separately. The original profile's four running
activities and one running turn were not individually classified; the
ownership-based recovery behavior is verified with deterministic fixtures.
These are limits of the evidence, rather than additional issue acceptance
requirements. Merge still requires the normal review and green CI gates.
