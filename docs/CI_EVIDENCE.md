# CI evidence tiers and timing record

This document distinguishes observed timings from projections. A projection is
not promoted to an actual result until the corresponding workflow has completed
successfully on GitHub-hosted runners.

## Evidence tiers

Every pull request runs the classifier and quality gate in parallel, the Node
22.13 compatibility check, and the independent migration-lineage workflow. It
then runs four explicit critical jobs in parallel:

- Linux x64: the complete all-source coverage suite, including every generated
  portable provider/runtime test, and production dependency audit;
- Linux x64 lifecycle: focused updater, containment, recovery, and shutdown unit
  tests; a compact synthetic-turn Electron/core bridge; one packaged build;
  destructive runtime-recovery Electron tests; and an AppImage package,
  identity, fuse, native-guardian, and launch smoke;
- Windows x64: focused Job Object, containment, updater-handoff, recovery, and
  shutdown tests followed by one build and destructive Electron recovery;
- macOS arm64: focused guardian, containment, terminal shutdown, updater-handoff,
  recovery, and shutdown tests followed by one build and destructive Electron
  recovery.

The complete six-target package/E2E matrix and the four full Windows x64 unit
shards additionally run for every push to `main`, merge-queue group, scheduled
certification, and release-relevant affected pull request. A pull request is
promoted to that full tier for an all-evidence result or a runtime-supervisor,
process-containment, startup-recovery, terminal-native, updater, platform-package,
renderer, or performance change. Shared test infrastructure, workflows,
dependency manifests, shared contracts, and unclassified paths are all-evidence,
so this CI-changing pull
request itself runs both the critical and complete tiers. Isolated provider,
turn/session, agent-management, database, and documentation changes retain the
critical tier without paying for all six native packages.

Full benchmarks run for performance/all-evidence pull requests and for every
`main`, merge-queue, and scheduled run. Other full-tier affected pull requests
retain all correctness evidence but skip benchmark-only steps. Concurrency groups
are separate by event and ref, and only superseded pull-request runs are cancelled.

Scheduled certification attempts a focused common and platform-specific
lifecycle set up to three times in fresh Vitest processes on all six targets,
stopping early only when cleanup is unconfirmed. Every attempted run and a
structured pass/failure/flake summary are retained for 30 days; one failed
attempt fails the target after artifact publication. A failed scheduled
certification opens or updates one tracked issue with the exact SHA, failed job
and step names, platform, locked provider-version link, run/artifact link, and an
occurrence count derived only from marked automation reports. Failure of that
issue reporter is itself visible rather than being converted to success.

The hostile browser-evidence batch keeps its 1.5-second thread-CPU ceiling in
`npm run test:browser-evidence-cpu-budget`, which starts one fresh,
uninstrumented
Vitest worker. The ordinary and coverage suites still execute every exact
sanitization, publication, redaction, ordering, and bound assertion, but do not
charge concurrent V8 coverage bookkeeping to the production CPU budget. Every
CI event runs the isolated guard in the Linux quality gate, and the release
matrix repeats it on each target platform.

Release tags continue through the independent full six-target release workflow.
Each target checks out and validates the exact tag, builds and smokes its native
package, stages checksummed assets, and uploads those exact bytes. The publish job
downloads and verifies the staged set before provenance attestation and upload.
It also re-reads the direct and peeled remote tag under a bounded noninteractive
Git operation immediately before draft creation, every missing-asset upload,
the final publish transition, and every `canary-feed` ref push, so a remotely
moved tag cannot inherit frozen
artifacts from the earlier validation window.
The CI tiering change does not weaken or reuse unverified release bytes.

Stable Windows x64 full and release certification also select the greatest
published version below the candidate, require its architecture-specific installer
and `SHA256SUMS.txt`, stream both under byte ceilings, and verify the exact digest.
The released N-1 installer is installed and smoked first; the N installer then
replaces it in the same directory and reopens the same bounded profile, workspace,
and database state. The installed N files are compared byte-for-byte with the
candidate unpacked tree before another smoke and uninstall. This is real packaged
NSIS replacement and existing-profile evidence; it does not claim to drive the
old app's `electron-updater` UI/handoff or fault-inject the privileged installer.
The PR Windows x64 lifecycle sentinel nevertheless compiles the native helper
and runs the deterministic updater startup, authenticated terminal-receipt, and
supervisor namespace-pinning suites. On Windows that supervisor suite retargets
a parent junction after request serialization and proves that the launch request
continues to name the previously canonicalized paths. Its Windows-only native
case also runs a delayed installer, observes an authenticated quarantine receipt
at the deadline before that installer completes, and then observes the installer
finish without having been killed. That configured Windows-only case also
exercises the integrity-locked broker path and rejects a second launch while the
first exact operation claim is live; portable contract tests prove that no
direct staged-exe update entry remains and that every native wait shares one
monotonic budget. This describes the enforced flow, not a hosted result for the
current change before CI has run.
Concurrent replacement of an
already-canonical native ancestor still requires packaged Windows evidence; a
Linux source/contract run is not counted as proof of that platform boundary.

For an ordinary pull request, the expected critical-path shape is the classifier
and quality gate followed by the slowest of the four parallel critical jobs; it
no longer includes Linux ARM64, Windows ARM64, macOS x64, six native package
builds, or four complete Windows unit shards. Existing logs measured the Linux
coverage step at 5m 48s and the formerly duplicated portable step at 1m 34s,
but those step samples do not establish a complete new job duration. The
portable tests remain inside the complete coverage suite. No 6–10 minute target or other
numeric after value is claimed before the new jobs run successfully.

## Conservative change classification

`scripts/ci/change-classifier.mjs` emits explicit Boolean outputs for the shared
quality layer and lifecycle, including distinct Codex, Claude, Cursor, Gemini,
Kimi, and OpenCode provider domains, plus database, native-terminal, updater,
packaging, renderer, performance, and CI/test domains. Documentation is narrow:
every changed path must be a recognized documentation path. Empty diffs, malformed
paths, new unclassified paths, workflow/test infrastructure, dependency manifests,
and shared contracts fail open to every evidence domain.

The classifier is tested as a pure function. Its workflow invocation uses a
NUL-delimited Git diff and also fails open if either commit cannot be resolved or
Git cannot produce the comparison. The quality gate validates every workflow with
checksum-pinned actionlint 1.7.7 before installing project dependencies.

## Generated portable conformance suite

Portable tests opt in with this exact first line:

```text
// @inertia-test-suite portable
```

`npm run test:portable` discovers and sorts those files; there is no duplicated
path list in `package.json`. A production harness owner adds a second-line marker
such as `// @inertia-harness cursor-acp`. The portable architecture test compares
those unique owners with `createDefaultAgentHarnessRegistry()`, so adding or
removing a production harness without portable conformance coverage fails CI.

## Measured baseline

These are successful runs from the repository before this change:

| Workflow | Run | Wall time | Summed job time | Longest job |
| --- | --- | ---: | ---: | ---: |
| Pull-request CI | [33848742570](https://github.com/eduardtomas1/inertia/actions/runs/33848742570) | 54m 45s | 178m 02s | 36m 28s |
| Pull-request CI | [33839461996](https://github.com/eduardtomas1/inertia/actions/runs/33839461996) | 55m 25s | 180m 38s | 30m 17s |
| Pull-request CI | [33776127825](https://github.com/eduardtomas1/inertia/actions/runs/33776127825) | 51m 16s | 164m 32s | 31m 44s |
| Release | [33799039862](https://github.com/eduardtomas1/inertia/actions/runs/33799039862) | 110m 38s | 190m 10s | 53m 42s |

Run 33848742570 is also the checked Windows x64 duration source. All four unit
jobs succeeded at commit `68f5ea8cded5582a535e6014ae9a2ccf1d288bc7`.
The legacy hash shards had these measured test-file sums and Vitest durations:

| Shard | Test-file sum | Vitest duration |
| --- | ---: | ---: |
| 1 | 564.229s | 672.93s |
| 2 | 404.420s | 512.01s |
| 3 | 363.352s | 476.50s |
| 4 | 149.109s | 245.97s |

The slowest shard was 2.74 times the fastest. The checked manifest contains all
596 measured file durations from those successful logs. It assigns unmeasured
files the observed nearest-rank p90 test duration (3,575ms) plus 720ms per-file overhead, so a
new test cannot receive a zero-cost shard assignment. Manifest input is bounded
by path, count, file size, duration, shard count, and successful-run provenance.

On the current working tree, deterministic longest-processing-time partitioning
projects four shard weights of 532.500s, 532.500s, 531.776s, and 532.499s across
647 discovered tests. The measured/unknown file counts are respectively
148+13, 149+13, 149+12, and 150+13. The projected maximum is therefore about
8m 53s, 20.9% below the observed 11m 13s Vitest maximum. This is a scheduling
projection, not a hosted-run result; install time, runner variance, and queue
time are excluded.

## After measurement status

There is no actual after result yet. The ordinary PR critical path has no numeric
claim until all four new jobs succeed on hosted runners; their 25-minute timeouts
are safety bounds, not estimates. This CI-changing pull request intentionally
fails open to both critical and complete evidence, and its first successful hosted
run will be reported without relabeling either projection as actual. A subsequent
ordinary provider/documentation pull request is required to measure the reduced
tier itself. Failed or cancelled runs must not refresh
`.github/test-durations/windows-x64.json`.

## Remaining CI work

The full CI tier builds once inside each native target job, and the release tier
now packages and smokes the one bundle built by that target rather than invoking
a rebuilding `dist:*` path. Cross-job fan-out still needs a portable artifact
identity containing the commit, lockfile, Node, Electron ABI, native-helper,
OS/architecture, and build-configuration inputs. Release finalization publishes
a checksummed CycloneDX dependency SBOM from the complete production lockfile
union, including platform-optional packages, and binds it to the frozen source
SHA, release tag, lockfile digest, and every exact staged asset digest. Each
target also runs and retains release-candidate
platform, desktop, and package-smoke performance evidence. Packaged stable Windows
x64 now covers a successful N-1-to-N same-profile NSIS transition, but native
`electron-updater` initiation and deterministic interrupted-installer rollback
remain unproved with packaged artifacts. Cross-night trend aggregation and an
owner-visible quarantine policy also remain future work; a pass after any failed
nightly attempt is already classified and failed as a flake. No blind retry was
introduced to conceal those boundaries.
