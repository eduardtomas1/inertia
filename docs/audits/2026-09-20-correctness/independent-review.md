# Independent aggregate correctness review

This domain review records its review-wave evidence. The [consolidated audit](../2026-09-20-correctness.md) contains final local gates, native results and limitations.

Reviewer: providers_turns. Baseline d56f972b. Shared worktree codex/full-correctness-audit. This review excludes the reviewer's own auth/admission/vault changes; Windows/native reviewer owns their independent review. No claim of zero defects across every original source line or native platform behavior.

## Reviewed commits

- **3a37fa2d** — generated attachment storage authority retention. Read full production diff plus surrounding creation/mutation flow. Directory root is pinned and revalidated before deletion attempts and around asynchronous file writes; cleanup avoids following replacement roots. Native directory descriptor chmod checks are POSIX guarded. No blocking finding.
- **fdb844ac** — temporary attachment session authority retention. Read production diff and import/read/release/dispose call graph. First-use pinning is serialized by importTail in ordinary application use; readers/releases require records already published after pinning, and handoff/disposal await importTail. New authority checks preserve the swapped directory. No blocking finding. Stored identity uses device/inode without birthtime; actual inode reuse while all original contents are removed is an unexercised edge, not a reproduced defect. All paths remain subject to pathname syscall timing on platforms without directory-relative file APIs.
- **6057801d** — bounded/cancellable Claude image preparation. Read prompt implementation and both harness call sites/cancel flow plus shared image reader. Sequential descriptor-based reads enforce common per-file/aggregate limits before allocation, check snapshots, reject unsafe file types, and observe the preparation controller on normal and forced cancellation. Follow-up reservation is released on error. Shared controller use preserves SDK Query interrupt behavior. No blocking finding.
- **a1d91fe2** — Private Connect read authority revalidation. Read request context, revised post-await authority checks, session/device helpers and five regression cases. Session object identity, current device grant version, privacy lock/revocation/expiry and pending authority reduction reject stale read results before adaptation. No blocking finding.
- **fb4e5e0c** — synchronous unexpected-exit recovery failure. Read revised catch and surrounding handleDrainedExit/finishRecovery branches plus regression scenarios. Catch retains quarantined process-generation authority, blocks replacement and settles stop/recycle through existing paths; does not synthesize cleanup proof. No blocking finding.
- **9ac12394** — guarded Git reversal index restoration. Detailed review covered lock acquisition, private copy, expected selected entry, original byte/identity checks, guarded rename, mode preservation, cleanup and three rollback call sites. Initial review identified a concrete same-inode foreign lock mutation gap: identity alone permitted overwriting another token. Parent added marker bytes/size/nlink validation plus failing-boundary regression before commit; reviewed amended code and confirmed addressed. No remaining blocking finding.
- **1309d432** — recovery import destination authority. Read production diff and complete prepare/publish/complete/abort/reconciliation control flow plus new staging-symlink/parent-replacement/published-directory-replacement fixtures. Authorized root retained across await boundaries, staging/final directory identity retained after bind, publish rechecked before durable path commit, and abort refuses reconciliation against replaced authority. Journal remains for manual restoration/reconciliation on uncertain authority. Zero-project imports continue to validate only the authorized root. No blocking finding in the change.

## Review evidence and caveats

- Git disposable fixture directly confirmed alternate index copying/read/update works for a split-index repository, and `rev-parse --path-format=absolute --git-path index` locates the linked worktree's own index. Native writer lock contention leaves the original index untouched; foreign lock data is retained. Original permission mode is applied to replacement. Native Windows filesystem share-delete/rename behavior was not executed by this reviewer; Windows CI remains required.
- Parent reported Git helper/rollback regression 3/3 and full diff/workspace suite 49/49 passed. This reviewer inspected the fixtures and implementation but did not duplicate those suites or consume the reserved native test slot.
- Temporary/generated attachment authority omits birthtime comparison; no concrete directory inode reuse was reproduced. Initialization race suspicion was rejected after import/read/dispose call graph tracing as above. Directory component replacement between final pathname validation and a native syscall remains a platform-level limitation to distinguish from tested before/after-await identity retention.
- No live provider accounts, real credential vaults, local browser private pages, external messages or releases were used.
- At the first review checkpoint, renderer continuation commits remained outstanding; the final delta and size reviews below cover them.

## Final renderer and architecture delta review

- **23893a8d** — all split pane subscriptions through reconnect. Read all eight production-file changes and all four test-file changes, plus actual useSplitPaneScenes callers, projection cleanup effects, connection send/reconnect flow and hub replay/projection paths. Shared owner enum covers the four real pane owners. Main reconnect URLs now retain paired owner/ID entries, so vacant middle slots and two panes sharing one conversation survive reconnect without renumbering. Parser caps IDs at four, checks paired counts/known owners/unique owners, permits duplicate IDs only with explicitly distinct owner entries, and preserves older no-owner URLs. Hub detached-chat handling discards supplied owners/IDs and pins the authorized conversation; main cleanup recomputes a deduplicated delivery set from the exact owner map. Projection passes each real split owner and treats every nonprimary pane consistently during fresh hydration. Hook subscription cleanup remains synchronous with command submission and exact owner identity; offline submissions update the local reconnect map before socket rejection. No blocking finding. Reviewed regression evidence includes four live panes, replay, vacant-middle immediate cleanup, duplicate-conversation last-owner cleanup, malformed owner URLs and detached scoping. Author reports 112 focused and 236 broader renderer tests passed; this reviewer did not repeat the same suites while full verification resource slot is coordinated.
- **434ff843** — architecture-size refactor. Read full delta. Attachment directory identity verification was moved verbatim into the existing file-verification module with unchanged condition/error text; supervisor change only compacts the comment. No behavior change or blocking finding. Author reports 81 attachment tests passed following relocation; full architecture gate remains parent-owned.

Final reviewed source HEAD: **434ff843**. No outstanding blocking review findings. Remaining test/platform limitations above still apply; final full-gate outcome must come from parent verification logs.

## Renderer size follow-up

Reviewed the three-file follow-up removing the renderer-only, production-unused `RuntimeDetailSubscriptions.conversationIds()` method and legacy string-array URL-generator branch. Call-site search confirms actual connection code already supplies `mountedPanes()` owner pairs and no removed-method consumers remain. Server parsing of legacy URLs is unchanged. Updated two test files exercise the same paired-owner API used in production, including duplicate-conversation panes. No blocking finding; no budget changes, native runs, or broad reruns by this reviewer. Review completed on the uncommitted delta pending attachments owner's commit.

Reviewed second renderer size follow-up (uncommitted Map-based mounted-pane tracker, hook destructuring default, sparse remount-order regression). URL encoding pairs owners and IDs explicitly; map insertion/remount order does not affect server owner lookup. Distinct owners sharing one conversation remain separate and deletion removes only the named owner. Parameter default preserves the declared optional, non-null owner contract. No blocking finding. Proposed shared maximum derived from the existing four-owner tuple would preserve the bound; separate parent approval/commit remains required. No verification budgets changed by this review.

Final bundle follow-up: d7a94605 and 77745385 remove only unused renderer compatibility code, store only mounted pane owner/ID pairs, and initialize the existing hook owner fallback directly in its parameter default. Providers reviewer independently approved these semantics and the sparse-remount regression. Root separately reviewed the shared numeric four-pane maximum: its TypeScript type is the owner tuple's length, preserving a compile-time mismatch error if owner count changes, while server enum and URL validation remain unchanged. The actual renderer bundle check passed every unchanged ceiling on 77745385. No blocking review findings remain in the final source delta.

## Provider completion follow-up, 20 September

Reviewer `providers_turns` independently approved the final scoped changes:

- **b32f9374 — Claude prompt failure settlement.** Exact root UUID/session/child
  ownership distinguishes terminal failures of initial and accepted follow-up
  prompts. Error results precede pending-success correlation checks. The reviewer
  identified success-shaped `is_error` and masked error-result cases; both were
  reproduced and fixed. Genuine local cancellation and successful correlation
  remain intact. Fifteen new cases; author reported 83 focused tests in eight files.
- **71d88a60 — Codex terminal outcomes.** Explicit malformed-protocol rejection
  stays separate from user cancellation, retains first-error detail, and accepts
  the outcome before asynchronous owned cleanup. The public harness preserves
  that outcome. Review identified the earlier-error masking case, and the author
  reproduced it before switching from inferred reason to explicit cause. Final
  review includes malformed/foreign input and the intentionally changed existing
  integration assertion. Cleanup uncertainty still fails. Author reported 106
  focused tests in six files, including sixteen new cases, plus lint and unit types.
- **d7848c0c — all-six restart and UI projection.** Real SQLite/controller tests
  verify recovery warning idempotence, exact continuation identity and no launch
  merely from opening the runtime. Terminal tests use the actual sidebar
  projection and assert terminal runState/status; late events cannot revive
  Working or mutate messages. Old-generation cleanup is explicitly simulated,
  so these tests make no native provider-session claim.
- **0fd57338 — Claude ambient tasks.** Pinned SDK declarations explicitly mark
  ambient roster entries and task-start events as non-activity. The reviewer found
  the missing `local_agent, ambient:true` edge case after the roster fix; the
  author reproduced it and added the same exclusion to the existing bounded
  ignored-task path. Older messages without ambient flags retain prior behavior.
  Actual delegates and explicit background deferral still need fresh parent
  completion. Final author log: 103 tests in seven files passed, including 22
  visible-final cases; no timeout value changed.

The foreground-to-ambient transition received an additional review. Its original
extra-read sentinel did not prove an unbounded hang: a fresh parent final already
arms the existing trace drain. The replacement test leaves the iterator open,
verifies bounded settlement, and retains the known live child trace. The shared
controller conservatively rejects completed-with-live-descendants when no typed
child terminal edge arrives. No roster/edge ownership correlation, invented
completion, or reversible liveness/schema workaround was introduced.

## Shared terminal-to-Working trace

All six native routes enter ProviderRunCoordinator and TurnController. Exact
provider/run/turn identity and cleanup proof gate terminal release. The terminal
transaction writes the turn/runState, conversation and workspace-run state
atomically. Exact-owner renderer terminal overlays survive failed detail refresh.
The sidebar reads the selected workspace run/conversation; transcript activity
reads authoritative runState/status. Remaining text or historical activities do
not independently reactivate a terminal turn, and late provider callbacks are
rejected after settlement.

No additional committed-terminal stale-Working defect was reproduced. Independent
renderer verification passed **67 tests in three files**, covering conversation
projection DOM, sidebar and response timeline. Logs:
`local-log:inertia-terminal-working-ui.log`,
`local-log:inertia-audit-claude-visible-final-after.log`.

No blocking finding remained at this checkpoint. Live account behavior and the
user's exact sequence were not observed. The later capability pass reproduced
the separate suspicion about quiet frames discarding an armed parent-resume
deadline. The final review below supersedes its earlier unconfirmed status.

## Final provider capability delta review

Independent review covered Antigravity session pinning, exact OpenCode session
reads, the remaining Codex protocol-rejection paths, Cursor/Kimi authoritative
configuration, Claude parent-resume deadlines and shared admitted-control
authority. Root read every production diff and regression fixture. Provider and
native reviewers cross-reviewed changes outside their own implementation scope.

The coordinator identified two gaps before source freeze: wall-clock rollback
could extend the new Claude absolute deadline, and later full ACP configuration
responses could revert earlier confirmed selections. Negative controls reproduced
both. Claude now uses monotonic elapsed time; ACP checks every actual config
selection against the final authoritative response. Native mode APIs, genuine
new foreground work, exact control ownership and cancellation checks remain
intact. No timeout duration, cleanup requirement or verification gate was relaxed.

The shared-control fix reuses the same admitted capability snapshot as run event
admission, including current exact-run negotiated observations. Invalidated
installation evidence still blocks new runs. Five interactive-provider controls
verify the existing run stays usable and stale/cancelled owners stay rejected.
See the [final capability report](final-provider-capabilities.md) for the complete
scope and limitations; final aggregate checks are in the main audit ledger.
