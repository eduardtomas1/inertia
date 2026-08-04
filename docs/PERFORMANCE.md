# Cross-platform performance evidence

Inertia keeps performance evidence in test-only benchmark harnesses. The
harnesses do not widen the preload API, persist product telemetry, change GPU
selection, relax the Electron sandbox, or bypass filesystem and process-tree
checks.

## Reproduce the measurements

Use Node 22 from `.nvmrc` and the reviewed dependency graph:

```sh
npm ci
npm run benchmark:platform
npm run benchmark:desktop
```

`benchmark:platform` measures product filesystem traversal, nested Git status,
identical SQLite append fixtures, active provider-stream decoding, a
representative production ProviderManager/CLI-harness lifecycle, confirmed
process-tree termination overhead, raw process startup, deterministic terminal
framing, and a real node-pty lifecycle. It writes
`performance-results/platform-<platform>-<architecture>.json`.

`benchmark:desktop` builds Inertia and launches the real Electron application
under `NODE_ENV=test`, which deliberately disables provider discovery. It is a
provider-disabled test-mode baseline for a fresh-profile launch, a reused-profile
launch, 1.5 seconds of idle CPU/RSS, an authoritative 300-turn/600-message
transcript, a separate recovered compatibility-history stress case, file-tree
interaction, terminal creation, split-chat activation, forced-GC post-close
reclamation, eight repeated Files/Terminal/split open-close cycles, a 600-frame
long-session soak, shutdown, display scale, GPU feature observations, and
per-process metrics
for the main, renderer, supervised utility runtime, GPU, and other Electron
utility processes. It writes
`performance-results/desktop-<platform>-<architecture>.json`.
The renderer series forces a V8 collection before each sample and records both
live JavaScript heap and operating-system working set. Treat peak working set as
a high-water observation, not proof of retained live work; use the post-close,
repeated-cycle, and soak deltas to decide whether product optimization is due.
The deterministic streaming scenario measures the full provider-to-paint path,
stage-by-stage attribution, visible update gaps, long tasks, frames, WAL growth,
and memory. A stable/local run records five isolated samples; hosted CI records
three so it remains bounded while still measuring more than one run. Every
stage reports sample count, minimum, median, p95, and maximum, and the JSON keeps
the raw per-sample runtime and renderer marks. Its required stable-host targets
are under 100 ms to first paint and under 100 ms at p95 between visible updates;
under 50 ms remains aspirational.
The enforced cross-platform ceiling is intentionally looser so noisy hosted
runners catch catastrophic regressions without pretending to be a lab.
The platform report separately compares first-flush candidates of 12, 16, and
24 ms across the 64, 80, and 96 ms sustained persistence/projection cadences
with exact write, byte, CPU, memory, and ordering evidence. The selected
baseline remains 24 ms first flush and 64 ms sustained cadence because that is
the current evidence-backed configuration.

`npm run benchmark:platform:smoke` adds deliberately generous catastrophic
budgets to every exploratory cadence. Only the shipped 24/64 cadence also has
the tighter hosted first-projection and visible-gap ceilings. Hosted CI is too
noisy for lab-grade latency gates, so the smoke gate also checks structural
properties such as bounded terminal frames. CI runs both
harnesses on Windows x64, Linux x64 under X11/Xvfb, and macOS arm64 and retains
the JSON reports for 14 days.

Native package smoke records authoritative main-process runtime-ready and
before-quit timestamps, the child exit timestamp, and post-exit cleanup timing
in `performance-results/package-*.json`. On Linux this measures the unpacked
application produced alongside the AppImage, not AppImage mount time.

## Fixture and measurement definitions

- Workspace list: 500 root files and 40 root directories, five measured runs
  after one warm-up.
- Workspace search: 480 nested files, five measured runs after one warm-up.
- Git scan: one root and eight nested repositories, three measured runs after
  one warm-up.
- SQLite append: three separately initialized databases, 500 messages per
  sample, after a separate warm-up database. No sample inherits rows from a
  previous sample.
- SQLite fresh open: a fresh database and migrations. Operating-system cache is
  uncontrolled; this is not described as a cold storage-cache result.
- Active provider stream: 5,000 ordered NDJSON events fragmented across
  non-record-aligned input chunks and checked through the production line and
  total-event budgets.
- Provider harness lifecycle: three representative Claude CLI runs through the
  production ProviderManager, child-environment sanitation, provider invocation,
  process spawn, bounded NDJSON decoder, 200 ordered stream callbacks, result
  normalization, and owned run settlement.
- Process-tree lifecycle: three native Node children stopped through Inertia's
  confirmed process-tree terminator. This isolates termination overhead and is
  not labeled as an end-to-end provider run. Windows uses
  taskkill/child-resource confirmation; POSIX uses a detached process group.
- Terminal framing: 10,000 ordered one-character PTY callbacks. Delivery is
  capped at 16,384 UTF-16 code units per terminal payload and eight milliseconds
  before a partial flush.
- Real PTY lifecycle: three node-pty launches that each emit 2,000 lines and
  exit normally. Each line has explicit record, ID, and payload delimiters. A
  stateful terminal parser accepts only complete CSI/OSC controls and CR, LF,
  or CRLF record boundaries before asserting all 2,000 IDs and payloads in
  order. Focused fixtures reject dropped, reordered, duplicated, fused, or
  malformed records and controls. On Windows this exercises node-pty's ConPTY
  backend.
- Desktop cold start: a fresh Electron profile with a pre-seeded runtime
  database in provider-disabled `NODE_ENV=test`; operating-system cache is
  uncontrolled.
- Desktop warm start: the same provider-disabled profile and database only
  after the prior utility-runtime PID is confirmed gone.
- Authoritative long conversation: 300 turns created through
  `beginAgentTurn`, valid running/settled lifecycle transitions, turn-owned
  user/assistant messages, representative Markdown/code, plans, reasoning,
  activities, and Git artifact summaries. The report asserts no compatibility
  disclosure, virtualization, 300 total timeline rows, bounded mounted rows,
  real `.message-scroll` scrolling, changed scroll positions, top/bottom
  reachability, DOM descendants, and 120 post-animation-frame samples. The
  report estimates the observed refresh cadence, separates animation-frame
  intervals from `longtask` observations, records median/p90/p95/maximum frame
  intervals, and correlates overruns with row remounting and layout measurement
  only as observational co-occurrence—not proof of causation.
- Recovered compatibility history: a separate legacy/orphan fixture starts
  collapsed, mounts content only when opened, and releases it on close. It is
  not used as ordinary long-conversation scrolling evidence.
- Follow-latest streaming: starts at the live edge, checks the real
  `.message-scroll` viewport, simulates reader navigation away from the bottom,
  verifies streaming does not force-follow history, then records whether Jump
  to latest reached the bounded streaming threshold, its immediate gap, final
  answer visibility, and the post-settlement gap. The final settled viewport is
  required to be within two pixels of the real bottom; no threshold result is
  labeled as exact bottom reachability.
- Workspace release: records DOM nodes, mounted virtual rows, terminal panels,
  xterm containers, loaded workspace surfaces, and split panes immediately,
  five seconds, and thirty seconds after tools, terminal, and split view close.
  JavaScript heap and process working sets remain separate observations.
- Long-session soak: five authoritative 120-frame scroll passes (600 real
  viewport frames) interleaved with tool cycles, with post-soak JS heap,
  renderer working set, and mounted-row samples.
- Split workload: Inertia's supported two-chat split view. Inertia intentionally
  owns one primary `BrowserWindow`; the benchmark does not invent a multi-window
  architecture.

Reports contain runtime, OS, CPU model/core count, RAM, display/session facts,
and GPU feature status. They exclude hostnames, account names, workspace paths,
environment contents, prompts, credentials, and provider output.

The desktop report describes the exact Electron process environment with a
normalized `displayServer` (`x11`, `wayland`, or `none`), normalized
`sessionType`, and boolean `displayPresent`/`waylandPresent` fields. It never
stores raw display identifiers. The platform report is a separate Node-process
observation and must not be used as a proxy for an Xvfb-wrapped desktop run.

## Same-host optimization evidence

The implementation baseline was `4640bbab6a49ffabd4dc211ef9d70b3c8c47e1e9`
(`v0.0.21`). Measurements used Node 22.23.2 on macOS arm64 25.6.0, an Apple M5
Pro with 15 logical CPUs and 24 GiB RAM. The desktop display scale was 2.0.

| Scenario | Baseline | Optimized | Change |
| --- | ---: | ---: | ---: |
| 540-entry workspace list, median | 21.462 ms | 16.855 ms | 21.5% faster |
| 10,000 terminal callbacks, frames | 10,000 | 1 | 99.99% fewer |
| 10,000 terminal callbacks, framed bytes | 890,000 | 10,088 | 98.9% fewer |

The terminal result is a deterministic worst-case framing fixture, not a claim
that every real terminal burst becomes one frame. Large output remains bounded
to 16,384-code-unit payloads, partial output flushes within eight milliseconds,
pending output flushes before exit or managed close, slow consumers are
terminated at the existing 1 MiB WebSocket backpressure ceiling, and disposal
cancels later sends. The real macOS PTY fixture completed in a 47.943 ms median;
every one of its 2,000 ordered lines was reconstructed and asserted.

Search, Git scan, SQLite, and raw process-spawn controls did not receive product
changes in this pass and remained within ordinary run-to-run noise. The desktop
harness was introduced with this change, so its provider-disabled test-mode run
is observational and is not presented as a general provider-enabled baseline or
a before/after optimization claim. The earlier V0.0.23 report also recorded
the following historical observations, but its 600-message fixture inserted
standalone messages and scrolled `.response-timeline`; those messages rendered
as recovered compatibility history and the assignment was a no-op. That result
is retained only as a baseline defect, not as normal transcript evidence:

- fresh-profile runtime interactivity in 733.5 ms and reused-profile
  interactivity in 497.8 ms;
- invalid compatibility-history scroll p95 of 9.7 ms with no frames over 25 ms;
- terminal creation in 26.0 ms and split-chat activation in 188.4 ms;
- shutdown with confirmed utility-runtime exit in 134.2 ms (workload run) and
  237.2 ms (warm relaunch).

The same run separated Browser/main, Tab/renderer, utility runtime, GPU, and
Chromium utility RSS/CPU. Renderer working set grew from about 165 MiB before
the workload to about 578 MiB after long-scroll, files, terminal, and split-chat
activation. The current benchmark keeps JavaScript heap, DOM/observer,
terminal-session, repeated-cycle, and soak evidence separate from OS
working-set retention. Working-set growth alone is not treated as a JavaScript
leak or a deterministic macOS gate; if live objects are released while native
Chromium memory remains high, the report classifies that as native retention.

### Final V0.0.23 stabilization sample

The final local sample used Node 22.23.2 on the same Apple M5 Pro/macOS arm64
host. Five deterministic streams produced these distributions in milliseconds:

| Stage | Min | Median | p95 | Max |
| --- | ---: | ---: | ---: | ---: |
| Provider delta → channel accepted | 0 | 0 | 1 | 1 |
| First-flush wait | 24 | 25 | 26 | 26 |
| SQLite append | 0 | 0 | 1 | 1 |
| Projection creation | 0 | 0 | 0 | 0 |
| Runtime serialization/send | 0 | 0 | 0 | 0 |
| Renderer WebSocket receipt | 0 | 0 | 1 | 1 |
| Renderer state projection | 0 | 0 | 0 | 0 |
| React live-text commit | 1 | 1 | 1 | 1 |
| Commit → visible paint | 2 | 4 | 7 | 7 |
| Total first delta → paint | 28 | 31 | 34 | 34 |
| Provider completion → terminal persistence | 0 | 1 | 1 | 1 |
| Terminal projection | 0 | 0 | 1 | 1 |
| Final Markdown commit | 51 | 52 | 53 | 53 |
| Final answer paint | 2 | 3 | 4 | 4 |

The end-to-end marker measurement was 29–35 ms to first visible paint and
88–92 ms from provider completion to the final painted answer. Reader
navigation was preserved in every sample. The immediate streaming bottom gap
was at most 25 px; after terminal settlement and final Git-artifact layout it
was 0 px in every sample.

The renderer-receipt interval begins at a causal marker recorded immediately
before the runtime sends the WebSocket event. The separate send-accepted marker
remains in raw traces for same-process serialization/send cost, but it is not
used as the cross-process receipt origin because the renderer can receive the
message before the sender resumes after `send()`.

On the authoritative 300-turn transcript, the measured display cadence was
approximately 120 Hz. Frame intervals were 8.3 ms median, 8.6 ms p90, 9.3 ms
p95, and 16.8 ms maximum, with no observed long tasks. Six virtual rows stayed
mounted at both ends of the transcript; layout measurement was 1.5 ms median, 1.9 ms
p95, and 2.2 ms maximum. These are stable-host observations, not a general
claim that every device or hosted compositor is proven smooth.

After terminal, tools, and split view closed, terminal panels, xterm containers,
loaded workspace surfaces, and split panes were all zero immediately and after
5/30 seconds. DOM nodes remained bounded at 782/782/790 and JavaScript heap was
17.1/16.6/16.8 MiB. Renderer working set remained about 273 MiB, illustrating
why native Chromium retention is reported separately rather than called a leak.

## Platform investigation and limitations

### Windows

The shared file-list batching reduces repeated parent `realpath` work while
retaining per-entry parent identity checks, symlink rejection, and containment
verification. Terminal batching targets the small callback cadence observed
with ConPTY. Three-OS CI additionally exercises native Codex discovery,
node-pty, packaged startup/shutdown, Windows path handling, and the full E2E
suite.

Hosted Windows evidence does not isolate Microsoft Defender, installed NSIS
startup, NTFS storage type, integrated versus discrete GPU behavior, or every
DPI configuration. No Defender exclusion, unsafe temp relocation, forced GPU,
or DPI flag is added.

### Linux

CI measures native node-pty, file/Git traversal, desktop process metrics, PDF
and canvas E2E coverage, the unpacked application, AppImage creation and
validation, fuse state, and X11/Xvfb package smoke. Inertia keeps Chromium's
automatic GPU/Ozone selection and existing font fallbacks.

Hosted CI does not provide a native Wayland comparison, real AppImage
mount-to-first-paint timing, desktop font-family inventory, or representative
GPU hardware. Those require a physical Linux matrix; the reports record
normalized session type, display/Wayland presence, scale, and GPU status for the
exact desktop process so such runs remain comparable. The Linux package report
retains `packageKind: linux-unpacked`; software-rendered Xvfb GPU status remains
an observation rather than a physical-GPU claim.

### macOS

The same-host run measures APFS-backed traversal, native node-pty, CoreText
rendering through the real UI, scale 2.0, secure-storage-compatible startup,
and renderer/GPU process cost. Inertia does not use a blanket power-save
blocker, so this PR does not disable App Nap.

Local and pull-request packages are ad-hoc signed. They cannot substantiate
Gatekeeper quarantine, Developer ID notarization, stapled-ticket first launch,
or long background App Nap/power behavior. Those must be measured on a genuine
release candidate without changing signing or hardened-runtime settings.

On the local macOS 25.6 host, packaged smoke reached `runtime-stopped` and
`app-exit` but the Electron main process remained resident beyond the existing
15-second deadline. An isolated build of untouched `origin/main` at `4640bba`
failed identically, while the latest exact-main hosted macOS 15 package smoke
was green. This is recorded as a baseline host limitation rather than attributed
to this PR; exact-head hosted CI remains required before review readiness.

## Provider streaming and T3 Code comparison

Active streaming remains covered by deterministic provider protocol,
persistence, WebSocket coalescing, renderer projection, and E2E fixtures. The
platform benchmark additionally times bounded parsing of a deterministic 5,000
event stream and three provider-enabled representative runs through the
production ProviderManager and Claude CLI harness, including environment,
spawn, protocol, ordered callbacks, and settlement. A separate direct-child
scenario is named only as process-tree lifecycle overhead. The desktop benchmark
is explicitly provider-disabled `NODE_ENV=test`; it neither calls a live
external provider nor collects private provider output. Provider spawn/stop
correctness and complete process-tree confirmation remain release-blocking
through `test:portable` and the lifecycle suites.

On the same macOS host, the representative provider-enabled CLI harness
lifecycle completed in a 43.729 ms median while preserving all 200 ordered text
callbacks per sample. The separately named process-tree termination floor was
15.789 ms median; it is not presented as provider startup evidence.

T3 Code's current first-party design uses a persistent Rust resource-monitor
child with bounded in-memory history and OS counters, requests
`app.getAppMetrics()` only while diagnostics is open, and does not persist a
telemetry database. Its web and mobile clients share one connection runtime and
one authenticated RPC WebSocket per environment, with platform layers adapting
background and lifecycle capabilities rather than owning retry policy. See the
upstream [resource telemetry](https://github.com/pingdotgg/t3code/blob/5192f777fe54c2a2a359f6c25ecf5fbde46d49b0/docs/internals/resource-telemetry.md)
and [connection runtime](https://github.com/pingdotgg/t3code/blob/5192f777fe54c2a2a359f6c25ecf5fbde46d49b0/docs/internals/connection-runtime.md)
documents inspected for this comparison.

The useful pattern for this PR is demand and ownership, not implementation
copying: Inertia observes Electron process roles only inside the benchmark and
retains its existing one sandboxed renderer connection to one supervised
utility runtime, with provider and PTY children created on demand. Adding a
persistent telemetry sidecar or mobile connection layer would be an architecture
change outside measured optimization scope.
