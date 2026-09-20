# Inertia correctness audit — 20 September 2026

## Scope and baseline

This audit started from a clean worktree at freshly fetched `origin/main`,
`d56f972b32fadfa29169bb8390401f5ca49e419b`, on `codex/full-correctness-audit`.
Node 22.23.2 and `npm ci` installed the reviewed lockfile without dependency
changes. The original Desktop checkout and sibling worktrees were not modified.
No release, version change, tag, merge, dependency update, CI-speed optimization,
or broad source cleanup belongs to this work.

The inventory contains **1,208 source/assets files**: main 172, node 45,
preload 6, renderer 441, server 441, shared 103; also 1,099 test/support/fixture
files, 101 scripts, 11 GitHub configuration/workflow files, and two benchmarks.
Those are inventory counts, **not a claim that every line received equal manual
review**. Review followed complete product paths across process boundaries,
with deep reads and adversarial tests at authority, lifetime, cancellation,
and publication boundaries. Broad architecture/type/lint/test/build gates
complement the manual reviews. Passing tests do not prove absence of defects.

Historical CI/dead-code/package-size PDFs were not audit instructions or required
inputs; the coordinator explicitly made them optional background for this fresh
code audit. Sibling tasks own those changes. The icon worktree was reviewed
read-only; its additional finding was reported to the coordinator, who owns
that implementation.

## Coverage map

| Domain | Source/process surfaces and paths traced | Evidence and depth |
| --- | --- | --- |
| Native desktop, Windows and restart/update | Electron entry, runtime supervisor and recovery admission, process journals/guardian, Windows Job and ConPTY authority, terminal lifecycle, discovery and launch, installed update receipts, AppImage identity/singleton, window state and notifications | Native reviewer traced lifecycle and platform branches, inspected package/release boundary checks read-only; deterministic failure tests plus exact-baseline Windows/Linux CI evidence. Native report below distinguishes full small-module reads from targeted large-module review. |
| Attachments | Renderer imports/drafts/handoff/preview → main selection/import registry/workers → retained conversation store → runtime resolver/extraction scheduler → provider image/document adapters; PDF/image/spreadsheet/text extraction and cancellation | Attachment reviewer traced ownership, limits, detached capabilities, private generated files, worker cancellation and utility termination. Three reproduced fixes and broad focused tests. |
| Providers and turns | Discovery/auth/model metadata and six supported production routes; custom backend profiles/vault broker; approvals/input/host tools; admission, follow-up, queue, streaming, settlement, resume and restart ownership | Provider reviewer traced every production route, exact-run cleanup and turn persistence linkage. Original admission/readiness fixes plus provider-completion follow-up; portable contracts and live-provider limitations documented. |
| Renderer and performance | Streaming projections/subscriptions/reconnect, transcript virtualization/scroll/focus, drafts/composer ownership, four-pane split and detached windows; workspace files/editor/search, terminal lifecycle, settings and usage | Renderer reviewer plus root review. Reproduced four-pane subscription identity/capacity defect. DOM tests plus native Electron geometry/lifecycle scenarios and a measured desktop benchmark; no unsupported speedup claim. |
| Persistence and recovery | Migration catalog/runner/lineage, SQLite repositories, export/import/backup/quarantine workers, path authority, execution ledger, Duo recovery and WebSocket sequencing | Root and independent persistence reviewer. Transaction/future-schema and worker-exit boundaries checked; reproduced authorized import-root replacement race. Released migrations remain unchanged. |
| Git and workspaces | Project/conversation path identities, source-control authority bindings, bounded shell-free runner, repository discovery/scans, branch/remote/worktree operations, checkpoint/reversal and reviewed commit transactions | Root deep review of reversal/rollback/index ownership and workspace containment; native reviewer examined executable/process settlement. Reproduced newer staged-work rollback loss and added a native Git writer-lock compare/restore. |
| IPC, preload and Private Connect | Main/detached preload surfaces, trusted frame/role checks, Zod command/router coverage, scoped detached capabilities, bounded authenticated WebSockets; pairing/session/grants/Tailscale/HTTP projection and mutation delivery receipts | Root deep review of authenticated dispatch and await boundaries; five stale-read authority scenarios reproduced. Detached attachment IDs remain explicit bearer capabilities; no demonstrated cross-window ID leak. |
| Preview/browser evidence, credentials and diagnostics | Native preview session/input/approval boundary, evidence ownership, credential vault and custom backend broker, privacy filtering and diagnostic export | Independent bounded reviewer checks, plus main/preload boundary and architecture gates. No live credentials used during tests. |
| Build/release/recovery tooling | Reviewed lockfile, Electron Vite/Private Connect build, guardian compiler/integrity, migration lineage, renderer budgets, fuses, package/installer/update smoke, checksum/provenance workflows | Read-only review and relevant gates. No weakened checks or release identity changes. Native head-specific PR checks must distinguish this patch from baseline CI. |

## Root review notes

Deep or complete small-module reads: `src/server/workspace-path-authority.ts`,
`persistence/project-repository.ts`, `persistence/conversation-worktree-repository.ts`,
`persistence/statement-cache.ts`, `persistence/database-family-quarantine.ts`,
`persistence/database-recovery-import-worker-client.ts`, migration runner transaction
and lineage admission, `runtime-protocol.ts`, `runtime/websocket-boundary.ts`,
`runtime/runtime-client-authority.ts`, `runtime/detached-chat-runtime-security.ts`,
`runtime/commands/command-router.ts`, `runtime/secure-file-authorities.ts`,
`runtime/commands/source-control-authority.ts`, all server Private Connect gateway/
input/prompt admission modules, main Private Connect dispatch/authority/persistence
and HTTP/socket response paths, and `private-connect/runtime-response.ts`.

Git deep reads include `git/paths.ts`, `git/reversal.ts`, `git/reversal-files.ts`,
`git/reversal-scope.ts`, `git/reversal-registry-adapter.ts`, `git/commit-index.ts`,
and the index-lock/publication/recovery functions in `git/commit-transaction.ts`,
`git/commits.ts`, and worktree ownership/removal portions of `git/worktrees.ts`.
Workspace reads include traversal/authority boundaries and project deletion,
file read/write and terminal-resume command admission. Main secure-file claim,
transaction support, cleanup and root verification were cross-checked against
these consumers. No destructive Git command ran against user worktrees.

Renderer root reads include `TerminalPanelSession.tsx` subscription/output bounds,
resize/RAF/observer disposal and reconnect ownership, `FileEditorDialog.tsx`, file
browser state/reset paths, `useWorkspaceFiles.ts`, `selectWorkspaceFile.ts`,
`useMessageSearch.ts`, stable-controller/action and lazy-surface hooks, global
shortcuts, conversation selection queue, and usage provenance/date arithmetic.
Thirteen focused renderer tool/lifecycle suites passed 159 tests in 2.73 seconds.
These DOM measurements do not certify real xterm layout or native focus.

Rejected or bounded suspicions:

- Runtime Private Connect prompt receipts do not independently serialize identical
  delivery IDs, but the main service owns a durable receipt and an in-flight map
  before runtime dispatch. No live duplicate-delivery path was established.
- `openAttachmentExternally` does not add a conversation binding to its UUID;
  attachment preview/handoff/store intentionally use opaque bearer capabilities.
  Detached projections omit other conversations and no supported ID leak was
  demonstrated. Adding one isolated owner check would not establish a coherent
  replacement authority model.
- The streaming selector shortcut can ignore a changed selector with the same
  state, but current callers use stable module selectors. It is a latent API
  concern, not a reproduced current product defect; no speculative change made.
- Surface-loader error state does not reset for a different loader, but live
  calls use fixed module loaders and unmount through the error boundary. No live
  loader-replacement failure was established.
- Registered owned worktrees are intentionally retained for manual Git removal
  because Git cannot atomically bind removal to a prior identity inspection.
  The audit did not restore unsafe automatic deletion.
- Migration failure and foreign-key table rebuild boundaries are transactional;
  future-version databases and backups are not silently rewritten. Released
  migrations and fixture lineage remain unchanged.

## Confirmed defects and verification

Twenty-one distinct defects were reproduced and fixed, including ten additional
provider defects from the follow-up user reports. Each domain report records
its failing-before experiment and independent review depth. Tests use synthetic
credentials and disposable repositories/directories; no live provider accounts
or user data were used.

| Defect / user-visible failure | Fix and regression evidence |
| --- | --- |
| Generated attachment storage could follow a replaced root when writing/deleting | Pin initial directory identity and recheck around mutations and every deletion retry; four replacement regressions. `3a37fa2d`. |
| Negative or unsuccessful auth probes could show a provider connected | Negative status takes precedence; positive readiness requires successful exit. Sixteen cases failed before; 37 focused tests pass. `2d6e74c0`. |
| Private Connect async reads could return data after revocation, grant reduction or session replacement | Revalidate current session identity and original grant generation after the runtime await. Five authority-change scenarios; final service suite 36 tests pass. `a1d91fe2`. |
| Synchronous journal errors escaped runtime crash recovery and left lifecycle requests unsettled | Preserve cleanup authority, block replacement and settle through existing failed-recovery path. Three failing-before scenarios, including actual directory removal. `fb4e5e0c`. |
| Provider maintenance refusal before launch could leave a durable turn running forever | Issue an exact no-start receipt only for typed pre-launch installation refusal; unexpected errors remain fail-closed. 37 focused tests pass. `8cadc26f`. |
| Claude image preparation allocated unbounded parallel reads and ignored cancellation | Reuse pinned, bounded sequential image reads with preparation cancellation at initial and follow-up call sites. Four failing-before cases; 61 focused tests pass. `6057801d`. |
| Temporary attachment storage could rebind to a replaced session root | Pin the first root and verify import/read/release/disposal mutations against it; five failing-before cases among six new tests, 81 final focused tests pass. `fdb844ac`, helper placement `434ff843`. |
| Reversal rollback could overwrite newer staged changes | Reserve Git's native index lock; compare expected selected entry and original index identity/bytes; publish a private restored index only with unchanged marker ownership. Preserve newer staged data and foreign locks. Real Git regression and linked-worktree/split-index probes. `9ac12394`. |
| Concurrent cold credential reads could erase a newly saved credential | Share initial load promise and clear it after success/failure, retaining serialized mutations. Lost-save reproduction plus shared-failure/retry regression. `97990fb4`. |
| Recovery import could publish into a replaced destination/staging directory and commit wrong paths | Retain selected-root and staging identity through publication, SQL completion and abort; five authority-swap regressions. Preserve journal when reconciliation is unsafe. `1309d432`. |
| Third/fourth split panes lost subscriptions; reconnect could remap vacant owners | Shared bounded four-owner contract and exact optional owner/ID URL pairs; backward-compatible legacy URLs, detached scope unchanged. Five initial failing cases plus vacant-middle reconnect failure; 112 subscription/integration tests pass. `23893a8d`. |
| Claude could wait indefinitely after an accepted prompt was rejected or an error result arrived with pending follow-ups | Exact root prompt failure ends the persistent Query; final errors precede successful correlation checks. Fifteen new regressions; `b32f9374`. |
| Claude could remain Working after a visible final answer because ambient watchers counted as delegated activity | Exclude SDK-declared ambient activity while preserving foreground delegate and fresh-parent completion requirements. See the completion report below. |
| Codex internally rejected malformed protocol but reported user cancellation | Explicit internal protocol-failure cause, preserving first failure detail and owned cleanup. Ordered malformed/prior-error/input regressions; `71d88a60`. |
| Late cancellation during Codex cleanup overwrote an accepted completed/failed outcome | Snapshot cancellation at terminal acceptance; public harness trusts the cleanup-joined outcome. Public/low-level controls and uncertain-cleanup regressions; `71d88a60`. |
| Quiet Claude messages discarded an armed completion deadline | Preserve one monotonic parent-resume deadline across non-work traffic; actual resumed root work releases it. Fourteen regressions include wall-clock rollback and long resumed work. |
| Cursor/Kimi sent prompts with unconfirmed or subsequently reverted configuration | Validate each requested config-based selection and its retention in the final authoritative response; 28 cases cover both providers and compatible defaults/native modes. |
| Antigravity accepted foreign conversation output | Pin requested/first session identity before text/tool/result projection; eight new foreign-ID and ID-less controls. `eb6e2ba8`. |
| OpenCode accepted foreign session GET responses | Confirm exact resumed/created session identity before prompting; two local-server regressions. `57f40383`. |
| Additional Codex approval/auxiliary protocol rejections still appeared cancelled | Forward explicit failure cause on rejected request paths; seven new malformed/foreign request regressions. `30adcc3c`. |
| Installation evidence refresh disabled controls for healthy admitted runs | Reuse run-scoped capability authority for controls while new launches require fresh evidence; five interactive-provider regressions. `b0a32e65`. |

## Verification ledger

Source and regression changes completed independent review and are open in
[PR #433](https://github.com/eduardtomas1/inertia/pull/433). Required local gates
completed on the original audit source 77745385. The provider-completion
follow-up below records new source and validation separately; earlier native and
performance measurements remain evidence for that original source. Hosted CI
monitoring belongs to the coordinating task; this handoff makes no native
Windows/Linux pass claim for the final patch.

| Check | Recorded result |
| --- | --- |
| `npm ci` with Node 22.23.2 | Passed; lockfile unchanged, zero dependency vulnerabilities reported. |
| Focused Node/Happy DOM domains | See reports below for exact files/counts; overlapping batches are not summed as unique tests. |
| `npm run check:architecture` | Passed after helper extraction: 1,130 source files, 4,256 internal edges. Initial two line-ceiling failures retained as resolved evidence; no ceiling weakened. |
| `npm run test:windows-codex` on macOS | Four tests passed; four native-only tests skipped. This does not establish native Windows behavior. |
| `npm run test:linux-package` on macOS | Two files / nine tests passed; metadata/asset contracts, not actual Linux execution. |
| Streaming render isolation | 200 token events produced 200 transcript/turn renders and zero shell/layout/sidebar/header/scene/chat-workspace/composer renders. Deterministic DOM evidence, not native frame timing. |
| `npm run check` | Passed on final source 77745385: quality/lint/types/lineage/build and 876 test files; 9,414 passed, 146 platform/native skips. Test phase 125.03 seconds. |
| `npm run test:portable` | Passed: 104 files, 1,457 tests; nine native/platform skips, 149.51 seconds. The subsequent renderer trim and shared maximum are covered by the final full gate. |
| Native dependency architecture | Passed on darwin/arm64: Claude binary architecture, SQLite, canvas, accessibility/FFI bindings and bounded PTY probe. |
| Local Electron E2E | Passed: 27/27 scenarios across 13 specs, one worker, 3.4 minutes on macOS ARM64. Exact specs below. |
| Packaged application / fuses / smoke | Passed on macOS ARM64: package-dir, all expected fuse states, runtime guardian, Private Connect assets, manual update fallback, actual PDF extraction and image retention; 1,077 ms launch-to-ready, 294 ms shutdown, clean exit. |
| Native desktop benchmark | Passed, 1.6 minutes on macOS ARM64; five streaming samples, startup/scroll/terminal/split/close cycles and 600-frame soak. Measurements below. |
| Exact-head hosted native CI | Owned by the coordinating task. No final Windows/Linux pass claimed here; historical baseline checks are explicitly separate evidence. |

One early direct-Vitest provider sweep produced four Antigravity failures because
the generated runtime guardian had not been built. Direct Vitest bypasses npm's
pretest prerequisite. This result is retained in the provider report; the normal
first full gate built the guardian and all 9,412 tests passed, including those cases.
That run then failed unchanged renderer bundle ceilings by fewer than 300 bytes.
The scoped reconnect code was simplified in d7a94605/77745385 and independently
reviewed; a fresh bundle check passed. The final full gate then passed on 77745385 with 9,414 tests.
Final measured renderer budgets: main first load 803.0/803.1 KiB, detached first
load 616.4/616.6 KiB, shared core 2,072.6/2,072.7 KiB. No timeout, assertion, architecture ceiling or byte budget was relaxed.

The native scenario batch used the normal Playwright configuration with one
worker and these specs: `authoritative-run-state`, `conversation-split`,
`detached-chat-window`, `git-workflows`, `image-send-regression`,
`attachment-preview`, `checkpoint-recovery`, `database-recovery`,
`document-decoder-isolation`, `private-connect`, `runtime-live-recovery`,
`terminal`, and `runtime-stranded-profile`. All 27 scenarios passed without retries.

The first package attempt omitted the normal generated third-party notices
prerequisite because it started from `check`/`build:bundle`; package smoke
correctly rejected the missing legal resource before launch. Running
`npm run notices:generate`, rebuilding the package, then verifying fuses and
package smoke passed. This was a setup sequencing error, not a bypass or relaxed
check. Generated resources are ignored build output; no dependency or notice
policy changed.

## Provider completion follow-up verification

The earlier completion follow-up used reviewed source `0fd57338`, with Claude prompt-terminal settlement in
`b32f9374`, Codex outcome preservation in `71d88a60`, and all-six restart/UI
regressions in `d7848c0c`. Documentation follows these source commits.

| Check | Result on earlier completion-follow-up source |
| --- | --- |
| `npm run check` | Passed: 881 test files, 9,503 tests, 146 platform/native skips; test phase 122.51 seconds. Quality, lint, types, migration lineage, build and unchanged renderer budgets all passed. |
| `npm run test:portable` | Passed: 108 files, 1,530 tests, nine native/platform skips; 153.04 seconds. The final discovery-marker correction below adds the separately verified 16-case Codex suite. |
| Focused provider/shared/renderer checks | Claude 103 tests, Codex 106, shared SQLite/controller/restart/UI 52, independent renderer 67; overlapping batches are not summed. See the follow-up report for exact scope. |
| Native/package/performance scope | The earlier macOS measurements below precede this provider follow-up. No new native Windows/Linux or live account result is claimed. Hosted CI and the separately tracked Linux teardown investigation remain with the coordinating task. |

Local logs: `local-log:inertia-provider-followup-check.log` and
`local-log:inertia-provider-followup-portable.log`. All 89 newly added provider
completion/restart/UI cases are included in the full gate; required portable
annotations are present on all five new test files. A final manifest audit found
that the new 16-case Codex outcome suite lacked its portable marker. Adding the
comment-only marker expands discovery from 108 to 109 files; manifest verification
and a separate single-worker run passed all 16 cases. The aggregate portable
command was not repeated after this test-metadata-only correction; all cases had
also passed the full gate. Log: `local-log:inertia-provider-followup-portable-codex.log`.
No gate or threshold changed. The final aggregate run below includes the marker
correction and supersedes that earlier portable sequencing limitation.

## Final provider capability verification

Final reviewed source is `a3bb31ca`. The final pass covers all six production
routes and the 28 manifest capabilities, with six more reproduced defects and
65 additional regression/control cases since the earlier completion follow-up.
The [capability report](2026-09-20-correctness/final-provider-capabilities.md)
records scope, exact unsupported boundaries and independent review.

| Check | Result on final source |
| --- | --- |
| `npm run check` | Passed: 883 test files, 9,568 tests, 146 native/platform skips; test phase 122.33 seconds. Quality, lint, types, migration lineage, build and unchanged renderer budgets passed. |
| `npm run test:portable` | Passed: 111 files, 1,611 tests, nine native/platform skips; 158.90 seconds. Includes all final regressions and the earlier Codex portable-marker correction in one aggregate run. |
| Claude and Antigravity focused checks | Claude 101 passed across six files; Antigravity 69 across two files. Fourteen new Claude drain cases and eight Antigravity session controls. |
| Cursor/Kimi focused checks | Final configuration batch: 86 passed, one native-only skip, four files; 28 new admission/retention cases. Cursor extraction and backend routing: 84 passed across four files. |
| Codex and OpenCode focused checks | Codex 200 passed across fourteen files; OpenCode initial batch 89 across eight files, then final extracted harness 53 passed including delayed SSE. Seven new Codex and two new session-read failure cases. |
| Shared active controls | Complete conformance suite: 106 passed, including five interactive-provider installation-refresh regressions. New launches still refused without verified evidence. |
| Review / architecture | Final deltas independently reviewed. 1,132 source files / 4,261 edges pass unchanged architecture rules. Initial aggregate attempt stopped at Cursor/OpenCode file-size ceilings; focused extraction resolved both before a fresh full gate. |
| Native/live-provider limits | Earlier macOS E2E/package/performance results remain tied to their original source. Final native Windows/Linux CI, merge and release belong to the coordinating task. No live provider account was used. |

Focused batches overlap and are not summed as unique tests. No duration, size
ceiling, assertion or capability requirement was relaxed. Logs:
`local-log:inertia-final-providers-check.log`,
`local-log:inertia-final-providers-portable.log`; the initial architecture-only
failure is retained in `local-log:inertia-final-providers-check-architecture-before.log`.
All new provider test files carry portable discovery markers.

## Measured desktop performance

The normal benchmark passed on macOS ARM64 (Apple M5 Pro, Node 22.23.2,
Electron 44.3.0), using 300 primary turns, 600 primary messages, 120 workspace
files and a deterministic local Codex app-server fixture. This exercises the
provider/runtime/SQLite/WebSocket/React/paint path, without live network latency.
[Sanitized numeric evidence](2026-09-20-correctness/desktop-benchmark-summary.json)
omits process IDs, local paths and raw diagnostics.

| Measurement | Observed value |
| --- | --- |
| Cold / warm first window | 760 / 383 ms |
| Cold / warm runtime interactive | 1,644 / 1,256 ms |
| First provider delta to paint, five samples | Median 21 ms; p95 31 ms |
| Completion to final paint, five samples | Median 241 ms; p95 251 ms |
| Per-sample p95 visible-update gap | Median 75.9 ms; maximum 91.8 ms; normal 100 ms target met |
| Streaming long tasks | Zero in measured samples; 10 over-budget/dropped frames across 2,788 measured frames |
| Authoritative 300-turn scroll sample | 120 frames; p95 16.6 ms; zero frames over 25 ms, zero long tasks; six mounted timeline rows |
| First command palette / settings / intent dialog open | 4.2 / 13.0 / 13.1 ms |
| File tree / terminal / split interactive | 424 / 799 / 93 ms |
| Reader navigation / Jump to latest | Preserved in all five samples; median Jump to latest 51.8 ms, final bottom gap zero |
| Eight open/close cycles | Terminal, xterm, workspace-surface and split counters returned to zero each cycle; heap 16.35 → 17.91 MB |
| Five-iteration, 600-frame soak | Heap 17.91 → 20.07 MB (+2.16 MB); bounded fixture passed |
| Cold / warm shutdown | 305 / 6,517 ms; both runtime exits confirmed |

These are absolute measurements from one host/run, not an improvement claim or
proof of leak absence. The 6.52-second warm shutdown is the slowest observed
lifecycle sample; this run does not establish its cause or a regression against
baseline. The fresh-profile startup still uses pre-seeded data and uncontrolled
OS caches. Visible cadence excludes the fixture's first four gated intervals;
all later intervals remain measured. The short soak and eight close cycles
establish bounded observed retention and disposed UI counters, not indefinite
steady-state behavior. Controlled Linux discovery was not exercised.

## Detailed evidence and independent review

[Provider completion and restart follow-up](2026-09-20-correctness/provider-completion.md)
records the visible-answer/Working investigation, all six provider endings,
restart policy, exact reproduced failures and independent review.

[Final provider capability review](2026-09-20-correctness/final-provider-capabilities.md)
maps all 28 manifest capabilities across the six production routes and records
the final six reproduced defects, independent review and upstream limits.

- [Source and tooling inventory](2026-09-20-source-inventory.tsv): baseline file-to-domain map; inventory is broader than manual deep-read coverage.
- [Native desktop, Windows, terminals and update review](2026-09-20-correctness/windows.md).
- [Attachments and document/provider handoff review](2026-09-20-correctness/attachments.md).
- [Provider, turn, browser evidence, credentials and diagnostics review](2026-09-20-correctness/providers.md).
- [Persistence, migrations, recovery, workspace identity and Duo review](2026-09-20-correctness/persistence.md), including independent provider/vault/Claude review.
- [Renderer, reconnect, draft/focus and performance review](2026-09-20-correctness/renderer.md).
- [Independent aggregate change review](2026-09-20-correctness/independent-review.md). The reviewer excludes their own changes; a different reviewer checked those. The Git reviewer found an additional lock-marker gap, fixed and regression-tested before commit.

## Changed files

Production and regression files changed by this audit (documentation is listed
under Detailed evidence above):

| Production file | Regression file(s) |
| --- | --- |
| [src/main/attachment-registry-file-verification.ts](../../src/main/attachment-registry-file-verification.ts)<br>[src/main/attachment-registry.ts](../../src/main/attachment-registry.ts) | [tests/main/attachment-registry.test.ts](../../tests/main/attachment-registry.test.ts) |
| [src/main/credential-vault.ts](../../src/main/credential-vault.ts) | [tests/main/credential-vault-load-race.test.ts](../../tests/main/credential-vault-load-race.test.ts) |
| [src/main/private-connect/service.ts](../../src/main/private-connect/service.ts) | [tests/main/private-connect/service.test.ts](../../tests/main/private-connect/service.test.ts) |
| [src/main/runtime-supervisor.ts](../../src/main/runtime-supervisor.ts) | [tests/main/runtime-supervisor-lifecycle.test.ts](../../tests/main/runtime-supervisor-lifecycle.test.ts) |
| [src/server/git/reversal-files.ts](../../src/server/git/reversal-files.ts)<br>[src/server/git/reversal-index.ts](../../src/server/git/reversal-index.ts)<br>[src/server/git/reversal.ts](../../src/server/git/reversal.ts) | [tests/server/git-diff-review.test.ts](../../tests/server/git-diff-review.test.ts) |
| [src/server/persistence/database-recovery-import.ts](../../src/server/persistence/database-recovery-import.ts) | [tests/server/database-export.test.ts](../../tests/server/database-export.test.ts) |
| [src/server/provider/claude-agent-sdk-harness.ts](../../src/server/provider/claude-agent-sdk-harness.ts)<br>[src/server/provider/claude-prompt.ts](../../src/server/provider/claude-prompt.ts)<br>[src/server/provider/claude-delegate-lifecycle.ts](../../src/server/provider/claude-delegate-lifecycle.ts)<br>[src/server/provider/claude-subagent-trace.ts](../../src/server/provider/claude-subagent-trace.ts) | [tests/server/claude-prompt.test.ts](../../tests/server/claude-prompt.test.ts)<br>[tests/server/claude-follow-up-settlement.test.ts](../../tests/server/claude-follow-up-settlement.test.ts)<br>[tests/server/claude-visible-final-settlement.test.ts](../../tests/server/claude-visible-final-settlement.test.ts)<br>[tests/server/claude-terminal-drain.test.ts](../../tests/server/claude-terminal-drain.test.ts) |
| [src/server/codex/app-server-events.ts](../../src/server/codex/app-server-events.ts)<br>[src/server/codex/app-server-requests.ts](../../src/server/codex/app-server-requests.ts)<br>[src/server/codex/app-server-run.ts](../../src/server/codex/app-server-run.ts)<br>[src/server/provider/codex-app-server-harness.ts](../../src/server/provider/codex-app-server-harness.ts) | [tests/server/codex-app-server.test.ts](../../tests/server/codex-app-server.test.ts)<br>[tests/server/codex-app-server-terminal-outcomes.test.ts](../../tests/server/codex-app-server-terminal-outcomes.test.ts) |
| [src/server/provider/acp-config-options.ts](../../src/server/provider/acp-config-options.ts)<br>[src/server/provider/cursor-acp-harness.ts](../../src/server/provider/cursor-acp-harness.ts)<br>[src/server/provider/cursor-acp-session.ts](../../src/server/provider/cursor-acp-session.ts)<br>[src/server/provider/kimi-acp-session.ts](../../src/server/provider/kimi-acp-session.ts) | [tests/server/acp-config-admission.test.ts](../../tests/server/acp-config-admission.test.ts)<br>[tests/server/cursor-acp-harness.test.ts](../../tests/server/cursor-acp-harness.test.ts) |
| [src/server/provider/antigravity-cli-harness.ts](../../src/server/provider/antigravity-cli-harness.ts) | [tests/server/antigravity-cli-harness.test.ts](../../tests/server/antigravity-cli-harness.test.ts) |
| [src/server/provider/opencode-sdk-harness.ts](../../src/server/provider/opencode-sdk-harness.ts) | [tests/server/opencode-sdk-harness.test.ts](../../tests/server/opencode-sdk-harness.test.ts)<br>[tests/helpers/opencode-lifecycle-server.ts](../../tests/helpers/opencode-lifecycle-server.ts) |
| Shared controller and UI behavior (test-only follow-up) | [tests/server/turn-restart-continuation.test.ts](../../tests/server/turn-restart-continuation.test.ts)<br>[tests/server/turn-terminal-ui-projection.test.ts](../../tests/server/turn-terminal-ui-projection.test.ts) |
| [src/server/provider/discovery.ts](../../src/server/provider/discovery.ts) | [tests/server/provider-auth-readiness.test.ts](../../tests/server/provider-auth-readiness.test.ts) |
| [src/server/provider/run-coordinator.ts](../../src/server/provider/run-coordinator.ts) | [tests/server/provider-run-admission-cleanup.test.ts](../../tests/server/provider-run-admission-cleanup.test.ts)<br>[tests/server/provider-conformance.test.ts](../../tests/server/provider-conformance.test.ts) |
| [src/server/runtime/attachments/private-generated-attachments.ts](../../src/server/runtime/attachments/private-generated-attachments.ts) | [tests/server/private-generated-attachments.test.ts](../../tests/server/private-generated-attachments.test.ts) |
| [src/renderer/src/hooks/useConversationProjection.ts](../../src/renderer/src/hooks/useConversationProjection.ts)<br>[src/renderer/src/hooks/useInertiaConnection.ts](../../src/renderer/src/hooks/useInertiaConnection.ts)<br>[src/renderer/src/hooks/useSplitWorkspaceScene.ts](../../src/renderer/src/hooks/useSplitWorkspaceScene.ts)<br>[src/renderer/src/utils/runtimeSequencing.ts](../../src/renderer/src/utils/runtimeSequencing.ts)<br>[src/server/runtime-sequencing.ts](../../src/server/runtime-sequencing.ts)<br>[src/server/runtime/runtime-sync-hub.ts](../../src/server/runtime/runtime-sync-hub.ts)<br>[src/shared/contracts/client-command/app.ts](../../src/shared/contracts/client-command/app.ts)<br>[src/shared/runtime-detail-subscriptions.ts](../../src/shared/runtime-detail-subscriptions.ts) | [tests/renderer/conversation-projection-interactions.dom.test.tsx](../../tests/renderer/conversation-projection-interactions.dom.test.tsx)<br>[tests/renderer/runtime-sequencing.test.ts](../../tests/renderer/runtime-sequencing.test.ts)<br>[tests/server/runtime-sequencing.test.ts](../../tests/server/runtime-sequencing.test.ts)<br>[tests/server/runtime-sync-hub.test.ts](../../tests/server/runtime-sync-hub.test.ts) |

## Remaining limits

Native Windows and Linux execution for the final patch depends on hosted CI;
local macOS simulations and historical baseline checks are labeled separately.
No live provider credentials/accounts, OS credential-service roundtrip, provider
canary drift, unusual antivirus/corporate policy, RDP/fast-user-switching, power
failure, or exhaustive high-DPI/multi-monitor behavior was exercised by these
source/fixture reviews. Upstream Kimi may report a partial-output error as a
normal end-turn event; the protocol cannot reliably distinguish that case.

Filesystem identity checks bracket asynchronous work and fail closed on tested
replacements, but Node pathname APIs do not make every final validation/syscall
pair atomic against hostile component replacement. Temporary/generated directory
identity does not include birthtime; inode reuse was not reproduced. The Git
rollback uses a real writer lock and byte/identity checks; native Windows rename
semantics still require branch-specific hosted validation. Large native helper,
migration, provider projection and preview hook modules received targeted review
plus fixture coverage, not a claim of formal or exhaustive line-by-line proof.
