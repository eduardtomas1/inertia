# Stabilization evidence — September 2026

This is an implementation ledger, not certification of every repository line.
Claims are separated into reproduced faults, preserved proof, and unexercised
boundaries. No personal profile, prompt, attachment, credential, or filesystem
path is included. All new execution fixtures use disposable synthetic data.

## Comparison baseline

- Current `main` at start: `c9740a517da9636df343902cb4e08d851d9e33c9`.
- Supplied audit baseline: `53041e4b0e172a626a57948bed5f7dc1b44ffefd`.
- Already merged and preserved: project/draft ownership #295, Linux installed
  update/discovery #297, native transcript hover #301, Linux chat regressions #299.
- Lockfile SHA-256: `ee1f8e6b7c9fd48194fae1a3ac6248ef45f03014131fa2ab4097fc1f1541e99e`.
- Local host: Linux x64, kernel 7.0.0-31-generic, 16 logical processors;
  Node 22.23.2, npm 10.9.8, Electron 44.1.0, Vitest 4.1.11.
- Clean dependency installation: `npm ci`, successful, 12 seconds; existing npm
  download cache, not a cold-network measurement. Audit: zero vulnerabilities.
- Release observed at start: v0.0.52. Release PR #302 belongs to separate work;
  this PR neither merges it nor publishes a release.
- Main branch protection was `false`; inherited/local rulesets returned `[]`.
  No administrative settings have been changed by this work.

The old audit run 34089367495 was unavailable (HTTP 404). Its precise assertion
is therefore not treated as established evidence. Current-main CI 34098556993
was queued at inspection; migration lineage 34098556983 succeeded. These are
point-in-time observations, not final candidate results.

The last successful full PR run available for comparison is
[34094854074](https://github.com/eduardtomas1/inertia/actions/runs/34094854074),
source `0891228374b5f90be13a749b5bfe810442c53803` (subsequently squashed as #299).
It took 2,669 seconds from creation to final update, with 12,986 summed positive
job seconds. Its longest job was macOS x64 at 2,597 seconds. This is a successful
historical sample, not an exact-current-main measurement or a projected saving.

## Finding ledger

| Finding | Current-main observation | Implementation / evidence status |
| --- | --- | --- |
| R1 terminal truth | Durable settlement and post-commit callbacks still share one failure catch. | Real controller/SQLite fault injection in progress. |
| CI duplication | Critical sentinels/core coverage overlap full certification. | Existing invariants being mapped before job selection changes. |
| Test scheduling | Primary-display classification uses a literal string and top-level discovery. | Explicit resource ownership and recursive completeness checks planned. |
| Script duplication | `check` and `check:platform` repeat Private Connect type/build work. | Preserve standalone commands; measure composed responsibilities before removal. |
| Discovery benchmark | Audit's “discovery disabled” conclusion is incomplete: package-smoke executable setting enables it on current main. | Correct documentation; control installed/missing/slow cases and readiness attribution. |
| Production dependencies | Current baseline audit reports zero advisories. | No speculative security defect claimed. |
| Recovery worker boundary | Client assumes a typed message from a real Node worker. | Validate malformed-response reproduction before changing protocol. |

## Scope and ownership

One runtime integrator owns terminal commitment, cleanup authority, and callback
classification. CI planning and native transport investigation are separate
workstreams. Renderer draft/pane state remains distinct from durable turn state;
there is no replacement state engine, generic provider rewrite, or UI redesign.

The user subsequently authorized consolidating the currently open Dependabot
updates (#290–#294), including paired Vitest/coverage and Electron changes.
Dependency updates remain a separate reviewable commit with exact versions,
upstream compatibility notes, notices, and native verification. Bot PRs are not
closed until their updates are included and validated. No unrelated PR is merged.

## Verification policy

1. Reproduce faults using production imports and the cheapest valid test layer.
2. Preserve durable outcomes, exact identities, ownership locks, bounded disposal,
   coverage thresholds, package signatures/fuses/checksums/provenance, and native
   worker limits. Failure followed by a retry is still an intermittent failure.
3. Compare against current main again before final integration, and validate the
   final combined SHA; an earlier head's green checks are not candidate evidence.
4. Separate deterministic provider fixtures and real transports from authenticated
   upstream turns. Missing credentials mean **not exercised**.
5. Test packaged candidates in disposable profiles. The user's running desktop
   and original profile remain untouched.

## Removal and test-proof ledger

No production feature, migration, compatibility fixture, or test is retired at
baseline. Each subsequent removal must name its consumers, preserved owner,
failure invariant, execution layer, and relevant platform. Source-format tests
may be replaced with behavioral/structural contracts, never merely deleted.

## Final evidence

Implementation and integrated verification are in progress. This document does
not currently claim a green candidate, an installed upgrade, authenticated live
provider compatibility, or release readiness.
