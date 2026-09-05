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
heap samples do not replace a 13-hour same-profile heap comparison.

## Remaining field validation

The original Ubuntu 24.04 x64 AppImage profile, its 13-hour session, and its
suspected stale running records were unavailable. The container's graphics
path also differs from that hardware. These measurements establish the
background-motion fix and bounded idle work for representative seeded
histories; they do not establish the cause of the original RSS growth or prove
that all of the original session's CPU load came from this animation.

Keep #248 open for a same-profile AppImage follow-up: foreground, mapped behind
another application, minimized, and refocused samples; independent renderer/GPU
CPU and RSS/PSS/heap; and ownership-based inspection of any remaining running
records. A long-session heap comparison is still needed if RSS growth persists.
