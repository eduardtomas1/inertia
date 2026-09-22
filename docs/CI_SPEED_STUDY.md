# CI speed study: evidence before scheduling

Source: *Faster CI. Same evidence.*, 16 September 2026, supplied as
`Inertia_CI_Speed_Paper.pdf` (16 pages). Its repository snapshot was
`5aaaaac8a9155c13bde7671455bc224762513238`, v0.0.57. This follow-up inspected
fresh main `d56f972b32fadfa29169bb8390401f5ca49e419b`, v0.0.60, on 20 September.
The paper used two successful historical runs; its 10–12 minute renderer PR
and 30–40 minute full-CI figures are unexecuted projections.

## The historical baseline expansion was necessary

The paper correctly identifies that leaf-test content changes the global
verification fingerprint. It does **not** establish that relaxing that condition
would have avoided full certification of its example, main run
[35087745922](https://github.com/eduardtomas1/inertia/actions/runs/35087745922).
The actual successful ancestor matters:

| Main run | Head | Result |
| --- | --- | --- |
| [35051422898](https://github.com/eduardtomas1/inertia/actions/runs/35051422898) | `353a8874cf98bdd93f8d4037a5bb569d5f0c4b46` | Success |
| [35062755971](https://github.com/eduardtomas1/inertia/actions/runs/35062755971) | `8dae5ecdb4e842de8fde130f5f2137e9b732f3c9` | Failure |
| [35079208465](https://github.com/eduardtomas1/inertia/actions/runs/35079208465) | `7b841aac910278dd064976efaebe082ea2932026` | Failure |
| [35087745922](https://github.com/eduardtomas1/inertia/actions/runs/35087745922) | `5aaaaac8a9155c13bde7671455bc224762513238` | Success |

The accumulated diff from `353a8874` to `5aaaaac8` changes **20 verification
entries**, including `.github/workflows/ci.yml`, the release workflow,
`electron.vite.config.ts`, `scripts/check-renderer-bundle.mjs`, native E2E and
snapshot helpers. Ignoring only the Limits DOM-test edit still leaves an
incompatible verifier. Replaying the ten most recent successful main candidates
before this run rejects all ten under both the strict and proposed fingerprints.
Using `HEAD^` instead would discard the two failed runs' unproven changes.

A second bounded replay considered the 12 latest main runs available at the
start of this study against the preceding candidates in a 20-run listing
(18–20 September). Every successful eligible candidate had a changed strict
and proposed contract. No new baseline or omitted check was demonstrated.
This is a bounded observation, not a claim about all repository history.

## Implemented observability

Main classification records rejection counts and at most ten candidate details,
with at most ten changed contract paths each. Paths are sanitized; file contents
and command stderr are excluded. Categories distinguish invalid run metadata,
ancestry/history failure, unavailable versus changed contracts, and missing exact
successful `merge-ready` evidence. API errors use fixed failure classes. Lookup
retains the 50-candidate and bounded Git/API limits and adds a two-minute shared
deadline. Missing/malformed/truncated job totals fail closed.

Normal execution retains the original strict fingerprint and canonical plan.
For a future measured case, setting `INERTIA_CI_BASELINE_SHADOW=true` when invoking
`scripts/ci/plan-workflow.mjs` opts into a read-only comparison. **No workflow sets
this flag.** The hypothesis masks only the content hash of existing regular
`tests/renderer/**/*.dom.test.tsx` files with conventional names. It retains the
path inventory and Git modes, so additions, deletions, renames and symlinks still
invalidate compatibility. Other tests, helpers, setup, native resources,
configuration, dependency graphs and verifier changes retain exact identities.
Unknown paths still expand the normal classifier. Shadow API failures cannot
replace strict evidence; shadow data never enters workflow outputs or the
canonical `merge-ready` plan.

Each Electron CI invocation retains a compact report with candidate/source SHA,
run/attempt, runner image identity when available, project/shard, current test
identity set, file counts, status and all per-test attempt durations. Identity
includes the Playwright project and test identity; titles are hashed. Reports
exclude stdout, errors, attachments and unrestricted config/environment data.
Artifacts survive success or failure for seven days. Existing line output,
first-failure traces, screenshots, deadlines, retries and worker limits stay the
same. The benchmark configuration remains separate and uncontended.

The read-only collector can be run locally with authenticated `gh`:

```sh
node scripts/ci/collect-workflow-timings.mjs OWNER/REPO OUTPUT.json 25
```

It reads the latest completed CI runs, including failed/cancelled runs, and all
attempts (maximum 50 runs, ten attempts per run, three pages of jobs per attempt).
It records labels, run/head/attempt identities, admission intervals, job and step
durations without downloading logs or artifacts. It rejects ambiguous identities
and incomplete pagination. Missing/negative timestamps remain unavailable, not
zero. REST labels cannot establish exact image versions or cache hits; the
collector explicitly records those limits.
PR REST heads are source heads, not the tested synthetic merge SHA; exact
candidate and lane identity comes from the plan and Electron reports.

A real API wrinkle matters: partial reruns can create **new job IDs and attempt
numbers with previous execution timestamps**, even though the job was not run
again. For example, the Intel job in attempt 2 of
[35490533939](https://github.com/eduardtomas1/inertia/actions/runs/35490533939)
was created at 05:59:13Z but retained its 05:01:01–05:58:26Z execution interval.
The collector flags these as carried-forward evidence and excludes their times
from new runner consumption. First failed attempts remain separate records.

## Fresh timing evidence

The latest 25 completed runs at collection comprised 14 successes, six failures
and five cancellations, across 27 attempts. Twenty-five job records were carried
forward. This mixed-lane sample is not a latency median, p95 or flake-rate estimate.
The main-only sample below includes failures and the Intel rerun; times are
seconds from REST timestamps, with queue separated from execution.

| Main run / attempt | Intel job result | Queue | Job | Units | Display | Isolated | Recovery |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| [35372233330](https://github.com/eduardtomas1/inertia/actions/runs/35372233330) / 1 | Failure | 10 | 3550 | 1066 | 1097 | 590 | 104 |
| 35372233330 / 2 | Success | 6 | 3240 | 1025 | 980 | 544 | 97 |
| [35383597035](https://github.com/eduardtomas1/inertia/actions/runs/35383597035) / 1 | Success | 613 | 3751 | 1287 | 1100 | 557 | 88 |
| [35390520102](https://github.com/eduardtomas1/inertia/actions/runs/35390520102) / 1 | Success | 9 | 3555 | 1105 | 1083 | 551 | 102 |
| [35430377914](https://github.com/eduardtomas1/inertia/actions/runs/35430377914) / 1 | Success | 4 | 4282 | 1302 | 1282 | 758 | 112 |
| [35439933146](https://github.com/eduardtomas1/inertia/actions/runs/35439933146) / 1 | Success; run failed | 2 | 3473 | 1054 | 1032 | 517 | 98 |
| [35465393184](https://github.com/eduardtomas1/inertia/actions/runs/35465393184) / 1 | Success | 3 | 3903 | 1123 | 1171 | 730 | 107 |
| [35470622797](https://github.com/eduardtomas1/inertia/actions/runs/35470622797) / 1 | Success | 344 | 4037 | 1338 | 1095 | 755 | 117 |
| [35478889271](https://github.com/eduardtomas1/inertia/actions/runs/35478889271) / 1 | Success | 3 | 3694 | 1198 | 1127 | 551 | 93 |
| [35490533939](https://github.com/eduardtomas1/inertia/actions/runs/35490533939) / 1 | Success | 3 | 3445 | 1033 | 996 | 658 | 108 |
| 35490533939 / 2 | Carried forward | — | — | — | — | — | — |
| [35498210250](https://github.com/eduardtomas1/inertia/actions/runs/35498210250) / 1 | Success | 2 | 3406 | 951 | 1117 | 551 | 105 |
| [35504295592](https://github.com/eduardtomas1/inertia/actions/runs/35504295592) / 1 | Failure | 3 | 4730 | 1589 | 1163 | 855 | 148 |
| [35511703984](https://github.com/eduardtomas1/inertia/actions/runs/35511703984) / 1 | Success | 3 | 3363 | 973 | 972 | 571 | 105 |

In the newest successful run, Intel units plus Electron consumed 2621/3363
seconds (77.9%). Native package construction was 276 seconds. ARM macOS took
2571 seconds overall; Windows ARM64 took 2513. The same bottlenecks remain, but
separating only Intel work would leave those paths. The two queued Intel runs
above also queued ARM macOS for 628 and 612 seconds, respectively.

[GitHub's published concurrency limits](https://docs.github.com/en/actions/reference/limits#job-concurrency-limits-for-github-hosted-runners)
currently give Free/Pro/Team accounts five macOS slots. Account-wide available
capacity and support overrides were not measured here; a repository's job
history cannot prove spare account capacity. Consequently this change does not
multiply jobs. The new timings support a later capacity-aware paired experiment.

## Disposition of the report's recommendations

| Recommendation | Decision and evidence |
| --- | --- |
| P0 baseline rejection and lane-expansion diagnostics | Accepted: bounded diagnostics, opt-in old/proposed plan comparison. |
| P0 leaf-test compatibility enablement | Deferred: mechanism exists, but the claimed example still needs full certification and the fresh bounded sample shows no saved obligations. Filename alone also cannot prove a DOM test has no platform-dependent assertions. |
| P1 three display shards plus isolated/recovery jobs | Deferred: fresh serial durations justify an experiment, not enabling an unmeasured graph. Need current discovery union/disjointness, known-failure controls and same-candidate cold/warm hosted comparisons first. Keep one worker per display. |
| P1 native units/desktop/packaging split | Deferred: actual macOS queue pressure and unknown account-wide capacity. Exact package-to-smoke linkage, lifecycle isolation and benchmarks remain intact. |
| P1 exact check/discovery enumeration | Existing exact check enumeration retained. New reports preserve discovery identities for a future partition proof; reports do not authorize shards by themselves. |
| P2 successful-run timing reports | Accepted: compact current-test reports and attempt-aware REST collection. Detailed fixture-phase profiling awaits a demonstrated dominant fixture. |
| P2 core/coverage sharding | Deferred: no pinned Vitest/V8 counter and denominator equivalence experiment. Full all-source/per-area coverage remains one required execution. |
| P2 retire high-level assertions | Deferred: no individually proven equivalent lower-level regression; no tests removed. |
| P3 caches, checkout and report formatting | No demonstrated critical-path benefit. Existing exact native cache, Oxlint, TS7, build-once-per-native-job and Windows duration sharding already implement the important items. |
| New package manager/scheduler, permanent self-hosted runners, move checks to nightly | Rejected for this change: no measured benefit or safe capacity/isolation case. |
| 10–12 minute PR / 30–40 minute full-CI targets | Retained only as paper projections, not measured improvements or acceptance facts. |

## Hypothetical omission ledger

**No omission is enabled.** For the synthetic renderer-only fixture with an
otherwise compatible successful ancestor, the opt-in comparison enumerates:

| Newly absent strict-plan obligation | Proposed current-candidate replacement / prerequisite before enabling |
| --- | --- |
| Node 22.13 minimum runtime | None in targeted lane; every toolchain/root/config byte must remain compatible. |
| Linux x64 native job | Complete Linux all-source coverage plus full display/isolated/recovery projects run on the candidate. Packaging, fuses and container smoke would be absent only with unchanged native/package contracts. |
| Linux ARM64 native job | No same-architecture replacement; this omission needs an independently justified renderer-only scope. |
| Windows x64 and ARM64 native jobs | No same-platform replacement; installer, N-1 upgrade and native lifecycle obligations require unchanged contracts and independently justified scope. |
| macOS arm64 and x64 native jobs | No same-platform replacement; package/signature/native lifecycle omissions need independently justified scope. |
| All four Windows unit shards | Complete Linux suite covers test identities, but does not prove Windows semantics; filename-only compatibility is insufficient evidence. |
| Platform and desktop benchmarks | None in targeted lane; unchanged performance/control contracts required. |

The synthetic comparison explicitly adds `Linux core and portable conformance`
and `Linux interaction and lifecycle`, removes eleven concrete checks and eight
native/upgrade suite descriptions, and reports the benchmark change. Shared
quality and migration lineage stay required. Tests reject shadow results as
proof for a strict plan and reject mismatched source/merge candidates.

This slice claims improved diagnosability and reproducible measurement, **no
measured CI speedup**. A future policy or graph change must provide its own fresh
before/after evidence; preserving all current evidence is the default.
