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
JSON process/heap/callback summaries to `performance-results`, and attaches CDP
traces to the Playwright results. It asserts paused/frozen background animation,
zero idle React commits/RAF callbacks, fewer than 24 mounted rows, advancing
foreground animation, and the Ultra reduced-motion rule. CPU and memory are
evidence rather than machine-dependent pass/fail thresholds.

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
