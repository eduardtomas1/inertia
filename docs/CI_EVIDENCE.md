# CI evidence lanes and timing record

This describes the implementation relative to current MAIN
`c9740a517da9636df343902cb4e08d851d9e33c9`, not just the older audit snapshot.
The current-source baseline retained the audited overlapping PR/full tiers,
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
| Main validation | Same policy over the accumulated unproven diff from a trusted compatible successful ancestor | Missing/uncertain baseline requires the complete matrix. |
| Nightly certification | All six native targets, full units/portable contracts, Electron, packages, performance and retained three-attempt lifecycle checks | Native matrix limited to two simultaneous target jobs; every failed attempt still fails certification. |
| Release certification | Shared quality once on frozen release SHA; every shipped native target, exact packages/signatures/fuses/upgrades/checksums/provenance | Separate non-cancellable tag owner; no PR artifact reuse or trust-policy change. |

Docs-only changes require quality and immutable migration lineage, but no
installer or Electron matrix. Renderer-owned changes require full Linux
coverage and Linux display-sensitive, isolated and recovery Electron projects,
without native installers. Provider adapters require Linux coverage plus
three-OS lifecycle/transport proof; Windows/macOS also run the generated
portable contracts, and Windows retains native Codex shim/discovery proof.
OS-specific package paths select both architectures of that OS plus canonical
coverage. Shared lifecycle, startup, containment, migrations, toolchain,
workflow/test infrastructure, shared contracts and unknown changes expand to
all six targets. Mixed changes take the union; a full native target replaces
the equivalent same-platform sentinel.

No assertions are removed from full certification. The complete Linux x64
suite enforces unchanged all-source/per-area coverage thresholds once. Linux
ARM64 runs the same complete unit suite without duplicate instrumentation;
macOS keeps the two-worker bound; four Windows x64 duration-balanced shards
remain single-worker; Windows ARM64 retains its portable/native obligations.
Windows Electron remains one worker, other isolated desktop projects two.
The isolated browser-evidence CPU budget remains in CI quality and on each
release target, separate from instrumented coverage.

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

Main never classifies only `github.event.before`. A bounded read-only Actions
lookup considers up to 50 successful runs of this exact workflow on repository
`main` pushes. A candidate must belong to this repository, be older than the
current run, have a successful exact-head `merge-ready`, be a Git ancestor,
and have the same verification-contract digest. Failed/cancelled runs,
PR/fork runs, another workflow, non-ancestors and changed contracts cannot
nominate a baseline. API permission/rate failures, missing history or no
compatible run expand to full evidence.

Compatibility hashes the Git mode/blob/path identities of complete
`.github/`, `scripts/`, `tests/`, `benchmarks/` trees and root non-document
configuration files. This includes the lockfile, dependency action and verifier.
The dependency action uses existing release Node 22.23.2 instead of floating
Node 22, while the deliberate uncached Node 22.13 install remains separate.
No runner artifact supplies authority. The lineage reusable job consumes this
same baseline; unavailable main proof checks full history rather than forgetting
migration edits in a cancelled predecessor.
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

Each native target still builds once for its exact source/target/configuration.
Package construction, identity/fuse/static-guardian checks, packaged launch,
final-container smoke, Windows N-1 installed upgrade and applicable signature
checks now precede desktop E2E. Thus the observed failure mode where a later
display assertion suppressed package evidence is removed.

Native phases remain sequential and stop after failure: no assumption that a
failed fixture left a safe runner. A unit/build/package failure can still
prevent later evidence. Fully independent downstream diagnostics would require
isolated runners plus a measured, complete artifact identity and transfer
protocol; that is deliberately not introduced here. Package-first ordering
does not make a failed run release-ready or replace exact final signed-byte
proof. Publisher/download/checksum/provenance/tag-revalidation logic is unchanged.

Opt-in authenticated Kimi smoke runs only on trusted scheduled Linux x64,
never under PR/merge-group source. Missing secret is explicitly not exercised.
The separate latest-provider drift workflow remains secret-free and unchanged.

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

## Administrative merge protection (not applied)

The 2026-09-07 read-only API check reports main protection disabled and no
repository/inherited rulesets. This implementation does not modify settings.

An administrator must create an active main ruleset/branch protection requiring
pull requests and the exact `merge-ready` status check from GitHub Actions.
Require current-base evidence (strict checks or a configured merge queue);
if queueing is enabled retain the wired `merge_group: checks_requested` event.
Remove superseded individual matrix/sentinel required-check names only after
the aggregate is installed and observed on a final candidate. Keep normal
review requirements, restrict verifier/workflow changes to trusted review,
and do not grant an urgent-label/admin bypass for missing evidence.
A changed YAML file cannot itself activate those protections.

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
