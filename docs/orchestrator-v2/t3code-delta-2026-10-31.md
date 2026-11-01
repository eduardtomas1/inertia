# T3 Code delta `32ecd717` → `15fe2832` against ORCHESTRATOR V2

Recorded 2026-10-31. This document compares the upstream range with Inertia's
ORCHESTRATOR V2 and records the decisions taken for the phase-3 polish package.
It supplements the [orchestration study](t3code-orchestration.md) and the
[evolution study](t3code-evolution.md); it does not replace their pinned
research snapshot.

## Range and conventions

| Item | Value |
| --- | --- |
| Upstream start | `32ecd71726fee16f335484c1f95cbce126d461f6`, committed 2026-10-30 09:17:08 UTC |
| Upstream end | `15fe2832727893cbdd2214383f9f971474849695`, committed 2026-10-31 14:54:48 UTC |
| Stable release in range | [v0.1.6](https://github.com/pingdotgg/t3code/releases/tag/v0.1.6), published 2026-10-31 10:52:24 UTC at `2359643cffa6ba9ee84d6f2694b935de54a8013e`; `15fe2832` is six commits later |
| First-parent commits | 393 |
| Inertia comparison base | `52315e95` (PR #686 with Phase 0 stabilization) |

- T3 anchors are `path:line` at `15fe2832`, relative to the T3 repository root.
  Where no line applies, the commit sha is given instead.
- Inertia anchors are `path:line` at `52315e95`, relative to the Inertia
  repository root. Files changed by the phase-3 polish package can move these
  lines; the cited symbols remain the reference.
- All 393 first-parent titles were reviewed. Server-side diffs (logic and new
  test names) were read for every commit touching
  `apps/server/src/orchestration-v2`, `docs/orchestration-v2`,
  `apps/server/src/mcp`, `apps/server/src/scheduledTasks`,
  `apps/server/src/scheduling`, `packages/provider-core` or
  `packages/contracts/src/orchestrationV2.ts`. Provider-package commits were
  triaged by diff headline. Upstream code and tests were read, not executed.

### Scope facts

Byte-unchanged in the range:

- `apps/server/src/orchestration-v2/`: `QueuedRunOrder.ts`,
  `RunFinalizationService.ts`, `ProviderSwitchService.ts`,
  `ProviderSessionTransitionPolicy.ts`, `NotificationMailbox.ts`,
  `DelegatedTaskQuestionReactor.ts`, `ProviderRuntimeRecoveryService.ts`,
  `RestartContinuation.ts`, `RestartBackgroundNote.ts`,
  `ThreadSettlementService.ts`, `ThreadLaunchService.ts`,
  `ThreadMessageIntake.ts`, `EffectWorker.ts`, `EffectOutbox.ts`,
  `EventSink.ts`, `ThreadCommandExecutor.ts`, `ProviderTurnControlService.ts`,
  `RuntimeRequestService.ts`, `CheckpointRollbackService.ts`,
  `ThreadDeletion.ts`.
- `packages/provider-core/src/server/handoffBudget.ts` and `notification.ts`.
- `apps/server/src/mcp/{McpToolAccess,McpSessionRegistry,threadAccess,delegatedTaskModes}.ts`
  and the `apps/server/src/mcp/toolkits/{orchestrator,thread}` handlers and tools.
- `apps/server/src/scheduling/Scheduler.ts` and `apps/server/src/scheduledTasks/Schedule.ts`.

Changed in the range (orchestration-relevant): `ThreadForkService.ts`,
`CheckpointRestoreSafety.ts`, `CheckpointCaptureService.ts`,
`CheckpointService.ts`, `CommandPolicy.ts`, `ContextHandoffService.ts`,
`ContextHandoffDelivery.ts`, `ProviderTurnStartService.ts`,
`ThreadManagementService.ts`, `Orchestrator.ts`, `ProjectionStore.ts`,
`UsageLimitRecoveryWorker.ts` (all under `apps/server/src/orchestration-v2/`),
`apps/server/src/mcp/OrchestratorMcpService.ts`,
`apps/server/src/mcp/toolkits/project/handlers.ts`,
`apps/server/src/scheduledTasks/ScheduledTaskService.ts` and
`packages/provider-core/src/server/subagentProjection.ts`.
`apps/server/src/scheduling/DueHint.ts` is new.

Two `docs/orchestration-v2` files changed: `orchestrator-mcp-server.md`
(+2 lines, 65965f7ab8) and `thread-lineage-and-context-transfer.md`
(+2 lines, 50c1c5dc53).

`isBlockingRun` became the exported `isActiveRun`
(`apps/server/src/orchestration-v2/CommandPolicy.ts:119`). Its status set is
unchanged (preparing, starting, running, waiting); the rename carries no
semantic change.

## A. Relevant upstream commits

Status vocabulary: **satisfied** (an Inertia file or test proves it),
**partial**, **different** (a deliberate Inertia design), **not satisfied**,
**adopted** (decided for the phase-3 polish package, in progress),
**assigned** (deferred to a named later phase), **not started**,
**not assessed** (Inertia code not compared), **n/a**.

### A1. Orchestration core, forks, merge-back, recovery, tools, scheduling

| sha | PR | Semantics | Inertia phase | Inertia status |
| --- | --- | --- | --- | --- |
| 50c1c5dc53 | #26901 | Side chats (forks with `lineage.sideChat`; see B.8). Generic changes in the same commit: (1) native fork refused when a later source run is active, at dispatch and again at turn start; (2) portable forks carry inherited ancestor rows; (3) fork and merge-back items pass a visibility filter dropping rolled-back runs and cancelled queued messages; (4) one pending merge-back per target across all forks; (5) a ready handoff whose target run was cancelled carries forward; (6) `thread.delete` cascades to side chats and gains `onlyIfUnused` | Phase 3 and polish; side chats in client parity | (1) satisfied: `src/server/runtime/fork-session-service.ts:48-61`, test `tests/server/orchestration-native-forks.test.ts:116`. (2) satisfied: `src/server/orchestration-v2/fork-history.ts:20-33`. (3) satisfied: `src/server/orchestration-v2/fork-history.ts:38-40`, `src/server/orchestration-v2/merge-back-repository.ts:160-166`; cancelled queued text stays in `queued_messages` (`src/server/persistence/queued-message-repository.ts:74`). (4) satisfied: one pending merge-back per target chat across all forks (`src/server/orchestration-v2/merge-back-repository.ts:209-222`). (5) satisfied in effect: `src/server/orchestration-v2/backing-repository.ts:134,164`. (6) side chats assigned (see section E) |
| 0804c60a9c | #23554 | Merge-back refused when the target has a preparing, starting, running, waiting or queued run, checked under the target's command lock (`apps/server/src/orchestration-v2/Orchestrator.ts:4419-4428`; test `apps/server/src/orchestration-v2/runtimeLayer.test.ts:1943`) | Phase 3 | different: visible draft packet delivered with the next explicit send; queued messages keep their captured context (`src/server/orchestration-v2/merge-back-repository.ts:40-98`; `tests/server/orchestration-merge-back.test.ts:103,182`) |
| 7f005d4d8d | #24014 | A fork starts with `titleRegeneration: null` (`apps/server/src/orchestration-v2/ThreadForkService.ts:112-113`; test `apps/server/src/orchestration-v2/ThreadForkService.test.ts:166`) | Phase 3 | satisfied by construction: new conversation with an explicit title and no title-job state (`src/server/orchestration-v2/fork-repository.ts:73-79`); no focused test |
| 28c7d3e767 | #23669 | `prepared-run.release` and `prepared-run.retry` refused when the run's provider instance is disabled for the project (`apps/server/src/orchestration-v2/ThreadManagementService.ts:728-742`) | Delegation and launch | not started |
| 7f2ff41bc8 | #26035 | Native and MCP subagent children start with `autoSettleDisabledAt`, `pinnedAt` and `pinOrderKey` null (`packages/provider-core/src/server/subagentProjection.ts:85-87`) | Native child threads | not started |
| 54d0a161bb | #25224 | Codex: a `turn/start` response naming a turn owned by another attempt (settled or active) raises a protocol error | Queues | assigned to the queue phase. Today `src/server/codex/app-server-run.ts:1185-1187` rejects only a mismatch with the current active turn and does not consult `completedTurnIds` (`src/server/codex/app-server-events.ts:115`) at start; whether one app-server serves several runs is unverified |
| afb8619e1d | #27514 | Pi: `clear_queue` precedes `abort` on Stop; cleared steer and follow-up texts surface as a system notice | Queues | assigned to the queue phase. Ordering satisfied (`src/server/provider/pi-rpc-harness.ts:77`; `tests/server/pi-rpc-harness.test.ts:110,197-198`); no cleared-queue notice |
| 1820fbe6bc | #27831 | Run-update and delegated-task subscribers use `forkScoped` and stop before the database closes (`apps/server/src/orchestration-v2/Orchestrator.ts:13602,13644`) | Restart and shutdown | n/a today: Inertia has no V2 run-update or delegated-task subscribers to stop, so there is no equivalent mechanism yet. The store closes last (`src/server/runtime-shutdown.ts:174-182`) and the command lanes close in `src/server/index.ts:1125`; the rule applies once V2 publication (client-parity phase) adds subscribers |
| e496db3a5e | #24634 | `autoArmLimitRecovery` arms with `autoResume:false`, `snooze:false` when a Stop reached the run before its usage-limit failure landed (`apps/server/src/orchestration-v2/Orchestrator.ts:13805-13835`; test `apps/server/src/mcp/TaskCancelUsageLimit.integration.test.ts`) | Usage-limit recovery | assigned to the recovery phase; `src/server/usage/limit-reset-scheduler.ts` is the pre-V2 user-scheduled model |
| 63b0e3d82e | #21735 | A recovery whose reset is more than 24 h overdue is not freshly armed; exactly 24 h still arms (`apps/server/src/orchestration-v2/UsageLimitRecoveryWorker.ts:15,43`; tests `apps/server/src/orchestration-v2/UsageLimitRecoveryWorker.test.ts:96-118`) | Usage-limit recovery | assigned to the recovery phase |
| 9b1d351ba0 | #27711 | (a) Command reads omit settled subagents unless active or named in `except` (`apps/server/src/orchestration-v2/ProjectionStore.ts:345-349`); migration 075 indexes `completion_delivery_state`. (b) Completion notices count the whole cohort (`apps/server/src/orchestration-v2/Orchestrator.ts:1152-1153`). (c) Child ordinals come from the subagent count (`apps/server/src/orchestration-v2/Orchestrator.ts:9743`). (d) MCP task reads load only named tasks. (e) `DueHint` extracted to `apps/server/src/scheduling/DueHint.ts` and reused by the usage-limit sweep (`apps/server/src/orchestration-v2/UsageLimitRecoveryWorker.ts:81-146`) | Delegation, recovery, agent tools, scheduling | not started |
| 65965f7ab8 | #26682 | `t3_thread_launch`: an explicit unsupported runtime mode is refused; an inherited or default mode steps down to the broadest offered mode; skipped on replay (`apps/server/src/mcp/toolkits/project/handlers.ts:213-221`; `docs/orchestration-v2/orchestrator-mcp-server.md:366-368`) | Agent tools | assigned to the agent-tools phase |
| 6557665660 | #26681 | Wording only: the PR-wait instruction in `packages/provider-core/src/server/runtimeInstructions.ts` | Agent tools | n/a |
| f0ec7398d7 | #23929 | Idle compaction checks driver, setting and provider enablement before reading history | – | n/a |
| e6fcceea59 | #24707 | The V1 importer caches absent legacy rows | Migration | n/a (no V1→V2 importer) |
| d7d5d7c79b | #24689 | Storage cleanup keeps worktrees waiting for a usage-limit reset (`apps/server/src/storageCleanup.ts:140,146`) | Usage-limit recovery | assigned to the recovery phase |
| f56a4775fd | #26074 | Thread deletion removes files attached to question answers | Persisted questions | not started |
| 6366aba744 | #26758 | Recreated worktree base order: `refs/remotes/origin/<branch>`, current branch, `origin/HEAD` commit without tracking, `HEAD` | Delegation worktrees | not assessed |
| 1a3f1459b2 | – | Failed event-ingestion writes surface the database error | Core | not assessed |
| c6ef3b46eb, 49f6cbacc4, f98ff73a1d | #25306, #26502, #27039 | MCP read semantics: an empty `statuses` list means no filter; model search keeps provider-name words; thread reads skip unused projections | Agent tools | assigned to the agent-tools phase |
| 40b435377e, fb412b69c3, 91c7c4703d | #25291, #24046, #26070 | Webhooks: HEAD probes return 405 and start no run; per-bucket delivery history; truncated bodies stay valid UTF-8 | Scheduled tasks | not started |
| 6275f5c665 | #24248 | Docs: "Send first queued" steers during a turn and starts a turn when stopped (`docs/user/keybindings.md`) | Queues | not started |
| eef35b0262, 7cd9a73b2f | #26762, #24493 | Opening a chat no longer loads its thread family; alerts missed during a disconnect fire on reconnect | Client parity | not assessed |
| f47700849e | #22141 | Web shows the result of a notified delegated task | Delegation UI | not started |

### A2. Provider commits

Inertia status is not assessed unless stated.

- **Codex:** 6919aa4cf1 #25322 (late subagent `turn/interrupt` forked off the
  notification reader, 10 s timeout); 13c7de296c #23234
  (`serverRequest/resolved` releases its handler fiber; Inertia projects the
  notification at `src/server/codex/app-server-events.ts:590`, handler release
  not compared); 87b36c77fb #23388 (only phase `null` or `final_answer` is a
  final answer); 2ce31853d6 #23938 and 060c332c4e #23766 (exit diagnostics,
  decode warnings).
- **Anthropic SDK adapter:** 251834c161 #25200 (steered segment usage summed;
  a result is complete only when the final segment reports valid counts);
  4524eeeaa3 #23481 (resume-dialog question is a control request, not a tool
  row); ff55c19baa #21903 (MCP elicitations as approval cards); ec9d994f00
  #22272 (effort change does not re-send an unchanged model); 159a914d6b
  #22654 (context meter shows the auto-compact point).
- **Pi:** afb8619e1d #27514 (see A1); 77336a54a7 #27521 (nested
  `executeTool` calls under their caller); e00ebb6e26 #27539 (untrusted-folder
  notice); 6575ce3250 #27513 and 26dc3688e2 #23741 (credential and error
  messages); 947916887c #27515 and d544d786bf #28061 (terminal Pi session
  import).
- **Cursor SDK:** 80fd67eca6 #24639 (blocked `/v1/me` tolerated); 8a80ea1f7f
  #24702 (credentials with undefined optional fields saved).
- **OpenCode 2:** 200a373fbd #23591 (streamed text survives event-stream
  reconnect); 9facfc5923 #23598 (3-minute limit covers whole text
  generation); d8430c0b9d #26165 (Go key from the v2 credential store);
  9f018954d0 #24734; b970bcb34b #22442.
- **ACP and registry:** e4a067b526 #26623 (models the session does not offer
  rejected at configure and each turn); 3f75a0e005 #24908 (v2 prompt echoes
  deduplicated); 076aacca16 #25559 (`cancelled` tool calls become `failed`);
  94a53a2f79 #26968 (HTTP MCP offered when `mcpCapabilities.http` is
  advertised); f1e2e5d65d #23834 (MCP over ACP serialised only until
  negotiated); 82503ccf2e #21323 (stdout EOF without exit fails requests after
  250 ms); 68be2f7b32 #19958 (per-turn prompt usage); 5b0cf58f68 #23684 and
  812cb68b7d #25545 (per-agent install locks, large archives); 62efa4bf5e
  #24024 and 146dd04890 #24479 (terminal log performance); 9522c7dd8f #23440
  (empty plan replacements forwarded).
- **Antigravity:** f5372d27da #22217 (manual compaction rejected); f8df431165
  #25292 (binary reads reported as errors).
- **Provider instance registry:** 4ce54d46ed #24480 (retired instances removed
  before their scopes close, so no turn starts on a replaced instance);
  b9eb5524ae #24777 (retired scopes released).

## B. Phase-3 rules enforced upstream at `15fe2832`

### Fork

1. **Native fork requires an idle source after the fork point.**
   `decideForkExecution` requires `!input.sourceBusy`
   (`apps/server/src/orchestration-v2/CommandPolicy.ts:373-379`). Dispatch
   sets `sourceBusy` when any source run with a later ordinal is active
   (`apps/server/src/orchestration-v2/Orchestrator.ts:6574-6594`). Turn start
   repeats the check; a source that became busy resolves the transfer
   portably with a `full_thread_summary` handoff from `readForkHistoryItems`,
   status `resolved_portable`, and clears `forkedFrom`
   (`apps/server/src/orchestration-v2/ProviderTurnStartService.ts:1122-1206`).
   Tests: `apps/server/src/orchestration-v2/CommandPolicy.test.ts:270`,
   `apps/server/src/orchestration-v2/ProviderTurnStartService.test.ts:1250`.
   Inertia: the busy-source rule is satisfied. A running source, pending cleanup or changed workspace
   selects portable with `native-source-unavailable`; a held admission lease
   or terminal-resume reservation selects portable with `native-source-busy`
   (`src/server/runtime/fork-session-service.ts:48-61`). Test:
   `tests/server/orchestration-native-forks.test.ts:116`. T3's second
   native-fork condition, a source run that is `completed` or `waiting`
   (`apps/server/src/orchestration-v2/CommandPolicy.ts:375`), is not
   satisfied: Inertia accepts any finished source turn and forks natively
   whenever its native boundary settled, so failed, interrupted and cancelled
   turns qualify (`src/server/orchestration-v2/fork-repository.ts:70,82-87`;
   `src/server/runtime/fork-session-service.ts:40-44`). Tracked as fork polish
   (G12).
2. **Portable fork history includes inherited rows.** Ancestors are walked
   oldest first, stopping at a missing ancestor or cycle and skipping side
   chats; then the source's own items through the source run. Every segment
   passes `visibleConversationItems`
   (`apps/server/src/orchestration-v2/ContextHandoffService.ts:131-203`;
   `packages/shared/src/orchestrationV2Timeline.ts:72-100`), which drops
   items of `rolled_back` runs, `queued_turn` user messages of cancelled runs,
   and superseded interrupt results. Test:
   `apps/server/src/orchestration-v2/ContextHandoffService.test.ts:207`.
   Inertia: satisfied (`src/server/orchestration-v2/fork-history.ts:20-40`);
   no superseded-interrupt equivalent exists, so that part is n/a.
3. **Fork plan state.** `titleRegeneration: null`
   (`apps/server/src/orchestration-v2/ThreadForkService.ts:112-113`); PR
   watches stripped (`:104-107`); guest share, opens, snooze and settlement
   reset (`:129-139`). Only the title rule is new in the range. Inertia:
   satisfied by construction (`src/server/orchestration-v2/fork-repository.ts:73-79`).

### Merge-back

4. **Admission order** in `dispatchThreadMergeBack`
   (`apps/server/src/orchestration-v2/Orchestrator.ts:4365`):
   - the source must be a fork of the target (`:4409-4418`);
   - the target must have no active and no queued run (`:4419-4428`);
   - no pending merge-back from a different source may target it
     (`:4429-4442`; test
     `apps/server/src/orchestration-v2/ThreadFork.execution.test.ts:1116`);
   - the source run must be `completed` or `waiting` (`:4444-4458`);
   - a fork transfer must exist (`:4460-4473`); `basePoint` is always the
     fork point (`:4495`); pending transfers of the same pair are superseded
     (`:4484-4490`).

   Inertia: busy-target refusal is a deliberate difference; cross-fork
   exclusivity is adopted (section E); source status and base point remain the
   differences recorded in
   [implementation-progress.md](implementation-progress.md).
5. **Delta content.** Delta items are `visibleConversationItems` over the
   fork's runs up to the merge-back source run
   (`apps/server/src/orchestration-v2/Orchestrator.ts:6913-6924`), rendered by
   `summarizeDeltaItem`
   (`apps/server/src/orchestration-v2/ContextHandoffService.ts:205-221`): User,
   Assistant, Command input, File change name, Checkpoint file count,
   Handoff. That function is the reference format for command and file-change
   items. Inertia: rolled-back exclusion satisfied
   (`src/server/orchestration-v2/merge-back-repository.ts:160-166`); the
   command and file-change work summary is adopted (section E,
   `src/server/orchestration-v2/merge-back-repository.ts:245-279`) without
   T3's `Checkpoint: N files` and `Handoff:` lines
   (`apps/server/src/orchestration-v2/ContextHandoffService.ts:216-219`), which
   are tracked as merge-back polish (G12).
6. **Handoffs targeting a cancelled run carry forward.** `isPendingForRun`
   treats a `cancelled` target run like `failed` and `interrupted`
   (`apps/server/src/orchestration-v2/ProviderTurnStartService.ts:367-384`).
   Inertia: equivalent; prepared handoffs are abandoned without advancing
   coverage (`src/server/orchestration-v2/backing-repository.ts:134,164`) and
   merge-back drafts of a run settled before dispatch become `undelivered`
   (`settleRun`, `src/server/orchestration-v2/merge-back-repository.ts:183-189`).

### Rollback

7. `CheckpointRollbackService.ts` is unchanged. `CheckpointRestoreSafety.ts`
   changed only for side chats: an idle side chat in the same worktree with no
   `command_execution`, `file_change` or `dynamic_tool` items does not make
   restore non-isolated
   (`apps/server/src/orchestration-v2/CheckpointRestoreSafety.ts:51-63`), and
   the refusal text names side chats (`:9-10`). No new rollback-to-start or
   combined-restore rule appeared upstream.

### Side chats

8. Rules introduced by 50c1c5dc53:
   - **Contract.** `lineage.sideChat?: boolean`
     (`packages/contracts/src/orchestrationV2.ts:157`). `isListedThreadLineage`
     excludes side chats from thread lists, settlement listings and idle
     compaction (`packages/contracts/src/orchestrationV2.ts:161-163`;
     `apps/server/src/orchestration-v2/IdleCompaction.ts:53`).
   - **Creation.** No side chat from a side chat, a subagent or a
     delegated-in thread
     (`apps/server/src/orchestration-v2/ThreadForkService.ts:81-94`); created
     with `runtimeMode: "approval-required"` (`:114-115`); the first turn that
     carries side-chat context, or the first run, is forced to
     `approval-required`
     (`apps/server/src/orchestration-v2/ProviderTurnStartService.ts:692-700`).
     Refused while the parent's worktree is pending
     (`apps/server/src/orchestration-v2/Orchestrator.ts:4277-4287`) and onto an
     existing id (`:4288-4293`).
   - **Source point.** A side chat may start without a stable source run
     (`latest_stable` during the parent's first turn)
     (`apps/server/src/orchestration-v2/Orchestrator.ts:4297-4306`).
   - **Context.** A digest of the parent's non-queued runs after the fork
     point, plus inherited rows when there is no source run
     (`apps/server/src/orchestration-v2/Orchestrator.ts:6689-6697`). It uses
     `summarizeDeltaItem` lines and keeps the newest within 8,000 characters
     (`apps/server/src/orchestration-v2/ContextHandoffService.ts:245-275`). It
     is a `manual_context` handoff excluded from budgeted history (`:277-278`),
     prepended inline once with delivery `inline`, carried across provider
     switches until a prompt-bearing turn accepts it, and skipped for
     `/compact` and `/goal` turns
     (`apps/server/src/orchestration-v2/ProviderTurnStartService.ts:386-401,1558-1565,1595-1599`).
   - **Workspace.** Shares the parent's worktree; no baseline capture
     (`apps/server/src/orchestration-v2/RunExecutionService.ts:923`);
     checkpoints recorded as missing without Git
     (`apps/server/src/orchestration-v2/CheckpointCaptureService.ts:112`).
   - **Lifecycle.** Deleting the parent cascades under ordered locks, parent
     first (`apps/server/src/orchestration-v2/Orchestrator.ts:1194,13473-13475`);
     `thread.delete { onlyIfUnused }` deletes only a thread with no runs or
     messages (`apps/server/src/orchestration-v2/Orchestrator.ts:12928`;
     `packages/contracts/src/orchestrationV2.ts:2941-2942`).
   - **User documentation.** Bring back (merge-back) delivers the side chat's
     findings with the next message in the main thread and is available only
     while that thread is idle (`docs/user/thread-sidebar.md:301-302`).

## C. Later phases: authoritative sources at `15fe2832`

1. **Managed delegation and durable parent wakes.** Unchanged:
   `apps/server/src/orchestration-v2/{NotificationMailbox,DelegatedTaskQuestionReactor,QueuedRunOrder,RunFinalizationService}.ts`,
   `apps/server/src/mcp/delegatedTaskModes.ts`. Changed:
   `apps/server/src/mcp/OrchestratorMcpService.ts` (9b1d351ba0, f98ff73a1d,
   49f6cbacc4, c6ef3b46eb). Tests: `DelegatedCompletionDelivery.test.ts`,
   `RemoteDelegatedTask.test.ts`,
   `apps/server/src/mcp/TaskCancelUsageLimit.integration.test.ts`. Docs:
   `docs/orchestration-v2/orchestrator-mcp-server.md:218,307,318,457,504`.
   New invariants: completion notices count the whole cohort even when reads
   omit settled tasks; child ordinals come from the total subagent count; task
   waits, stops and reads load only the named task; a settled subagent is
   ended with delivery acknowledged, delivered or disposed (indexed by
   migration 075); prepared starts are refused for a disabled provider
   instance; launched runtime modes step down to an offered mode.
2. **Native child threads.** `packages/provider-core/src/server/subagentProjection.ts`
   (7f2ff41bc8), `packages/client-runtime/src/state/threadSubagents.ts`
   (unchanged), `apps/server/src/mcp/TaskCancelNativeSubagent.integration.test.ts`.
   Invariants: children inherit no pin or auto-settle protection; a late
   native interrupt must not block the notification reader (6919aa4cf1); busy
   parents must not decode settled children per command (9b1d351ba0).
3. **Durable message and configuration queues.** Unchanged:
   `QueuedRunOrder.ts`, `ThreadMessageIntake.ts`,
   `ProviderTurnControlService.ts`. Docs:
   `docs/orchestration-v2/feature-lifecycles.md:61`. Invariants: "Send first
   queued" steers during a turn and starts a turn when stopped; Pi's native
   queue is cleared before abort and cleared texts are surfaced (afb8619e1d);
   steered segment usage is summed (251834c161); Codex `turn/start` must not
   adopt a turn owned by another attempt (54d0a161bb).
4. **Restart reconciliation, questions, approvals, usage limits.** Unchanged:
   `ProviderRuntimeRecoveryService.ts` and its tests, `RestartContinuation.ts`.
   Changed: `UsageLimitRecoveryWorker.ts` (63b0e3d82e, 9b1d351ba0),
   `Orchestrator.ts` `autoArmLimitRecovery` (e496db3a5e),
   `apps/server/src/storageCleanup.ts` (d7d5d7c79b). Invariants: Stop beats
   arming even when it preceded the limit failure; a reset more than 24 h
   overdue is never freshly armed; sweeps skip SQL until the next wake or a
   relevant event (`DueHint`); cleanup keeps worktrees held for recovery;
   subscribers stop before the database closes; answer attachments are
   deleted with the thread; a provider control-request question creates no
   tool row (4524eeeaa3); Codex approval handlers are released on
   `serverRequest/resolved` (13c7de296c).
5. **Agent tools.** Unchanged:
   `apps/server/src/mcp/{McpToolAccess,McpSessionRegistry,threadAccess}.ts`,
   `apps/server/src/mcp/toolkits/{orchestrator,thread}/{tools,handlers}.ts`.
   Changed: `apps/server/src/mcp/toolkits/project/handlers.ts` (65965f7ab8,
   22c70398de), `apps/server/src/mcp/OrchestratorMcpService.ts`. Docs:
   `docs/orchestration-v2/orchestrator-mcp-server.md:354,366-368`.
   Invariants: explicit unsupported runtime modes are refused, inherited or
   default modes step down, neither is re-evaluated on replay; an empty
   `statuses` list means no filter; tools reach ACP agents over HTTP MCP when
   advertised (94a53a2f79); MCP over ACP has no head-of-line blocking after
   negotiation (f1e2e5d65d).
6. **Scheduled tasks.** `apps/server/src/scheduledTasks/ScheduledTaskService.ts`
   (9b1d351ba0, fb412b69c3, 91c7c4703d), `webhookRoute.ts` (40b435377e), new
   `apps/server/src/scheduling/DueHint.ts`. Invariants: `DueHint` is
   invalidated on every write that can move work earlier, a cached hint is
   used only at a matching version, and a 10-minute backstop applies; HEAD
   probes never start runs; suppressed deliveries keep separate retention
   buckets.
7. **Pi, Cursor SDK, OpenCode 2 and ACP registry completion.** See A2.
   Authoritative packages: `packages/provider-{pi,cursor,opencode,acp,acp-registry}`
   and `packages/effect-acp`. ACP requires per-agent install locks and must
   reject models the session does not offer.
8. **Client projection and reconnect parity.**
   `packages/client-runtime/src/state/{threadRelationships,threadShell}.ts`.
   50c1c5dc53 added side-chat shell handling; eef35b0262 derives the selected
   thread's lineage without loading the family; 7cd9a73b2f replays missed
   alerts on reconnect.

## D. Statements in the Inertia study affected by the range

1. `t3code-orchestration.md:103` ("three different relationships"): side chats
   are a fourth lineage flavour inside fork (B.8).
2. `t3code-orchestration.md:105`: native fork is also skipped when a later
   source run is active (B.1). Side chats need no source run and their digest
   includes items of the parent's active non-queued runs
   (`apps/server/src/orchestration-v2/Orchestrator.ts:4297-4306,6689-6697`),
   so "an active source is rejected" applies to ordinary forks only.
3. `t3code-orchestration.md:97` (shared effective budget): the side-chat
   `manual_context` handoff is excluded from budgeted history, has its own
   8,000-character cap and is concatenated inline after `delivery.context`
   (`apps/server/src/orchestration-v2/ContextHandoffService.ts:277-278`;
   `apps/server/src/orchestration-v2/ProviderTurnStartService.ts:386-401,1558-1565`).
4. `t3code-orchestration.md:138` (Stop disables recovery): extended by
   e496db3a5e and 63b0e3d82e (A1).
5. `t3code-orchestration.md:159` (unsafe shared-workspace restoration):
   idle side chats without command, file or dynamic-tool items are exempt
   (B.7).
6. `t3code-evolution.md` launch retry-key correction: still correct. The
   upstream document still says "Launch has no retry key"
   (`docs/orchestration-v2/orchestrator-mcp-server.md:369`, in a paragraph
   65965f7ab8 edited), while the code has the key
   (`apps/server/src/mcp/toolkits/project/handlers.ts:88-94`;
   `apps/server/src/mcp/toolkits/project/tools.ts:126,152`).
7. `t3code-evolution.md` rows for #21114 and #27098: extended, not
   contradicted, by e496db3a5e and 9b1d351ba0.
8. `implementation-progress.md`: `ThreadForkService.ts`,
   `CheckpointRestoreSafety.ts` and the lineage document are no longer
   identical to `dd148481` at `15fe2832` (7f005d4d8d, 50c1c5dc53);
   `CheckpointRollbackService.ts` is. The T3 base point remains the fork
   point per pair, but merge-back is now also refused while another fork's
   transfer is pending or the target is busy or has queued work. The T3 delta
   now excludes rolled-back runs and cancelled queued messages.

The study documents were updated accordingly on 2026-10-31.

## E. Decisions for the phase-3 polish package

| Topic | Upstream reference | Decision |
| --- | --- | --- |
| Cross-fork merge-back exclusivity | `apps/server/src/orchestration-v2/Orchestrator.ts:4429-4442`; `apps/server/src/orchestration-v2/ThreadFork.execution.test.ts:1116` | Adopted: one pending merge-back per target chat. A second fork's merge-back is refused until the first is delivered or removed. |
| Busy-target refusal | `apps/server/src/orchestration-v2/Orchestrator.ts:4419-4428`; 0804c60a9c | Deliberate difference retained: the merge-back is a visible draft delivered with the next explicit send, so queued messages are never blocked by a pending transfer. |
| Merge-back source point | `apps/server/src/orchestration-v2/Orchestrator.ts:4444-4458` | Adopted: an explicit source point can be chosen in addition to the latest stable point. |
| Work summary in the merge delta | `apps/server/src/orchestration-v2/ContextHandoffService.ts:205-221` | Adopted: command and file-change items are summarised alongside message excerpts. |
| Combined context rollback with file restore | `apps/server/src/orchestration-v2/CheckpointRollbackService.ts` (unchanged); `apps/server/src/orchestration-v2/CheckpointRestoreSafety.ts:51-63` | Adopted: context rollback with opt-in file restore, with partial outcomes reported. The phase-3 polish shipped Inertia's time-bounded restore checks only, without T3's isolation rule. Since 2026-10-31 the restore also holds an exclusive checkout claim that fences provider-turn admission on overlapping checkouts, and refuses while another chat's live session or open terminal is nested in, contains or equals the checkout (`src/server/runtime/checkout-restore-fence.ts`). Unlike T3, a shared checkout is allowed when no other chat works in it, and a busy checkout refuses instead of waiting. |
| Side chats | 50c1c5dc53; B.8 anchors | Deferred to the client-parity phase as a tracked item. |
| Codex turn owned by an earlier run | 54d0a161bb | Assigned to the queue phase. |
| Pi cleared-queue notice | afb8619e1d | Assigned to the queue phase. |
| Usage-limit refinements | e496db3a5e, 63b0e3d82e, d7d5d7c79b | Assigned to the recovery phase. |
| Launch runtime-mode step-down and MCP read semantics | 65965f7ab8; c6ef3b46eb, 49f6cbacc4, f98ff73a1d, 9b1d351ba0 (d) | Assigned to the agent-tools phase. |
