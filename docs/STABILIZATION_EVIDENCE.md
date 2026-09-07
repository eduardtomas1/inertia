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
- Release observed at start: v0.0.52. Main subsequently advanced through the
  separately owned release #302 and Intel Mac certification budget #303 to
  `27bbc985a97d9e1857c33ce1585feae597d75ead`. Both changes are integrated:
  package/lock version 0.0.53 and the existing 70-minute Intel Mac job budget
  are preserved. This branch does not create a version bump or publish a release.
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
| R1 terminal truth | Three real controller/SQLite regressions reproduced completed storage with failed memory/projections and contradictory terminal events after a synchronous hook failure. | Separate mandatory commitment from independently reported effects; atomically commit terminal row and stored conversation/workspace projections. |
| CI duplication | Critical sentinels/core coverage overlap full certification. | Explainable, mutually exclusive equivalent coverage, trusted main baseline and fail-closed aggregate; see `CI_EVIDENCE.md`. |
| Test scheduling | Primary-display classification uses a literal string and top-level discovery. | Explicit first-line resources, recursive discovery, exact portable paths and a fixture-entry resource guard. |
| Script duplication | `check` and `check:platform` repeat Private Connect type/build work. | Composition now owns each responsibility once; standalone command preserved. |
| Discovery benchmark | Audit's “discovery disabled” conclusion is incomplete: package-smoke executable setting enables it on current main. | Controlled installed cold/warm, unavailable and slow Codex scenarios pass through actual Electron; see transport/dependency ledger for scope. |
| Production dependencies | Current baseline audit reports zero advisories. | No speculative security defect claimed. |
| Recovery worker boundary | A real Node worker posting `null` causes an uncaught client TypeError. | Versioned, bounded exact-operation receipts; invalid receipt rejection waits for writer exit, including failed termination requests. |
| Release SBOM root | Four existing release-assets tests fail when npm uses the checkout directory as the component display name. | Normalize only that verified mismatch after matching manifest, lock root, version, bom-ref and purl; graph identity remains unchanged. |
| Codex steering receipt | An RPC success without the exact active turn receipt was accepted as steering. | Capture and match the turn identity; reject missing, malformed, foreign or whitespace-altered receipts, while preserving a valid receipt batched with completion. |
| Cold provider discovery | Metadata/control/Claude skills fallback detection omitted the requested workspace; a late wrong-context probe could replace a valid readiness projection. | All three callers retain workspace context; six real-child production-manager regressions exercise the late-result ordering. |
| Cursor interaction authority | Question responses used the wrong envelope; supervised plan creation implicitly approved a potential file write. | Correct nested replies; reuse one-shot file approval with exact run/session ownership and cancellation. |
| ACP media final read | Kimi/Cursor allocated image paths before enforcing bounds and lacked descriptor/cancellation checks. | Extract Gemini's existing descriptor-bound reader and reuse it with unchanged shared media budgets. |
| Kimi released authentication | Actual 0.41.0 initialize advertises terminal authentication, previously rejected even for an already signed-in installation. | Validated login-only descriptor, explicit Connect through the existing owned PTY, fresh initialization and session authority; no automatic login or prompt replay. |
| Sign-in terminal lifecycle | Early exit could arrive before the created receipt; signalled zero-code exits looked successful. | Bounded attempt-owned buffering, exact receipt correlation, synchronous cancellation and signal-aware exit reporting. |
| Browser preview suggestion | Optional page context had no dismissal control. | Separate keyboard-accessible dismiss/remove button, per-conversation/URL state, outgoing-context and detachment ownership regressions. |
| Composer duplicate work | Command descriptions, disabled-state checks and menu option rendering were duplicated. | Derive command state only when a slash query exists and render one shared native option; 94 focused DOM tests preserve keyboard and selection behavior. |

The initial complete `npm run check` stopped at the four SBOM assertions:
7,137 tests passed, 77 skipped, four failed; 169.34 seconds wall time. It did
not reach the bundle step. The isolated release fix subsequently passed all
32 root/asset tests. These are baseline failures repaired here, not discarded
assertions or a renamed checkout used to hide them.

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

| Removed responsibility/fragility | Preserved owner and proof | Layer/platform |
| --- | --- | --- |
| Broad catch spanning terminal persistence and arbitrary callbacks | Atomic store settlement plus post-commit effects, real failure/rollback/restart tests | Real SQLite/controller; all supported OS unit lanes |
| One-hop private settings initializer | Same constructor call to the existing settings repository | Existing initialization/recovery tests; no schema edit |
| Duplicated composed Private Connect verification/build | Quality owns typecheck; bundle owns build; standalone command still does both | Expanded npm lifecycle graph test and actual bundle |
| Implicit top-level, source-string E2E classification | Every scenario declares its resource; recursive assignment plus runtime fixture guard | Pure path/assignment tests and real Electron projects |
| Vitest 4 `describe.sequential` spelling | Vitest 5 `{ concurrent: false }`; same provider assertions and worker limits | Portable suites, DOM suite and native CI |
| Assumed TypeScript-only recovery worker message | Runtime schema with exact operation receipt and confirmed thread disposal | Real Node workers plus export/recovery integration |

No test scenario was retired. Before the four new core journeys, actual
Playwright discovery preserved all 96 existing project/file/title assignments
exactly once. The strengthened core journey retains the original cancellation,
runtime recycle and zero-provider-owner checks, adds a subsequent send, and
adds Git/non-Git first/second sends with restart/history and approve/deny paths.
All five core scenarios passed in a separate Electron 44.2.0 instance; they
use synthetic provider transport and do not certify authenticated upstreams.

The resource policy and build/SBOM diff received an independent agent review.
It found an adversarial POSIX filename containing a literal backslash could
alias a nested Windows-normalized path; discovery now rejects that ambiguity
with a collision regression. No current repository scenario had that name.

## Boundary and state inventory

Transport-specific receipt/disposal and dependency details are in
`STABILIZATION_TRANSPORT_DEPENDENCIES.md`. Existing Electron `event.data`
adapters and exact-operation result acknowledgements are preserved, not
replaced with a generic wrapper. Read-only backup validation and import writers
retain distinct cancellation authority. No journal/schema repair is duplicated.

The runtime WebSocket boundary still validates origins and command payloads,
caps clients/in-flight commands, and assigns detached-chat authority to its
exact conversation. `RuntimeSyncHub`, runtime sequencing and
`useInertiaConnection` retain replay/reconciliation ownership; this PR does
not automatically resend ambiguous mutations. Renderer draft preparation and
pane identity remain owned by `useDraftConversation` and
`useConversationPaneLayout`, with existing draft/split/detached/reconnect
regressions retained. No renderer production rewrite or memoization was needed.

The provider drift workflow was inspected and remains a secret-free scheduled
canary, not authenticated end-to-end proof. Existing Windows duration sharding,
native worker limits, immutable migration lineage and all coverage thresholds
remain unchanged. Installed update trust and #295/#297/#299 behavior are
preserved; no claim is made that synthetic fixtures repair an old published
binary's updater in place.

## Measured local checks

The baseline standalone duplicate Private Connect work took 1.76 seconds on
this host. Removing its composed duplicate is a small known cost reduction,
not the primary CI speedup. Hosted before/after queue/critical-path savings
remain unmeasured until the final candidate runs.

Existing data-throughput and renderer-primitives benchmarks pass unchanged:
512 × 512-byte SQLite stream: full-copy 49.8 ms / 69.62 MiB WAL versus append
7.7 ms / 7.19 MiB WAL; PDF bounded-two pressure retained 18.49 MiB versus
42.89 MiB for unbounded-eight; reused-collator median 20.87 ms versus
343.54 ms per-comparison setup. These are validation of existing optimizations,
not improvements introduced by this PR, and ran on a shared, contended host.

Candidate lock SHA-256 after integration of current main:
`d3b578802ed7da8043058be6f0aab22c3259566c2600efc11300456c7c2e66bf`.
Dependency integration uses Electron 44.2.0 and paired Vitest/coverage 5.0.0.

## Provider and composer verification

Detailed per-provider ownership, primary sources, failures-before fixes and
remaining limits are recorded in `STABILIZATION_PROVIDERS_CODEX.md`,
`STABILIZATION_PROVIDERS_CLAUDE_OPENCODE.md`,
`STABILIZATION_PROVIDERS_CURSOR.md`, and
`STABILIZATION_PROVIDERS_GEMINI_KIMI.md`. Codex and Claude remain the primary
daily-workflow priorities; their review includes subsequent sends, accepted
follow-ups, permissions, cancellation, compaction and persisted session identity.
The installed Claude SDK transport test uses the real pinned SDK with synthetic
bidirectional streams, not an authenticated CLI or live model.

The integrated provider gate passed 1,205 tests with two platform skips across
77 files. Four additional native malformed-Kimi-wire regressions passed against
the unchanged strict policy. An apparent public SDK schema-coercion concern was
disproved through the actual client transport; no redundant parser was added.

The Kimi Electron journey passed in 20.5 seconds: existing Connect UI, a real
login-only PTY, fresh ACP initialization, two completed sends, restart/history
and a third completed send. It asserts zero remaining provider owners and exact
fixture process termination. Authentication is synthetic, not a real account.
The first attempt exposed a test locator error (completion text is not a status
role), corrected without changing production behavior or timeouts.

The composer/sign-in DOM regression aggregate passed 109 tests. Preview cases
cover keyboard dismissal, selected-context removal from the actual send,
detachment unblock, pane/conversation isolation and navigation to a previously
dismissed URL. The current-main workflow integration passed 86 focused tests.

The first integrated bundle gate detected a small first-load/core size
regression. Simplifying duplicated command rendering resolved it without
changing thresholds, minification, chunk classification or dependencies:
workbench 733.0 → 732.6 KiB (limit 733), core 1,971.5 → 1,970.9 KiB
(limit 1,971). All bundle budgets pass; 94 focused DOM tests, web TypeScript
and React lint pass for that simplification.

The final secret-free six-provider canary at `3700d42e` passed all 16 checks:
Codex 0.153.4, Claude CLI 2.1.263, Gemini 0.58.0, Kimi 0.41.0, OpenCode
1.18.29 and supplied official Cursor 2026.09.02-c22c1a3. Latest SDK checks
passed with ACP 1.4.0, Claude Agent 0.3.263, Anthropic 0.124.0, MCP 1.30.0
and OpenCode 1.18.29. These canary versions are not replacements for the
pinned application dependency graph. This is Linux type/runtime/help/schema/
initialize and plugin-isolation evidence, not authenticated turns or native
Windows/macOS certification.

The complete candidate coverage attempt passed 7,414 tests with 77 skips,
but failed the same four runtime-summary readiness tests observed on the
baseline. It is not a green result; their cause is being investigated rather
than waived as pre-existing. Baseline/candidate totals, with unchanged
thresholds, are:

| Metric | Baseline | Candidate attempt |
| --- | --- | --- |
| Statements | 64,041 / 79,887 (80.16%) | 64,386 / 80,187 (80.29%) |
| Branches | 52,222 / 69,509 (75.12%) | 52,420 / 69,708 (75.19%) |
| Functions | 12,660 / 15,524 (81.55%) | 12,739 / 15,592 (81.70%) |
| Lines | 59,559 / 71,676 (83.09%) | 59,838 / 71,912 (83.21%) |

Final combined check, coverage, desktop and package verification remain
pending. Antigravity's separately distributed official ACP runtime was
investigated, including a credential-free native initialize. Its published
adapter has an independently reproduced terminal-failure ambiguity; no
Antigravity route or migration is implemented or claimed. See
`STABILIZATION_PROVIDERS_ANTIGRAVITY.md`. Existing Gemini API-key/enterprise
history remains unchanged.

## Final evidence

Implementation and integrated verification are in progress. This document does
not currently claim a green candidate, an installed upgrade, authenticated live
provider compatibility, or release readiness.
