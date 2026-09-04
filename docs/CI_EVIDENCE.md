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
  tests; one packaged build; destructive runtime-recovery Electron tests; and an
  AppImage package, identity, fuse, native-guardian, and launch smoke;
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

Release tags continue through the independent full six-target release workflow.
Each target checks out and validates the exact tag, builds and smokes its native
package, stages checksummed assets, and uploads those exact bytes. The publish job
downloads and verifies the staged set before provenance attestation and upload.
The CI tiering change does not weaken or reuse unverified release bytes.

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
quality layer and lifecycle, provider, database, native-terminal, updater,
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
projects four shard weights of 512.811s, 513.534s, 512.810s, and 512.810s across
629 discovered tests. The measured/unknown file counts are respectively
147+9, 151+7, 149+8, and 149+9. The projected maximum is therefore about 8m 34s,
23.7% below the observed 11m 13s Vitest maximum. This is a scheduling
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
a checksummed CycloneDX dependency SBOM bound to the frozen source SHA, release
tag, and package-lock digest. Each target also runs and retains release-candidate
platform, desktop, and package-smoke performance evidence. The release tier
still needs a packaged N-1-to-N update/rollback scenario. The critical tier also lacks a
dedicated synthetic-turn Electron bridge distinct from the broader lifecycle
and package jobs. Scheduled certification has no repeated lifecycle flake run,
tracked-issue updater, or packaged N-1 fixture. Finally, CI retains first-attempt
logs but does not yet aggregate pass-on-rerun flake metrics or an owner-visible
quarantine policy. No blind retry was introduced to conceal those gaps.
