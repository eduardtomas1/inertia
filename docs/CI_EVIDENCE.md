# CI evidence lanes and timing record

For the 20 September follow-up, baseline-rejection diagnostics, opt-in
compatibility analysis and attempt-aware timings, see [CI speed study](CI_SPEED_STUDY.md).
The strict compatibility policy and job graph remain unchanged by that study.

The original implementation baseline was MAIN
`c9740a517da9636df343902cb4e08d851d9e33c9`; the final integration comparison is
MAIN `27bbc985a97d9e1857c33ce1585feae597d75ead`. Historical measurements below
remain tied to their recorded revisions. The original source baseline retained the audited overlapping PR/full tiers,
six copies of release quality and duplicate Linux coverage instrumentation.
Implemented scheduling is not a hosted timing result or repository protection.

## One explainable plan, one merge result

`scripts/ci/change-classifier.mjs` retains domain ownership.
`evidence-plan.mjs` turns it into a machine-readable plan containing the
comparison baseline, tested candidate and source head, lane, paths, domains,
reasons, required suites/jobs/checks/platforms and explicit job/platform omissions.
The plan is printed and attached to the classify job summary.
It does not select only tests whose filenames changed.

| Lane | Required evidence | Boundary |
| --- | --- | --- |
| Draft feedback | Shared quality/lineage, full canonical Linux coverage for code, selected native interaction/provider sentinels; clean minimum Node when its contract changes | `merge-ready` deliberately fails: draft feedback is not merge approval. |
| Merge validation | Quality/lineage once; canonical Linux coverage for code; contract-selected interaction, provider/native and package evidence | Ready-for-review and every subsequent head run the required plan. |
| Main validation | Quality/lineage only when the squash commit's tree equals the head of its merged PR, whose CI run has a successful `merge-ready`, and the previous main commit is an ancestor of that head; performance changes still run the complete plan | Any missing PR, run, tree match, ancestry or API answer requires the complete plan. |
| Nightly certification | All six native targets with every Electron project, full units/portable contracts, packages and the Linux x64 desktop benchmark | Each native matrix (package and Electron) is limited to two simultaneous target jobs; every failed attempt still fails certification. |
| Release certification | Shared quality once on frozen release SHA; every shipped native target, exact packages/signatures/fuses/upgrades/checksums/provenance | Separate non-cancellable tag owner; no PR artifact reuse or trust-policy change. |

Docs-only changes require quality and immutable migration lineage, but no
installer or Electron matrix. Renderer source and renderer DOM tests require full Linux
coverage and Linux display-sensitive, isolated and recovery Electron projects,
without native installers. Provider adapters require Linux coverage plus
three-OS lifecycle/transport proof; Windows/macOS also run the generated
portable contracts, and Windows retains native Codex shim/discovery proof.
OS-specific package paths select both architectures of that OS plus canonical
coverage. Shared lifecycle, startup, containment, migrations, shared contracts,
test infrastructure and native Electron verifier changes under `tests/e2e/`
require the primary targets (Linux x64, Windows x64, macOS arm64). Dependency
graphs, workflows, CI scripts, native and packaging sources, updater and guardian
code, and unknown changes require all six targets; outside the nightly, the
sibling architectures (Linux ARM64, Windows ARM64, macOS x64) run only the
runtime-recovery Electron project. Nightly and release run every project on all
six. This rule precedes
renderer matching and does not infer native coverage from a test's UI-facing
name. Mixed changes take the union; a full native target replaces
the equivalent same-platform sentinel.

No assertions are removed from full certification. The complete Linux x64
suite enforces unchanged all-source/per-area coverage thresholds once. Linux
ARM64 runs the same complete unit suite without duplicate instrumentation;
macOS keeps the two-worker bound; four Windows x64 duration-balanced shards
remain single-worker; Windows ARM64 retains its portable/native obligations.
Windows Electron remains one worker, other isolated desktop projects two. The
desktop Electron projects run in two jobs per complete target, display-sensitive
and isolated followed by runtime-recovery; Windows splits its isolated project
across two single-worker runners (see package evidence below). The package job itself has no Playwright
step.
The isolated browser-evidence CPU budget remains in CI quality and on each
release target, separate from instrumented coverage.
Ready PRs touching rendering, turns, runtime, storage or performance also run
bounded serialization, stream-coalescing, render-isolation and virtualization
checks in the quality gate. These use operation counts and fake clocks; full
platform/desktop timing benchmarks retain their main/nightly policy.

The stable `merge-ready` job uses `always()` and explicitly requires classifier,
quality, migration lineage and every planned result. It validates the canonical
plan and enumerates actual REST job records, including every selected matrix
member and all four required Windows shards. Failure, cancellation, timeout,
unexpected skip, missing/duplicate check, unplanned execution or wrong run/head
cannot count as success. Jobs intentionally omitted by the plan are distinct
from required jobs which did not execute.

GitHub PR checkouts test the synthetic merge SHA (`github.sha`); Actions REST
jobs identify the PR source head. The plan records both and every checkout is
explicitly pinned to the tested SHA. The gate checks its own checkout, both
plan identities, actual event/draft context, same-run job identity and source
head. A missing PR draft/source-head context fails closed; a merge plan cannot
authorize a run whose actual PR is still draft. Merge groups use the actual
queue candidate. The PR event list explicitly includes
`ready_for_review`, `synchronize` and `converted_to_draft`; GitHub's defaults
do not include the ready transition. See
[GitHub event semantics](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request)
and [needs/status conditions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idneeds).

## Cancellation without dropping unproven changes

Superseded PR, main-push and merge-group validations cancel their predecessors.
Release ownership remains separate and non-cancellable. Concurrency is not a
global priority scheduler; queue delay and runner contention must be measured
separately from execution time.

Main never classifies only `github.event.before`. A bounded read-only lookup
reuses certification only for a single-parent main commit whose one merged pull
request (same repository, base `main`) has a head with the identical Git tree,
whose previous main commit is an ancestor of that head, and whose CI run for that
head has exactly one successful `merge-ready` job. The plan records that run, and
the main `merge-ready` re-reads its job before accepting the reuse. Any other
outcome, including API permission, rate or timeout failures, expands to the
complete plan with full migration-lineage history.
The dependency action uses existing release Node 22.23.2 instead of floating
Node 22, while the deliberate uncached Node 22.13 install remains separate.
The lineage verifier's explicit `--all-history` fallback compares every reachable
manifest revision, bounded to 1,000 revisions with bounded Git reads. A root
commit predating the manifest is not treated as historical proof; unknown formats
and history exceeding the bound fail closed instead of silently skipping entries.

Git comparisons are NUL-delimited and use `--no-renames`, representing moves as
deletion plus addition so neither old nor new ownership disappears. Unsafe,
unknown or unavailable comparisons expand evidence. See the
[official workflow-run API](https://docs.github.com/en/rest/actions/workflow-runs)
and [job evidence API](https://docs.github.com/en/rest/actions/workflow-jobs).

## Package evidence and preserved trust

Each selected native target runs package and Electron jobs from the same source checkout, each
with its own `npm run build:packaged` for its exact source/target/configuration:

- `<label>` (the `test` matrix): units or portable contracts, the platform
  benchmark smoke, package construction, identity/fuse/static-guardian checks,
  packaged launch, final-container smoke, Windows N-1 installed upgrade and
  applicable signature checks. It contains no Playwright step.
- `<label> Electron (display-sensitive)` and `<label> Electron (isolated)` (the
  `electron` matrix): every target that runs the complete Electron suite gets
  both jobs. The first runs the single-worker display-sensitive project and, on
  Linux x64, keeps the provider-settings screenshots. The second runs the
  isolated project and then the sequential runtime-recovery project. On Linux
  x64 the desktop benchmark, when one is planned, runs first in that job, right
  after the Electron binary is prepared and before any Electron end-to-end
  project. Windows keeps one
  Electron instance per runner, so both Windows architectures replace the
  isolated job with `<label> Electron (isolated 1/2)` and
  `<label> Electron (isolated 2/2)`, each running
  `playwright test --project=isolated --shard=N/2` with one worker. Playwright
  shards by whole spec file in the unsharded order, and only shard 1 runs the
  runtime-recovery project afterwards. Outside the
  nightly, a sibling architecture runs only the runtime-recovery project as
  `<label> Electron (runtime-recovery)`. Each job builds the exact candidate on
  a separate runner and uploads its compact timing report under its own phase.
  Display and recovery retain their serial project settings internally.

All are required checks in the plan (`requiredChecks` lists every Electron
job) and all are enumerated by `merge-ready` from the
REST job records. Neither transfers an artifact to the other: the Electron job
runs against its own built bundle and the downloaded Electron binary, exactly
as the Linux interaction sentinel already did, so no cross-job artifact
identity or transfer protocol is introduced. Package evidence can no longer be
suppressed by a later display assertion, and a failed Electron fixture cannot
leave an unconfirmed runner for the package phases, because they never share
one.

Within each job the phases remain sequential and stop after failure: no
assumption that a failed fixture left a safe runner. A unit/build/package
failure can still prevent later package evidence in its own job. Package-first
ordering does not make a failed run release-ready or replace exact final
signed-byte proof. Publisher/download/checksum/provenance/tag-revalidation
logic is unchanged, and the release workflow keeps its single sequential job
per target.

The split targets the measured critical path of main run
[35883688368](https://github.com/eduardtomas1/inertia/actions/runs/35883688368)
(23 September 2026, success, all six targets), where the Electron projects were
the longest phase of every native job and ran only after that platform's units
and package proof:

| Job | Wall time | Units or portable | Package and smoke | Display | Isolated | Recovery |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| macOS x64 | 70.2 min | 19.7 | 7.2 | 22.6 | 10.9 | 1.7 |
| Windows ARM64 | 56.3 min | 10.6 | 6.5 | 14.6 | 9.5 | 1.1 |
| macOS arm64 | 49.0 min | 10.9 | 4.5 | 19.1 | 8.3 | 1.6 |
| Linux x64 | 35.5 min | 9.0 | 2.9 | 13.7 | 5.4 | 1.0 |
| Windows x64 | 35.4 min | (shards) | 6.1 | 13.6 | 8.4 | 1.0 |
| Linux ARM64 | 30.7 min | 6.2 | 2.6 | 12.7 | 4.5 | 0.9 |

With the two jobs in parallel the projected per-platform wall time is the
longer of the two halves plus one repeated install and build (about two to
nine minutes depending on the runner), for example roughly 42 minutes instead
of 70 on macOS x64. This is a projection from those step timings, not a hosted
measurement; the first full runs on this workflow supply the before/after
comparison, and the runner budget rises by one install and build per target.
The later macOS x64 phase split responds to main run
[36244548680](https://github.com/eduardtomas1/inertia/actions/runs/36244548680):
its Electron job took 48m04s, including display 26m04s, isolated 13m59s and
recovery 2m03s. Pull-request run
[37114090261](https://github.com/eduardtomas1/inertia/actions/runs/37114090261)
showed the same shape on the primary tier: Windows x64 Electron took 30.3
minutes (display 11.4, isolated 13.3, recovery 0.9) and Linux x64 Electron 21.2
(11.4, 7.5, 0.8). Every complete target therefore runs display-sensitive and
isolated-plus-recovery as two jobs, which costs one additional install and
build per target, and the recovery project, about one to two minutes, no
longer needs a runner of its own. After page-driven scenarios moved to the
isolated lane, Windows x64 carried about 1,190 seconds of single-worker
isolated test time against about 490 seconds of display-sensitive time, so the
Windows isolated project is sharded in two rather than run with a second
worker. Full-suite jobs precede recovery-only siblings in the matrix, and
outside the nightly the Electron matrix may run ten jobs at once, which covers
every pull-request tier without queueing behind `max-parallel`.
The matrices may request six macOS runners across both architectures; hosted
concurrency limits can queue jobs. The gain must be measured from completed
hosted runs, not inferred from the sum of phase times.

Opt-in authenticated Kimi smoke runs only on trusted scheduled Linux x64,
never under PR/merge-group source. Missing secret is explicitly not exercised.
The separate latest-provider drift workflow remains secret-free and outside
the required merge checks. It now fails its final check when any acquisition,
install or probe fails, after collecting issue-report evidence. It runs on its
weekly schedule or by manual dispatch, and a cancelled run never files an
incident.

## Verification retirement map

| Removed duplicate execution | Retained authority | Distinct native proof retained |
| --- | --- | --- |
| Critical PR tier alongside complete same-platform certification | Complete selected/full target units, Electron and package gates | Windows x64 four complete shards; Windows ARM64 portable/native; both macOS architectures |
| Linux sentinel's repeated focused unit list | Same tests in canonical Linux full coverage | Linux core bridge/recovery for narrow contracts; full Electron and exact package smoke for broad/package contracts |
| Narrow provider/renderer Linux AppImage construction | Selected Linux package target on packaging/lifecycle risk; full nightly/release matrix | No installed-boundary claim from an unpackaged renderer/provider-only run |
| Linux ARM64 coverage instrumentation | Complete ARM64 unit suite plus unchanged Linux x64 coverage thresholds | ARM64 ABI, static guardian, Electron and AppImage proof |
| Six repeated release lint/type/architecture checks | One frozen-source release quality prerequisite | Per-target full unit/ABI/CPU/native/package/signature checks |
| Independent migration workflow dispatch duplicated outside aggregate | Same reusable lineage job inside CI and required by merge-ready | Released migration comparison and semantic migration tests preserved |

The planner, gate and baseline tests exercise docs/renderer/provider/OS/mixed/
shared/unknown changes; deletion/rename; unavailable comparison; failed or
cancelled predecessor; incompatible/foreign/non-ancestor baseline; missing,
duplicate, skipped, failed and wrong-identity shards; draft non-approval; and
the exact workflow output/selection contract. Existing packaged, minimum-Node,
release-trust and native-worker assertions remain, with topology expectations
updated to their retained owners.

## Dependabot review

Version updates now keep native ABI/extraction/update dependencies out of the
generic production group, and Electron/build/browser/DOM test infrastructure
out of the generic development group. Vitest and its coverage adapter form one
coordinated verifier group, including majors, instead of incompatible separate
major PRs. Provider SDKs retain their existing individual review exclusions.
Existing compatibility ignores, action SHA pins, schedules and open-PR limits
are preserved. No automerge, disabled rebasing, new security-update suppression,
credentialed PR execution or automatic upstream approval is introduced.
[Dependabot grouping semantics](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference#groups)
distinguish default version groups from security updates.

## Administrative merge protection (applied with explicit authorization)

The initial 2026-09-07 read-only API check reported main protection disabled
and no repository/inherited rulesets. After explicit owner authorization,
classic protection was applied to the exact `main` branch and verified through
both REST and GraphQL:

- Pull requests and up-to-date branches are required.
- The exact `merge-ready` check must come from the observed GitHub Actions app
  (ID 15368); arbitrary status publishers are not accepted.
- Administrators are subject to the same rules; no bypass allowance was added.
- Force pushes and branch deletion are disabled.
- Review conversations must be resolved; stale approvals are dismissed.
- Zero independent approvals are required, so the PR boundary does not depend
  on a second maintainer being available. Code-owner and last-pusher approval
  requirements were not introduced.

The main commit remained `27bbc985a97d9e1857c33ce1585feae597d75ead`; no merge,
release, tag or workflow run was authorized by this configuration change.
Other PRs must also supply the required aggregate, which this stabilization
branch introduces. Green local tests or historical checks do not satisfy it.
No merge queue was configured. A changed YAML file cannot itself activate
repository protection; these are separately verified administrative settings.

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

## Desktop benchmark first-open gate

Settings and the command palette must open in under 100 ms (250 ms on hosted
Intel macOS). That gate used to read one sample, taken on the first launch
after the build. On hosted macOS arm64 that sample depended on the runner:
it crossed 100 ms in 2 of the 10 main runs from 2026-09-30 to 2026-10-01
(104.9 and 143.7 ms), in 2 of 3 diagnostic runs measured before any E2E
(100.1 and 206.3 ms) and in 10 of 30 samples measured after E2E. It failed
the v0.0.66 release build with 119 ms.

The benchmark now opens both surfaces once on the fresh-profile launch, without
gating that warm-up. It then relaunches the same profile five times and gates
the median. The report keeps the warm-up and every sample. In CI the Linux x64
benchmark runs right after the Electron binary is prepared, before any
Electron end-to-end project. In the release build job it runs on its own
`npm run build:bundle` before the unit suite. The single `build:packaged`
bundle that packaging and smoke consume is built later, unchanged.

Hosted proof on 2026-10-04 (settings first open, ms; runs
[37195371151](https://github.com/eduardtomas1/inertia/actions/runs/37195371151),
[37197578474](https://github.com/eduardtomas1/inertia/actions/runs/37197578474),
[37198662061](https://github.com/eduardtomas1/inertia/actions/runs/37198662061)
and [37195531018](https://github.com/eduardtomas1/inertia/actions/runs/37195531018)):

| Runner and position | Warm-up | Five measured relaunches | Median |
| --- | ---: | --- | ---: |
| macOS arm64, fresh 1 | 40.9 | 33.4, 60.0, 46.0, 58.6, 85.0 | 58.6 |
| macOS arm64, fresh 2 | 79.0 | 130.8, 60.0, 83.4, 45.0, 69.4 | 69.4 |
| macOS arm64, fresh 3 | 41.5 | 77.3, 69.9, 72.7, 66.3, 59.7 | 69.9 |
| macOS arm64, fresh 4 | 62.1 | 113.6, 36.9, 64.4, 74.6, 55.3 | 64.4 |
| macOS arm64, fresh 5 | 74.5 | 67.9, 65.5, 63.9, 74.8, 85.4 | 67.9 |
| macOS arm64, fresh 6 | 92.1 | 85.1, 60.3, 114.8, 61.3, 75.1 | 75.1 |
| macOS arm64, release order 1 | 36.1 | 53.0, 39.3, 40.0, 38.3, 47.8 | 40.0 |
| macOS arm64, release order 2 | 67.2 | 98.1, 84.9, 70.4, 72.4, 158.7 | 84.9 |
| macOS arm64, release order 3 | 36.7 | 99.1, 42.4, 38.1, 39.0, 44.6 | 42.4 |
| macOS arm64, release order 4 | 153.8 | 40.2, 76.5, 66.1, 60.6, 53.0 | 60.6 |
| Linux x64 under Xvfb, fresh | 57.4 | 61.2, 60.0, 62.2, 57.3, 65.1 | 61.2 |
| Windows x64, fresh | 50.1 | 52.9, 52.3, 53.5, 49.7, 50.7 | 52.3 |
| macOS x64, fresh (250 ms target) | 93.6 | 106.1, 350.8, 160.1, 296.9, 135.6 | 160.1 |
| macOS arm64, after 27 min of E2E | 52.5 | 55.0, 62.4, 53.9, 63.2, 54.2 | 55.0 |
| macOS arm64, after 44 min of E2E | 95.7 | 299.6, 126.9, 395.3, 108.2, 338.8 | 299.6 |
| macOS arm64, after the unit suite 1 | 41.2 | 102.5, 59.9, 55.4, 37.4, 58.1 | 58.1 |
| macOS arm64, after the unit suite 2 | 97.2 | 188.3, 235.2, 526.0, 114.0, 232.6 | 232.6 |
| macOS arm64, after the unit suite 3 | 59.4 | 53.4, 46.8, 45.7, 50.0, 83.3 | 50.0 |
| macOS arm64, after the unit suite 4 | 78.6 | 67.8, 119.5, 45.3, 55.6, 100.3 | 67.8 |
| macOS arm64, after the unit suite 5 | 58.8 | 74.1, 102.9, 38.1, 70.0, 42.0 | 70.0 |
| macOS arm64, after the unit suite 6 | 84.0 | 57.2, 53.4, 50.2, 53.8, 74.3 | 53.8 |

"Fresh" builds and then measures, which is the CI position. "Release order"
runs the platform guard, the CPU budget check and `build:bundle` first, which
is the release position. Every median in those positions is below the target,
although 6 of their 65 measured samples and one warm-up are not. Two of the eight runners
measured after a heavy phase failed the median too. On both, the unrelated
2,000 ms streaming long-task ceiling failed in the same run (2,087 and
3,147 ms), so the whole runner was saturated. That is why the benchmark now
runs before the heavy phases instead of relying on the median alone.

The five relaunches add 30 to 60 s to the macOS arm64 benchmark step (181 to
219 s, against 137 to 169 s for recent main and release runs). They add
about 50 s on Linux x64, 35 s on Windows x64 and 90 s on macOS x64. The
release build job also spends 26 to 42 s on the extra bundle build on macOS
arm64, and 38 to 78 s on the other platforms.

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
projects four shard weights of 533.393s, 533.393s, 533.392s, and 533.392s across
648 discovered tests. The measured/unknown file counts are respectively
148+13, 149+13, 150+12, and 149+14. The projected maximum is therefore about
8m 53s, 20.7% below the observed 11m 13s Vitest maximum. This is a scheduling
projection, not a hosted-run result; install time, runner variance, and queue
time are excluded.

## Current verification and measurement limits

Local planner/gate/lineage/topology and preserved package-contract checks are
recorded in the stabilization evidence ledger. Actionlint uses the existing
1.7.7 checksum-pinned binary. Hosted final-head and native-platform certification
remain required; no local unit pass is described as a hosted or installed pass.

The current-source baseline full check took 169.34 seconds, stopped before
build with four pre-existing SBOM checkout-basename assertions, and reported
7,137 passing/77 skipped tests. It is a failed baseline, not a successful timing
comparison. The historical successful timings above remain historical, and
their Windows sharding projections are not current-run measurements.

The separate unchanged-MAIN coverage baseline used Node 22.23.2, npm 10.9.8,
Vitest/coverage-v8 4.1.11 and the original lockfile, with
`npm run test:coverage -- --maxWorkers=2 --coverage.reportOnFailure`.
It exited 1 after 502.40 seconds: 7,133 passed, 77 skipped, four original SBOM
failures and four runtime-event timeouts with providers still checking.
This failed run still produced the requested all-source denominator evidence:

| Coverage metric | Covered / total | Percentage |
| --- | ---: | ---: |
| Statements | 64,041 / 79,887 | 80.16% |
| Branches | 52,222 / 69,509 | 75.12% |
| Functions | 12,660 / 15,524 | 81.55% |
| Lines | 59,559 / 71,676 | 83.09% |

The baseline summary contains 946 source files out of 947 tracked
`src/**/*.ts(x)` paths; only `src/renderer/private-connect/vite.config.ts` is
absent under the unchanged Vitest 4 defaults. The original lock SHA-256 is
`ee1f8e6b7c9fd48194fae1a3ac6248ef45f03014131fa2ab4097fc1f1541e99e`.
Candidate Vitest 5 coverage must compare normalized source-path inventories
and denominators, not infer unchanged coverage inputs from percentages alone.

No numeric CI speedup is claimed yet. Before/after reporting must include
exact source/toolchain, cold/warm dependency state, queue delay, critical-path
wall time, summed runner time and first useful failure time for comparable
successful lanes. This CI/test/dependency-changing stabilization PR requires
the final six-target matrix and all Windows shards on its combined ready head.
An earlier draft or older-head pass is not that evidence.

Cross-job native artifact reuse, global runner priority, hosted speedup and
new live-provider/installed upgrade claims are not implemented by this change.
Existing checksum-first published Windows N-1 same-profile installation proof,
Linux supported manual transition limitations, static guardian, Electron
fuses, signatures, SBOM and provenance obligations remain intact.
