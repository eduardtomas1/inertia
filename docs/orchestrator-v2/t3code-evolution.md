# From PR #2829 to the audited current source

The [manifest](source-manifest.json) records immutable hashes, release timestamps and selected commits. Dates in this document are UTC commit/publish dates, which can differ from the local date displayed on GitHub.

## Boundaries

| Boundary | Verified state | How to use it |
| --- | --- | --- |
| [Original PR #2829](https://github.com/pingdotgg/t3code/pull/2829) | Merged October 2 at `de343914273eceb852a1d1d739cd1d38df7796ee`; 823 commits, 1,912 changed files | Establish what the screenshots announced and inspect the actual merge tree. |
| [Stable v0.1.0](https://github.com/pingdotgg/t3code/releases/tag/v0.1.0) | Published October 15 at 23:18:08 UTC | First stable V2 and its migration/product qualifications. |
| [Stable v0.1.5](https://github.com/pingdotgg/t3code/releases/tag/v0.1.5) | Published October 29 at 13:08:50 UTC | Latest stable observed during research. |
| [Nightly v0.1.6-nightly.20261029.3892](https://github.com/pingdotgg/t3code/releases/tag/v0.1.6-nightly.20261029.3892) | Published October 29 at 18:50:30 UTC | Later release channel, still earlier than the audited main commit. |
| [Audited main](https://github.com/pingdotgg/t3code/commit/dd148481531a0a090780a2ade20588566db099a2) | October 29 at 20:43:23 UTC | Exact implementation studied, without claiming everything is in stable. |

There are 3,695 commits in the repository between the merge and this main snapshot. That is a repository-wide count, not 3,695 orchestration changes. This study inspected the current critical paths and a curated set of lifecycle changes; it did not review every intervening commit or every PR discussion.

## What was already present in the original merge

The merge tree already contains app-owned runs/attempts and provider identity mapping, normalized provider observations, provider-switch and context-transfer machinery, fork/delegation surfaces, durable queueing/recovery, and the transactional effect outbox. In particular, the outbox is not merely a later improvement: the historical architecture README still lists it as a follow-up even though implementation and persistence tests exist at the merge.

Portable handoffs at the merge already retained selected normalized command outcomes and interruption/error context. They were not just a plain concatenation of final assistant answers. Likewise, Codex's paginated revert implementation already existed at the merge despite a design page saying it was not implemented. These are documentation discrepancies, not evidence of later additions. See the [architecture study](t3code-orchestration.md) and [source map T03–T09/T17](t3code-source-map.md).

## Selected changes after the merge

The linked PRs/commits establish chronology; the pinned current code and tests establish retained behavior. Rows marked “history” were selected from commit metadata and current source rather than exhaustively reviewing every file in that PR.

| UTC date | Change | Practical consequence for an Inertia design | Evidence depth |
| --- | --- | --- | --- |
| Oct 5 | [#15219: explicit thread and project targets](https://github.com/pingdotgg/t3code/pull/15219) | Current MCP access is broader than the original project-only screenshot wording. Define authorization separately from default targeting. | Current `threadAccess` and handlers; historical change inspected. |
| Oct 6 | [#16335: declared access for every MCP tool](https://github.com/pingdotgg/t3code/pull/16335) | Central read/write/start/caller classifications make permission policy auditable; tests exercise mode races. | Current wrappers and tests; history. |
| Oct 14 | [#19102: delegated worktrees](https://github.com/pingdotgg/t3code/pull/19102) | Child execution isolation becomes a launch strategy rather than an ad hoc instruction in a prompt. | Current launch service/tests; history. |
| Oct 15 | [#19538: blocking wait exits for a child question](https://github.com/pingdotgg/t3code/pull/19538) | “Waiting” must distinguish child computation from human action required. | Current task-status/wait paths and regression tests. |
| Oct 17 | [#19751: background children retain T3 tools](https://github.com/pingdotgg/t3code/pull/19751) | Credential lifetime cannot simply equal the foreground turn lifetime. Preserve scoped ownership and explicit revocation. | Current MCP liveness checks; history. |
| Oct 18 | [#17773: queue order after a native resume](https://github.com/pingdotgg/t3code/pull/17773) | Native continuation and queued application messages must agree on ordering. | Current ordering and turn-start paths; history. |
| Oct 18 | [#20213: worktree delegation containment](https://github.com/pingdotgg/t3code/pull/20213) | A declared project does not prove that a caller's current checkout belongs to it. Validate the actual source workspace. | Current launch checks/tests; history. |
| Oct 20 | [#20306: restart-loop bounds](https://github.com/pingdotgg/t3code/pull/20306) | Durable continuation needs a bounded chain/window and a visible terminal outcome. | Current `RestartContinuation` and tests. |
| Oct 20 | [#22117: child results without history handoffs](https://github.com/pingdotgg/t3code/pull/22117) | Deliver task results through explicit notifications/messages. Do not accidentally treat them as provider-history reconstruction. | Diff and current completion-delivery tests inspected. |
| Oct 20 | [#22152: revert MCP permission approvals](https://github.com/pingdotgg/t3code/pull/22152) | The current tool surface can answer questions, not grant permission approvals. | Revert diff and current handlers inspected. |
| Oct 20 | [#21114: Stop disarms usage-limit resume](https://github.com/pingdotgg/t3code/pull/21114) | User stop intent must beat a background recovery sweep even when its candidate was read earlier. | Diff, current recovery record and guarded dispatch inspected. |
| Oct 20 | [#20025: preserve a finished parent run](https://github.com/pingdotgg/t3code/pull/20025) | A child's late completion must not rewrite the parent's historical foreground outcome. | Current completion tests; history. |
| Oct 27 | [#25610: context-exhaustion handoff recovery](https://github.com/pingdotgg/t3code/pull/25610) | Reusing a native conversation can leave no room for a handoff. Fresh-backing fallback must account for background work. | Diff and current turn-start implementation inspected. |
| Oct 27 | [#16654: launch retry key](https://github.com/pingdotgg/t3code/pull/16654) | Caller-scoped stable IDs prevent retries from creating duplicate threads/worktrees. Accepted launches replay even if a later default changed. | Diff, handlers and launch tests inspected. |
| Oct 27 | [#19229: questions survive restart](https://github.com/pingdotgg/t3code/pull/19229) | Persist how an answer is delivered. Message-mode requests can outlive a live provider RPC. | Current recovery/respond paths and changed test inventory inspected. |
| Oct 27 | [#25675: bound hung delegated stops](https://github.com/pingdotgg/t3code/pull/25675) | A failed cancellation must not permanently block subsequent admitted work. Cleanup uncertainty still needs tracking. | Current effect worker; history. |
| Oct 27 | [#25423: consolidate tool schemas](https://github.com/pingdotgg/t3code/pull/25423) | Tool breadth has a context cost; action-based tools can reduce repeated schema overhead. No need to reproduce every old tool name. | Current toolkits; history. |
| Oct 27 | [#16719: linked-environment delegation](https://github.com/pingdotgg/t3code/pull/16719) | Remote delegation is an additional routing/authority layer, not necessary for a first local Inertia phase. | Current orchestration tool service; history. |
| Oct 29 | [#26234: refresh usage after a limit](https://github.com/pingdotgg/t3code/pull/26234) | Recovery needs fresh provider telemetry rather than a stale cached quota display. | Current release/history metadata; not independently exercised. |
| Oct 29 | [#26715: Copilot follow-ups preserve background agents](https://github.com/pingdotgg/t3code/pull/26715) | Native background semantics remain provider-specific even under a common scheduler. | Current release/history metadata; not independently exercised. |
| Oct 29 | [#27098: reduce idle polling](https://github.com/pingdotgg/t3code/pull/27098) | Durable machinery still needs efficient candidate queries and wakeups; avoid a full projection scan per timer. | Pinned head and current worker/query entry points. Upstream performance numbers were not reproduced. |

The pattern is consequential: much of the post-merge work repairs interactions between features, especially completion, restart, queue ordering, input, permissions and background children. A feature checklist alone would miss the hard part of matching T3 behavior.

### 2026-10-31: `32ecd717` to `15fe2832`

The range from `32ecd71726fee16f335484c1f95cbce126d461f6` (October 30, 09:17:08 UTC) to `15fe2832727893cbdd2214383f9f971474849695` (October 31, 14:54:48 UTC) has 393 first-parent commits and includes [stable v0.1.6](https://github.com/pingdotgg/t3code/releases/tag/v0.1.6), published October 31 at 10:52:24 UTC at `2359643c`, six commits before `15fe2832`. The [delta document](t3code-delta-2026-10-31.md) lists every relevant commit with anchors and Inertia status.

- **Unchanged authoritative files:** `QueuedRunOrder`, `RunFinalizationService`, `ProviderSwitchService`, `ProviderSessionTransitionPolicy`, `NotificationMailbox`, `DelegatedTaskQuestionReactor`, `ProviderRuntimeRecoveryService`, `RestartContinuation`, `RestartBackgroundNote`, `ThreadSettlementService`, `ThreadLaunchService`, `ThreadMessageIntake`, `EffectWorker`, `EffectOutbox`, `EventSink`, `ThreadCommandExecutor`, `ProviderTurnControlService`, `RuntimeRequestService`, `CheckpointRollbackService` and `ThreadDeletion` in `apps/server/src/orchestration-v2/`; `handoffBudget.ts` and `notification.ts` in `packages/provider-core/src/server/`; the MCP access, session-registry, thread-access and delegated-task-mode modules with the orchestrator and thread toolkits; `Scheduler.ts` and `Schedule.ts`.
- **Changed authoritative files:** `ThreadForkService`, `CheckpointRestoreSafety`, `CheckpointCaptureService`, `CheckpointService`, `CommandPolicy`, `ContextHandoffService`, `ContextHandoffDelivery`, `ProviderTurnStartService`, `ThreadManagementService`, `Orchestrator`, `ProjectionStore` and `UsageLimitRecoveryWorker` in `apps/server/src/orchestration-v2/`; `OrchestratorMcpService.ts` and `toolkits/project/handlers.ts` in `apps/server/src/mcp/`; `ScheduledTaskService.ts`; `packages/provider-core/src/server/subagentProjection.ts`; new `apps/server/src/scheduling/DueHint.ts`. Of the design pages, only `orchestrator-mcp-server.md` (65965f7ab8) and `thread-lineage-and-context-transfer.md` (50c1c5dc53) changed, by two lines each.
- **Main semantic changes:** side chats as a fork flavour, native fork skipped for a busy source, inherited rows in portable fork history, a visibility filter for fork and merge-back items, one pending merge-back per target and refusal of busy merge-back targets ([#26901](https://github.com/pingdotgg/t3code/pull/26901), [#23554](https://github.com/pingdotgg/t3code/pull/23554)); Stop precedence over a late usage-limit failure and no fresh arming of resets more than 24 h overdue ([#24634](https://github.com/pingdotgg/t3code/pull/24634), [#21735](https://github.com/pingdotgg/t3code/pull/21735)); runtime-mode step-down for launched threads ([#26682](https://github.com/pingdotgg/t3code/pull/26682)); settled subagents omitted from command reads with cohort-wide completion counts and event-invalidated `DueHint` sweeps ([#27711](https://github.com/pingdotgg/t3code/pull/27711)). The last two extend, without contradicting, the #21114 and #27098 rows above.
- **Launch retry key:** the correction below still holds at `15fe2832`. The upstream page still says "Launch has no retry key" (`docs/orchestration-v2/orchestrator-mcp-server.md:369`) in a paragraph 65965f7ab8 edited, while the code derives launch ids from `clientRequestId` (`apps/server/src/mcp/toolkits/project/handlers.ts:88-94`, `apps/server/src/mcp/toolkits/project/tools.ts:152`).

## Documentation drift and reversals

| Statement one might infer | Verified correction | Primary evidence |
| --- | --- | --- |
| The durable effect outbox is still future work. | It exists in the original merge and current source. The README follow-up section is stale. | `EventSink`, `EffectOutbox`, `FoundationPersistence.test`; [T03–T04](t3code-source-map.md#t03). |
| A handoff “summary” is necessarily LLM-generated. | The audited path selects and renders intact historical items under a budget. | `handoffBudget`, `ContextHandoffService`; [T07](t3code-source-map.md#t07). |
| Portable history contains no command information at all. | Selected normalized command outcomes can be historical context. Native tool execution state, private reasoning and old attachments are different and are not faithfully transferred. This selection already existed at merge. | Current `historicalMessage` and merge `ContextHandoffBudget.ts`; [T07](t3code-source-map.md#t07). |
| Paginated Codex revert is unimplemented and legacy rollback is supported. | Current adapter rejects legacy history rollback and uses paginated `thread/turns/list` plus `thread/revert`. The implementation was already in the merge. | `CodexAdapterV2.rollbackThread`, `CodexThreadRevert`; [T17](t3code-source-map.md#t17). |
| MCP reads are always restricted to the caller's project. | Explicit targeting broadened after merge; current `readThread` resolves the target's project within the environment. Permission modes and caller scope still apply. | [#15219](https://github.com/pingdotgg/t3code/pull/15219), [T13](t3code-source-map.md#t13). |
| MCP agents can approve permission requests because #15464 landed. | That change was reverted by #22152. Current request tool admits user-input questions only. | [Revert](https://github.com/pingdotgg/t3code/pull/22152), [T12](t3code-source-map.md#t12). |
| Thread launch has no retry key, or all tools now have one. | Current launch has a caller-scoped `clientRequestId`; idempotency is operation-specific. | [#16654](https://github.com/pingdotgg/t3code/pull/16654), current project handlers. |
| A native goal or background task is one ordinary turn. | One run may span multiple native goal turns; background children may keep a workflow active after foreground completion. | Current provider constraints/adapters; [T17–T18](t3code-source-map.md#t17). |

## Remaining uncertainty

The public X fetch could not recover Maria's complete long post. All supplied screenshots and accessible pasted text were considered, but text outside those captures is not claimed as read. The [coverage map](announcement-coverage.md) records their feature groups without inventing missing bullets.

The source checkout is a dated snapshot. No live provider account, T3 desktop/mobile session, platform packaging or upstream test suite was exercised. Release metadata is separate from source verification. The [Inertia verification record](verification.md) states what was actually executed locally.

The linked-environment, new-provider and performance rows are discovery leads beyond the core local orchestration comparison. They should be researched in more depth only if selected for Inertia scope.
