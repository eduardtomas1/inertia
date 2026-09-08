# Manual diagnostic for the Windows streaming stall

This isolated branch is diagnostic only and must never be merged into main or
PR #323. Nothing has been dispatched. The coordinator must review this exact
patch and workflow before deciding whether to publish/dispatch it.

The observed failure remains run 34226463420, job 102070323944, source
`0fc4f60e1dc4a538d05c3af3773e7e67a3e02bbb`: first-sample long tasks total
3,283 ms against the unchanged strict 2,000 ms ceiling. Later samples report
53 ms and zero. Functional Windows tests passed; this does not waive the
benchmark failure.

## Immutable build and unchanged benchmark contract

Only this isolated branch replaces the existing `ci.yml` with a manual-only
`workflow_dispatch` job. There is no push, pull-request or schedule trigger.
Main and PR #323 workflow/source remain untouched. The established workflow
filename permits a coordinator to target the isolated ref without proposing a
new workflow on main; actual dispatch availability still must be checked.

The Windows job checks out the original source by its full SHA into
`application`, installs its original locked graph, and builds it before copying
exactly two instrumented test files from the diagnostic checkout. It checks the
original source identity, records every `out` file hash before instrumentation,
and compares hashes afterward, including on benchmark failure. It rejects
unexpected tracked changes, extra test files, or source/config/lock changes.

The command remains `npm run benchmark:desktop:built`. The complete benchmark
runs with original fixtures, CI's three streaming samples, workload order,
deadlines, assertions, summarization and Electron/fixture owner cleanup. The
instrumentation records evidence; it does not change the long-task total or
exclude any stall. The job has a 25-minute outer timeout.

## Bounded evidence

The existing streaming long-task observer additionally retains at most 64
entries per sample, with startTime, duration, short entry name, and at most four
safe attribution name/containerType pairs. Dropped entries are counted. Existing
long-task count/sum collection remains unchanged. Individual attribution values
are capped; URLs, container IDs, script text and arbitrary objects are omitted.

The first sample additionally observes the renderer's `long-animation-frame`
PerformanceObserver entry type for at most 10 seconds. This avoids global
Chromium/system tracing. It records at most 128 entries and eight scripts per
entry, with a 512 KiB serialized-entry cap. Timing fields and short function
names/invoker types are allowlisted; URLs, invoker content, source text and
arbitrary trace arguments are not retained. Renderer performance.timeOrigin and
observation bounds permit correlation with the existing streaming marks.
Unsupported entry type, timeouts and truncation are explicit in the report.
The page-owned observer disconnects automatically at 10 seconds and again in
the first sample's finally block. No additional Electron child/process is
created. Starting and stopping evidence reads each have a one-second bound;
these bounds do not replace any benchmark or cleanup deadline.

A separate `streaming-first-sample-timeline.json` is written even if the first
sample fails. Existing per-sample long-task detail is retained in the normal
benchmark report when report generation is reached. Existing failure trace and
all original diagnostics remain uploaded for 14 days.

## Interpretation limits

Instrumentation adds overhead, especially during the first sample. This job
runs the complete desktop benchmark, but omits the preceding full native lane's
packaging, UI and recovery workload sequence. Installation is uncached; hosted
CPU/GPU load and OS cache history remain uncontrolled. These environment and
subset differences prohibit treating a clean diagnostic as a repair or as
proof of runner noise.

Long-animation-frame script attribution may identify script/layout work but
cannot provide JavaScript CPU stacks, native/GC stacks, or prove external
scheduling contention. Missing attribution must remain unknown. The goal is
causal evidence, not a green badge; a product fix or budget change requires
separate evidence and review.

Preparation checks: E2E/performance TypeScript project, focused standard and
type-aware lint, actionlint, and diff whitespace checks. No native benchmark or
heavy/full gate was run for this preparation; PR #323's original full-gate
and failed hosted evidence stay preserved separately.
