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
identical SQLite append fixtures, active provider-stream decoding, supervised
provider process startup/shutdown, raw process startup, deterministic terminal
framing, and a real node-pty lifecycle. It writes
`performance-results/platform-<platform>-<architecture>.json`.

`benchmark:desktop` builds Inertia, launches the real Electron application, and
measures a fresh-profile launch, a reused-profile launch, 1.5 seconds of idle
CPU/RSS, a 600-message scroll, file-tree interaction, terminal creation,
split-chat activation, shutdown, display scale, GPU feature observations, and
per-process metrics for the main, renderer, supervised utility runtime, GPU,
and other Electron utility processes. It writes
`performance-results/desktop-<platform>-<architecture>.json`.

`npm run benchmark:platform:smoke` adds deliberately generous catastrophic
budgets. Hosted CI is too noisy for tight latency gates, so the smoke gate also
checks structural properties such as bounded terminal frames. CI runs both
harnesses on Windows x64, Linux x64 under X11/Xvfb, and macOS arm64 and retains
the JSON reports for 14 days.

Native package smoke records launch-to-runtime-ready and shutdown phase timing
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
- Provider process lifecycle: three native Node children launched with the
  provider process shape and stopped through Inertia's confirmed process-tree
  terminator. Windows uses taskkill/child-resource confirmation; POSIX uses a
  detached process group.
- Terminal framing: 10,000 ordered one-character PTY callbacks. Delivery is
  capped at 16,384 UTF-16 code units per terminal payload and eight milliseconds
  before a partial flush.
- Real PTY lifecycle: three node-pty launches that each emit 2,000 lines and
  exit normally. On Windows this exercises node-pty's ConPTY backend.
- Desktop cold start: a fresh Electron profile with a pre-seeded runtime
  database; operating-system cache is uncontrolled.
- Desktop warm start: the same profile and database after a confirmed clean
  shutdown.
- Long-thread scroll: 120 animation frames alternating between the ends of a
  600-message timeline; the report includes median, p95, and frames over 25 ms.
- Split workload: Inertia's supported two-chat split view. Inertia intentionally
  owns one primary `BrowserWindow`; the benchmark does not invent a multi-window
  architecture.

Reports contain runtime, OS, CPU model/core count, RAM, display/session facts,
and GPU feature status. They exclude hostnames, account names, workspace paths,
environment contents, prompts, credentials, and provider output.

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
cancels later sends. The real macOS PTY fixture completed in a 46.795 ms median
and used three frames per 2,000-line sample after the change.

Search, Git scan, SQLite, and raw process-spawn controls did not receive product
changes in this pass and remained within ordinary run-to-run noise. The desktop
harness was introduced with this change, so its first run is observational and
is not presented as a before/after optimization claim. That run recorded:

- fresh-profile runtime interactivity in 769.9 ms and reused-profile
  interactivity in 521.9 ms;
- 600-message scroll p95 of 10.0 ms with no frames over 25 ms;
- terminal creation in 36.9 ms and split-chat activation in 189.7 ms;
- clean shutdown in 126.2 ms (workload run) and 228.1 ms (warm relaunch).

The same run separated Browser/main, Tab/renderer, utility runtime, GPU, and
Chromium utility RSS/CPU. Renderer working set grew from about 165 MiB before
the workload to about 578 MiB after long-scroll, files, terminal, and split-chat
activation. That observation belongs to the renderer-efficiency workstream; no
renderer algorithm was changed here.

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
`XDG_SESSION_TYPE`, `WAYLAND_DISPLAY`, `DISPLAY`, scale, and GPU status so such
runs remain comparable.

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
event stream and three confirmed provider-shaped process lifecycles. The
desktop benchmark deliberately does not call a live external provider or
collect private provider output. Provider spawn/stop correctness and complete
process-tree confirmation remain release-blocking through `test:portable` and
the lifecycle suites.

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
