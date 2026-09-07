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
| Runtime fixture discovery | Fake Codex shared discovery with unrelated installed host CLIs, making readiness depend on their probe durations. | A private slow-CLI reproduction fails at the original six-second deadline; fixture-owned discovery candidates and credential-free profiles pass without changing production deadlines. |

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

The earlier complete candidate coverage attempt passed 7,414 tests with 77 skips,
but failed the same four runtime-summary readiness tests observed on the
baseline. It was not a green result; the cause and correction are recorded
below, not waived as pre-existing. Baseline/candidate totals, with unchanged
thresholds, are:

| Metric | Baseline | Candidate attempt |
| --- | --- | --- |
| Statements | 64,041 / 79,887 (80.16%) | 64,386 / 80,187 (80.29%) |
| Branches | 52,222 / 69,509 (75.12%) | 52,420 / 69,708 (75.19%) |
| Functions | 12,660 / 15,524 (81.55%) | 12,739 / 15,592 (81.70%) |
| Lines | 59,559 / 71,676 (83.09%) | 59,838 / 71,912 (83.21%) |

The final coverage run at `0c8a0123` passed **7,419 tests, 77 skips**, across
702 passing and eight skipped files, in 728.05 seconds. The preceding baseline
coverage run had 7,133 passes, eight failures (four SBOM and four readiness)
and 77 skips; it was not a green baseline. Baseline Vitest 4.1.11 and candidate
Vitest 5.0.0 are different instrumenter versions. All original thresholds pass.

The runtime readiness issue also reproduced without coverage: two valid
3.5-second probes of a private unrelated CLI left all providers checking past
the fixture's six-second deadline. Discovery publishes the aggregate result.
The fixture now controls both child profiles/credentials and its complete
candidate-path set; changing PATH alone would still admit fallback roots.
The 24 runtime tests passed under V8 instrumentation before the full run.

Final covered/total denominators, including every configured area threshold:

| Scope | Statements: baseline → candidate | Branches: baseline → candidate | Functions: baseline → candidate | Lines: baseline → candidate |
| --- | --- | --- | --- | --- |
| All source | 64041/79887 → 64412/80186 | 52222/69509 → 52428/69704 | 12660/15524 → 12731/15587 | 59559/71676 → 59868/71910 |
| Main | 13166/17276 → 13161/17276 | 9868/13599 → 9857/13599 | 2163/2767 → 2163/2767 | 12357/15519 → 12353/15519 |
| Node | 3215/3892 → 3215/3892 | 3388/4144 → 3388/4144 | 525/570 → 525/570 | 3005/3452 → 3005/3452 |
| Preload | 98/208 → 98/208 | 18/36 → 18/36 | 47/132 → 47/132 | 90/182 → 90/182 |
| Renderer | 15038/19430 → 15065/19464 | 13218/18318 → 13220/18352 | 3524/4880 → 3523/4876 | 13629/16927 → 13652/16951 |
| Server | 29907/35739 → 30257/36005 | 22629/29534 → 22844/29695 | 5811/6497 → 5883/6564 | 28087/32614 → 28378/32825 |
| Shared | 2617/3342 → 2616/3341 | 3101/3878 → 3101/3878 | 590/678 → 590/678 | 2391/2982 → 2390/2981 |
| `src/shared/private-connect/*.ts` | 603/626 → 603/626 | 431/473 → 431/473 | 97/98 → 97/98 | 542/550 → 542/550 |
| `src/server/private-connect/*.ts` | 287/411 → 287/411 | 197/325 → 197/325 | 69/93 → 69/93 | 268/366 → 268/366 |
| `src/main/private-connect/*.ts` | 1172/1631 → 1167/1631 | 797/1152 → 786/1152 | 226/301 → 226/301 | 1078/1392 → 1074/1392 |
| `src/{main,server/runtime}/secure-file*.ts` | 953/1164 → 953/1164 | 698/890 → 698/890 | 146/174 → 146/174 | 910/1064 → 910/1064 |
| `src/main/credential-vault.ts` | 240/346 → 240/346 | 154/226 → 154/226 | 39/63 → 39/63 | 229/309 → 229/309 |

Global percentages are 80.32% statements, 75.21% branches, 81.67% functions,
83.25% lines. This is not a claim that every area increased: main-process and
renderer branch percentages declined slightly. The main difference is confined
to byte-identical `tailscale-command.ts` (statements 91/101 → 86/101, branches
80/101 → 69/101); summaries alone do not establish the cause. No assertion,
threshold or reported source file was removed to improve these numbers.

The report contains 956 files versus 946: nine new server modules and the
already-existing `src/renderer/private-connect/vite.config.ts`, newly reported
with zero denominators. The latter is an instrumenter report-set difference,
not an added production module. The nine additions are recovery-worker protocol,
terminal projection, ACP terminal-auth policy, auth launch, Kimi auth probe,
bounded image reader, settled orchestration, settlement effects and settlement
tasks. Existing responsibilities and their proof mappings remain above.

Final quality (all five TypeScript configurations, both lint modes, architecture
and migration checks), actionlint, Windows-Codex Linux contracts (four passes,
four native skips), Linux packaging contracts (nine passes), enforced browser
CPU checks (three passes) and enforced platform benchmark (two passes) passed.
All three fixed lifecycle repetitions passed 166 tests each. Concurrent host
work means these durations are validation observations, not speedup estimates.

A separate clean archived checkout at `0c8a0123` passed the exact minimum-Node
CI contract with verified official Node 22.13.0/npm 10.9.2: fresh-cache/tree
`npm ci --engine-strict` (41 seconds, zero audit findings), then
`npm run check:node-runtime`. The latter compiled all five TypeScript projects
and executed built runtime CLI readiness/help/error cases. Lock identity was
unchanged; no installed dependency tree was reused.

The literal `npm run check` at `0c8a0123` passed all quality gates, 7,419 tests
with 77 skips, and the complete build with all unchanged bundle budgets.
The full native Linux Electron run passed 97 scenarios, with four existing
macOS-only skips and no failures or retries: 33 display-sensitive, 60 isolated,
and four runtime-recovery passes. All 101 assignments across 58 spec files
were retained. The native run used private profiles, a private virtual display
and synthetic providers; the user's app/profile were untouched.

The native run's entire output inventory was identical before and after its
three phases. Main, preload, runtime and desktop renderer bytes still match
the subsequent full build. The PWA difference was traced to the existing asset
unit test: it invoked the real builder with repository cwd and inherited
`NODE_ENV=test`, overwriting the shared PWA output with a development bundle.
A supplementary browser bootstrap crossed that rewrite and timed out waiting
for the previous asset; that failed attempt is not passed evidence. The asset
fixture now builds copied inputs in a disposable directory, retaining all
assertions and its existing framework deadline, and leaving shared output
byte-identical. Private dependency junctions keep Vite's temporary writes local.

The rebuilt Private Connect desktop scenario separately passed in 15.7 seconds.
An actual browser bootstrap from a frozen copy then loaded the production PWA,
rendered its expected offline screen, and produced no uncaught errors or
external requests. The loaded 309,114-byte module has SHA-256
`9609a2fb4b828dbfe7a713531fcc975faa386630de384110dc3e8335b284342c`;
all seven frozen PWA files match the independent clean Node 22 build. All 207
shared output files stayed unchanged during those successful checks. Earlier
scratch diagnostics relying on network silence or headed screenshot capture
did not complete and are not passed evidence. This proves unauthenticated
bootstrap, not pairing, Tailscale or an authenticated remote session.

After the clean-packaging correction, the literal `npm run check` at `60671dea`
also passed: 7,459 tests, 77 skips, 704 passing and eight skipped files,
201.28 seconds for the tests, all quality gates and all bundle budgets. The
additional 40 tests exercise runtime preparation and packaged legal resources.
Production `src/` is unchanged from the fully covered `0c8a0123` revision;
the coverage result above is bound to that revision, not renamed as a new run.
The final fixture-isolated revision `b9789e1f` then passed another literal
`npm run check`: the same 7,459 passes and 77 skips in 188.67 seconds, all
quality gates and all bundle budgets. All 207 rebuilt output files match the
successful frozen-output desktop/PWA verification exactly.

Antigravity's separately distributed official ACP runtime was
investigated, including a credential-free native initialize. Its published
adapter has an independently reproduced terminal-failure ambiguity; no
Antigravity route or migration is implemented or claimed. See
`STABILIZATION_PROVIDERS_ANTIGRAVITY.md`. Existing Gemini API-key/enterprise
history remains unchanged.

## Clean packaging regression

A clean minimum-Node checkout exposed a real Electron 44.2.0 packaging change:
its npm package no longer installs the development runtime through postinstall.
`require("electron")` lazily downloads it, but building and packaging without
an earlier Electron launch does not invoke that path. Electron-builder exited
successfully while warning that the two declared Electron/Chromium legal
resource copies were absent. The incomplete artifact was retained as failed
evidence, not accepted as a successful package.

Packaging now explicitly runs the official installed Electron installer as a
bounded, supervised child under the existing guardian build lock. Its exact
platform/version receipt, executable and required legal files must exist before
the builder is admitted. Redirected distributions and checksum/version overrides
are rejected; ordinary cache, mirror and proxy settings remain supported with
the package's embedded checksums. Abort and unconfirmed process-tree cleanup
retain their existing lock/quarantine authority; no unbounded lazy installer or
automatic damaged-cache deletion is introduced.

The artifact-only package smoke also validates all four declared legal resources
before native launch, with bounded regular-file reads and content checks. It
does not compare historical installed packages against the current checkout's
dependencies. Reported hashes identify the actual artifact bytes, not a new
source-authenticity attestation. The corrected command was then verified in a
new archived checkout at `60671deaeafaec8401ee0c36f4dcf4d1b4161312`, using
official Node 22.13.0/npm 10.9.2, a fresh installed tree and private profiles.
Only the npm download cache was reused. Electron `dist` and `path.txt` were
confirmed absent immediately before normal `npm run package:linux`; no manual
installer or lazy Electron import preceded it. Install, build and packaging
passed, all four legal resources matched their exact source/generated bytes,
and the two previous missing-source warnings were absent.

The resulting local `Inertia-0.0.53.AppImage` is 359,692,677 bytes, SHA-256
`7c64fbef00fa51ed989c8212ec84c39fb5ad395ce30f25bb5b38c26112263088`.
Linux package validation, all nine Electron fuse checks in unpacked and
extracted forms, and all nine Linux packaging tests passed. Native unpacked
fixture and normal FUSE/AppRun launches proved runtime readiness, real PDF
extraction, image retention and orderly shutdown. The complete unchanged
release-container smoke passed, including:

- normal mount/AppRun launch;
- installed update with real candidate bootstrap, old-owner shutdown, atomic
  replacement, retained history/settings/provider sessions, new synthetic turns
  and fresh relaunch;
- guardian-sealed AppImage descriptor-chain launch;
- extract-and-run fallback.

Every recorded test main/runtime PID was absent after cleanup; owned process
groups could no longer execute, and the packaging agent's private virtual
display was stopped. The later `b9789e1f` change only isolates the asset test;
it does not change product or build inputs for this artifact.

Important limitation: the default unpacked launch without a sandbox override
failed on this host because user namespaces are unavailable and the helper is
user-owned mode 0755. That failure is retained. No system permissions or security
settings were changed. The distinct existing unpacked fixture uses its explicit
no-sandbox mode; the normal AppImage uses the inherited AppRun automatic
fallback. The release-container fixture also uses its existing bypass. These
passes are **not sandbox-enabled proof**. This local artifact has manual updater
capability, no signing credentials or provenance attestation; the native
installed-update fixture does not certify a signed public release.

## First hosted run and fixture corrections

The first exact-head hosted run, [34115813008](https://github.com/eduardtomas1/inertia/actions/runs/34115813008),
tested `97e0a7eead59ff0e80e824483013f96c864b6a8f`. It exposed platform-specific
mistakes in the new tests; it is not green evidence:

- Both macOS architectures failed six literal temporary-path comparisons.
  macOS exposes its temporary directory through `/var`, while the installer
  and child process correctly use canonical `/private/var` paths. Fixtures now
  canonicalize their roots. An explicit parent-alias regression still checks
  the exact installer invocation rather than weakening path equality.
- Both macOS architectures also rejected the new forked Kimi discovery fixture.
  The existing strict guardian intentionally retains uncertainty after
  `NOTE_FORK`: stopped known children do not prove that all descendants were
  identified. The test now requires a typed cleanup failure, stopped known
  fixture processes, a retained generation claim and tainted ownership on
  macOS. Linux and Windows must still confirm descendant cleanup before
  returning a descriptor. A separate no-fork case requires real owned-guardian
  cleanup on every platform. No guardian policy or deadline was relaxed.
- Windows x64 unit shard 3 and Windows ARM64's portable suite rejected two
  raw-child early-exit fixtures with the typed unconfirmed-cleanup error.
  ACP EOF can precede the child-close event; a strict `taskkill` attempt can
  then encounter an already exited root. Those two tests now permit that
  fail-closed result only on Windows, assert exact sanitized errors, require
  the captured fixture PID to be stopped, and reject any authentication result
  or request beyond `initialize`. Active and malformed-protocol cases retain
  their stronger cleanup expectations; the injected unconfirmed-cleanup case
  still requires a typed failure. No production cleanup behavior changed.

The two corrected files passed 55 focused tests locally. The complete local
`npm run check` then passed 7,461 tests with 77 existing skips, all 704 active
test files, every quality gate and unchanged bundle budgets. The test phase
took 94.45 seconds. This Linux result does not substitute for the next hosted
Windows/macOS run. The independent portable suite also passed: 1,210 tests,
two existing skips, all 77 files, 147.34 seconds.

## Natural terminal exit and asynchronous ownership retirement

The next hosted run, [34118357458](https://github.com/eduardtomas1/inertia/actions/runs/34118357458),
tested `8697b317cdace664f21cb0978fbf6d53baad59a9`. The corrected unit and
portable expectations passed on all platforms. Both Linux and Windows native
lanes and all four Windows unit shards passed. macOS ARM64 progressed through
unit, packaging and display-sensitive tests, then failed the new native Kimi
terminal-login scenario. Its trace identifies the first failure as the missing
`Connection flow complete` state, before any turn or restart. A later forced
fixture-close error replaced that assertion in the console summary. The saved
trace does not expose enough ownership data to establish its exact native
interleaving; it must not be presented as conclusive root-cause evidence.
The completed Intel macOS lane reproduced that Kimi failure and also rejected
cleanup after `window-health-recovery`. Its trace proves all four health
assertions, screenshot and restoration of the injected methods succeeded;
the failure occurred only in the shared fixture's teardown. The same health
test passed on ARM64. Neither retained artifact identifies the responsible
detached process claim. This second failure is not attributed to the terminal
sign-in race or declared fixed without evidence.

Investigation did independently reproduce a real product race: normal PTY exit
can precede asynchronous retirement of its exact durable guardian claim. The
terminal manager treated a synchronous `confirmStopped() === false` as final
failure, even though the registry was still completing its admission/retirement
promise. A composed regression uses the production Darwin registry, private
journal and terminal manager, with only native identity observations and signals
substituted. It fails before the fix and proves the durable claim is removed
before installation release and terminal completion afterward.

Natural sign-in exit now uses tracked disposal and the existing close deadline
to await that exact proof. It never signals the exited PID, releases installation
authority exactly once, and publishes completion only afterward. Close,
replacement or shutdown during this wait changes completion to cancellation;
shutdown can tighten but cannot renew the deadline. Expiry, rejected proof or
failed installation retirement still quarantine the session and block success.
Late proof and duplicate exits cannot revive it. Existing deadline helpers were
extracted without changing their logic; no guardian policy, timeout, retry,
coverage threshold or source-size budget was weakened.

The E2E scenario now closes its fixture in a separate teardown hook, preserving
the first assertion alongside any cleanup failure. On failure it attaches only
synthetic invocation metadata and RPC method names, never provider credentials
or prompt bodies. Its login, three sends, restart, exact process retirement and
durable ownership assertions remain intact.

Local validation of the new product code:

- 74 focused terminal tests, including 18 sign-in lifecycle cases, passed.
- `npm run check` passed 7,471 tests, 77 existing skips and all 704 active files,
  with every quality gate and unchanged bundle budgets.
- `npm run test:portable` passed 1,220 tests, two existing skips and all 77 files.
- All-source coverage passed the same 7,471 tests: statements 80.33%, branches
  75.21%, functions 81.67%, lines 83.25%, against unchanged thresholds.
- The separately rerun final quality gate passed all lint, architecture and
  TypeScript checks after the focused test assertions were finalized.
- The actual rebuilt Linux Electron app passed native Kimi login, two sends,
  restart, a third send, zero remaining owners and clean shutdown (34.4 seconds).
  The full isolated desktop suite then passed 60 tests with four existing
  platform skips (2.8 minutes). These used synthetic providers, private profiles
  and a private virtual display; the user's live app and profile were untouched.

The complete `npm run check` was also repeated after all focused assertions
were frozen: the same 7,471 tests and every gate passed, with a 108.15-second
test phase.

A fresh local AppImage containing the terminal change was then produced from
`085ef553a09f01302a9b9de1890206b7b69e6016`: 359,692,635 bytes, SHA-256
`8230c17be1e1d9822392aaeec35d9e52155d2590e8c63419441391ab91d28d0a`.
All 207 frozen build files exactly matched its archive; all 11 native binaries
had the expected architecture; static Linux package checks and both nine-fuse
checks passed. Existing package-smoke tests passed on their first attempts for
normal FUSE/AppRun, guardian-sealed descriptor handoff and retained-wrapper
extraction. Each proved runtime readiness, PDF extraction, image retention and
complete cleanup; all six recorded main/runtime PIDs were absent afterward.

This used the reviewed installed dependencies and frozen output, not a new
cold installation. The packaging command's tool response did not retain its
numeric exit receipt; completed artifacts, the build log and independent
successful static/native checks are recorded instead. One incorrectly rooted
validator invocation never started the validator; its correctly rooted run
passed. The inherited AppRun fallback and explicit extraction-fixture bypass
mean these results are not sandbox-enabled proof on this host. No installed
application, user profile, public release or tag was changed. The earlier
installed-update result remains tied to its earlier recorded source revision;
this package smoke does not certify authenticated Kimi or native macOS.

Fresh hosted macOS results are still required; local Linux execution and the
composed Darwin regression do not substitute for native macOS proof.

To preserve evidence if the separate Intel cleanup failure recurs, shared
Electron fixture teardown now captures the existing allowlisted, digest-checked
runtime record projection before deleting its private profile, only after a
cleanup failure. Reads/reporting are bounded and abortable. No raw log, prompt,
credential, authenticated endpoint or filesystem error is published. Reporting
failure cannot replace the original cleanup error or prevent directory removal.
Nine regressions cover failure-only ordering, reporting throw/rejection/hang,
late rejection, removal failure, sanitized real records and cancelled capture;
the focused support suite passed 69 tests with three existing platform skips.
This adds diagnostic evidence, not a claimed fix for the unidentified detached
claim in that Intel run.

The combined final `npm run check` passed 7,480 tests, 77 existing skips and
705 active test files, followed by all build and bundle gates. Its test phase
took 100.39 seconds. Product bytes are unchanged from the freshly verified
`085ef553` AppImage; the additional nine tests exercise failure reporting only.
The final real Linux Electron pass also succeeded for all three Kimi-login/
restart and window-health scenarios with the updated fixture support
(20.6 seconds), including clean teardown.

## Review correction: native Electron verifier classification

The external review correctly identified a regression exposed by narrowing
the old `renderer_ui` full-certification rule. A ready PR changing only
`tests/e2e/support/electron-app-lifecycle.ts` produced a Linux-only plan. Its
Windows/macOS cleanup branches would no longer receive native evidence.
Four new focused regression cases failed before the correction.

The same generic rule also misclassified native scenarios, not just helpers:
`runtime-live-recovery.spec.ts` skips every changed assertion outside macOS.
The coherent correction therefore keeps all `tests/e2e/` native verifier
changes in the existing broad infrastructure branch before renderer matching.
Renderer source and renderer DOM tests retain the lighter Linux policy. No
filename exception list or new ownership domain was added.

Regressions assert the exact six platform identities, every required native
check and all four Windows shards for a helper-only or OS-only-test ready PR.
The evidence gate rejects each individually missing native check even when its
aggregate job result claims success. Nested helpers and normalized Windows
paths are covered. All 44 classifier/planner tests passed; final `npm run check`
then passed 7,487 tests, 77 existing skips and 705 active files, every quality
gate and unchanged bundle budgets (104.82-second test phase). No application
or package bytes changed; fresh exact-head CI remains required.

The owner also explicitly authorized main protection. REST and GraphQL confirm
required PRs, strict current-base evidence, app-bound `merge-ready`, administrator
enforcement, resolved conversations and disabled force pushes/deletion. No
second-maintainer approval quota or bypass was added. Main's commit is unchanged.
See `docs/CI_EVIDENCE.md` for the exact administrative policy and its distinction
from the workflow implementation.

## Final evidence

Local Linux results above include a real isolated installed-update fixture;
hosted exact-head certification is still separate and pending. No authenticated
upstream provider compatibility, native Windows/macOS result, public release
readiness or in-place repair of the user's running installation is claimed.
