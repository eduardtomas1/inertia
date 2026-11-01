# Phase 4 changed-files inventory

Snapshot: 2026-11-01T14:30:24+01:00.

Repository: `D:\MORELIFE\inertia-wt-orchestrator-v2-p4` (worktree); branch
`orchestrator-v2-p4`, rebased onto `origin/orchestrator-v2` at
`630aa2cf51d4526b112fd44913886699c42186ca`.

Lists `git diff --name-status origin/orchestrator-v2` for the final local
staging commit, including this inventory; no untracked files remain. Ignored
artifacts such as `out/` and `test-results/` are excluded.

**167 files: 96 modified and 71 added.**

Results and remaining limits are recorded in
[implementation-progress.md](../../orchestrator-v2/implementation-progress.md#phase-4-managed-delegation-durable-parent-wakes-observed-native-children--2026-11-01)
and [phase4-verification.md](../../orchestrator-v2/phase4-verification.md).

## Documentation and evidence

Phase 4 verification, the progress entries (Phase 4 and the rebase with its deferred hooks and full gate), the two checklist items and ownership note in the plan, bundle accounting including `phase4Final`, this inventory and sixteen desktop captures from the Electron run.

| Status | Repository-relative path |
| --- | --- |
| Modified | `docs/orchestrator-v2/implementation-plan.md` |
| Modified | `docs/orchestrator-v2/implementation-progress.md` |
| Added | `docs/orchestrator-v2/phase4-verification.md` |
| Modified | `docs/pr-evidence/orchestrator-v2/changed-files.md` |
| Modified | `docs/pr-evidence/orchestrator-v2/renderer-bundle.json` |
| Added | `docs/pr-evidence/orchestrator-v2/screenshots/delegation-approval-dark.png` |
| Added | `docs/pr-evidence/orchestrator-v2/screenshots/delegation-approval-light.png` |
| Added | `docs/pr-evidence/orchestrator-v2/screenshots/delegation-completion-card-dark.png` |
| Added | `docs/pr-evidence/orchestrator-v2/screenshots/delegation-completion-card-light.png` |
| Added | `docs/pr-evidence/orchestrator-v2/screenshots/delegation-panel-running-delivered-dark.png` |
| Added | `docs/pr-evidence/orchestrator-v2/screenshots/delegation-panel-running-delivered-light.png` |
| Added | `docs/pr-evidence/orchestrator-v2/screenshots/delegation-queue-pinned-dark.png` |
| Added | `docs/pr-evidence/orchestrator-v2/screenshots/delegation-queue-pinned-light.png` |
| Added | `docs/pr-evidence/orchestrator-v2/screenshots/delegation-restart-held-dark.png` |
| Added | `docs/pr-evidence/orchestrator-v2/screenshots/delegation-restart-held-light.png` |
| Added | `docs/pr-evidence/orchestrator-v2/screenshots/delegation-settings-toggle-dark.png` |
| Added | `docs/pr-evidence/orchestrator-v2/screenshots/delegation-settings-toggle-light.png` |
| Added | `docs/pr-evidence/orchestrator-v2/screenshots/delegation-stop-dismissed-dark.png` |
| Added | `docs/pr-evidence/orchestrator-v2/screenshots/delegation-stop-dismissed-light.png` |
| Added | `docs/pr-evidence/orchestrator-v2/screenshots/observed-child-panel-dark.png` |
| Added | `docs/pr-evidence/orchestrator-v2/screenshots/observed-child-panel-light.png` |

## Build and migration lineage

Lineage entries for migrations 111 and 112 and the renderer budgets (Phase 4 caps, the streaming-fix core raise and the rebased core re-cap). `resources/generated/windows-runtime-job-integrity.json`, rewritten by the Windows `prebuild:bundle` step, was restored with `git checkout` and is not part of the change.

| Status | Repository-relative path |
| --- | --- |
| Modified | `database-migration-lineage.json` |
| Modified | `scripts/check-renderer-bundle.mjs` |

## Renderer

Delegated work panel and child breadcrumb, completion card, pinned Delegated results queue row with Send now when idle, Agent details on the agents line, the automatic-wakes switch, command policies, timeline wiring and the streaming detail-refresh fix.

| Status | Repository-relative path |
| --- | --- |
| Modified | `src/renderer/src/components/ChatWorkspace.tsx` |
| Modified | `src/renderer/src/components/GoalPanel.tsx` |
| Modified | `src/renderer/src/components/SubagentTraceDetails.tsx` |
| Modified | `src/renderer/src/components/composer/RuntimeComposerQueuedActions.tsx` |
| Added | `src/renderer/src/components/orchestration/delegated-completion-card.tsx` |
| Added | `src/renderer/src/components/orchestration/delegation-model.ts` |
| Added | `src/renderer/src/components/orchestration/delegation-panel.css` |
| Added | `src/renderer/src/components/orchestration/delegation-panel.tsx` |
| Added | `src/renderer/src/components/orchestration/delegation-surface.tsx` |
| Added | `src/renderer/src/components/orchestration/observed-child-view.tsx` |
| Modified | `src/renderer/src/components/response-timeline/TurnAgentsLine.tsx` |
| Modified | `src/renderer/src/components/response-timeline/activity.tsx` |
| Modified | `src/renderer/src/components/response-timeline/layers.tsx` |
| Modified | `src/renderer/src/components/response-timeline/row-label.ts` |
| Modified | `src/renderer/src/components/response-timeline/turn.tsx` |
| Modified | `src/renderer/src/components/settings/sections/ChatsSettings.tsx` |
| Modified | `src/renderer/src/components/settingsRows.ts` |
| Modified | `src/renderer/src/components/workspace-scene/createWorkspaceSceneModel.ts` |
| Modified | `src/renderer/src/lib/runtimeCommands.ts` |
| Modified | `src/renderer/src/utils/response-timeline/execution.ts` |
| Modified | `src/renderer/src/utils/response-timeline/virtualization.ts` |
| Modified | `src/renderer/src/utils/runtimeCommandPolicy.ts` |

## Durable orchestration and persistence

Delegation events, projector, repository, reads, planner, wake text and recovery; the observed child projection; migrations 111 and 112; queued delivery rows, message attribution and the automatic-wakes setting; the effect wake, capture emission, start barrier and passing claims; portable handoffs without the aggregate files block.

| Status | Repository-relative path |
| --- | --- |
| Modified | `src/server/database.ts` |
| Added | `src/server/orchestration-v2/delegation-delivery-planner.ts` |
| Added | `src/server/orchestration-v2/delegation-projector.ts` |
| Added | `src/server/orchestration-v2/delegation-reads.ts` |
| Added | `src/server/orchestration-v2/delegation-recovery.ts` |
| Added | `src/server/orchestration-v2/delegation-repository.ts` |
| Added | `src/server/orchestration-v2/delegation-text.ts` |
| Modified | `src/server/orchestration-v2/effect-outbox.ts` |
| Modified | `src/server/orchestration-v2/effect-runtime.ts` |
| Modified | `src/server/orchestration-v2/event-store.ts` |
| Modified | `src/server/orchestration-v2/native-control-repository.ts` |
| Added | `src/server/orchestration-v2/observed-child-projection.ts` |
| Modified | `src/server/orchestration-v2/portable-history-source.ts` |
| Modified | `src/server/orchestration-v2/projector.ts` |
| Modified | `src/server/orchestration-v2/turn-repository.ts` |
| Modified | `src/server/persistence/agent-thread-management-repository.ts` |
| Modified | `src/server/persistence/codecs.ts` |
| Modified | `src/server/persistence/database-recovery-required-tables.ts` |
| Modified | `src/server/persistence/migrations/catalog.ts` |
| Added | `src/server/persistence/migrations/delegated-tasks.ts` |
| Added | `src/server/persistence/migrations/delegation-automatic-wakes.ts` |
| Modified | `src/server/persistence/migrations/recent-migrations.ts` |
| Added | `src/server/persistence/observed-child-repository.ts` |
| Modified | `src/server/persistence/queued-message-repository.ts` |
| Modified | `src/server/persistence/rows.ts` |
| Modified | `src/server/persistence/settings-repository.ts` |
| Modified | `src/server/persistence/snapshot-repository.ts` |
| Modified | `src/server/persistence/stream-text-storage.ts` |
| Modified | `src/server/persistence/transcript-repository.ts` |
| Modified | `src/server/persistence/turn-ledger-repository.ts` |
| Modified | `src/server/persistence/types.ts` |

## Runtime, commands and host tools

Delegation host tools, task service, wait and view; queue dispatch, steering and boot recovery; delegation and observed-child commands; settings, limit-reset and continuation settlement hooks; Private Connect stripping; the capture executor, effect runtime shutdown, deferred start and retrieval attestation.

| Status | Repository-relative path |
| --- | --- |
| Modified | `src/server/index.ts` |
| Modified | `src/server/private-connect/store-detail.ts` |
| Modified | `src/server/runtime-startup-recovery.ts` |
| Modified | `src/server/runtime/agent-thread-manager.ts` |
| Modified | `src/server/runtime/agent-thread-runtime.ts` |
| Added | `src/server/runtime/agent-thread-schemas.ts` |
| Added | `src/server/runtime/checkpoint-capture-executor.ts` |
| Modified | `src/server/runtime/commands/conversation-commands.ts` |
| Added | `src/server/runtime/commands/delegation-commands.ts` |
| Added | `src/server/runtime/commands/observed-child-commands.ts` |
| Modified | `src/server/runtime/commands/runtime-command-handlers.ts` |
| Modified | `src/server/runtime/commands/settings-backend-commands.ts` |
| Modified | `src/server/runtime/commands/turn-interaction-commands.ts` |
| Added | `src/server/runtime/delegation/delegation-runtime.ts` |
| Added | `src/server/runtime/delegation/delivery-instruction.ts` |
| Added | `src/server/runtime/delegation/task-service.ts` |
| Added | `src/server/runtime/delegation/task-tools.ts` |
| Added | `src/server/runtime/delegation/task-view.ts` |
| Added | `src/server/runtime/delegation/task-wait.ts` |
| Modified | `src/server/runtime/detached-chat-runtime-policy.ts` |
| Modified | `src/server/runtime/detached-chat-runtime-security.ts` |
| Modified | `src/server/runtime/inertia-harness-capabilities.ts` |
| Modified | `src/server/runtime/queued-message-runtime.ts` |
| Modified | `src/server/runtime/restart-continuation-scheduler.ts` |
| Added | `src/server/runtime/scheduled-plan-settlements.ts` |
| Modified | `src/server/runtime/turns/turn-controller-support.ts` |
| Modified | `src/server/runtime/turns/turn-controller-types.ts` |
| Modified | `src/server/runtime/turns/turn-controller.ts` |
| Modified | `src/server/runtime/turns/turn-follow-up-coordinator.ts` |
| Modified | `src/server/runtime/turns/turn-request-preparation.ts` |
| Modified | `src/server/usage/limit-reset-scheduler.ts` |

## Shared contracts

Delegation and observed-child contracts, client commands, detail and event schemas, queued-message attribution, the automatic-wakes setting and host-tool approval identities in `agent.approval.respond`.

| Status | Repository-relative path |
| --- | --- |
| Modified | `src/shared/contracts/agent.ts` |
| Modified | `src/shared/contracts/app.ts` |
| Modified | `src/shared/contracts/chat-message-schema.ts` |
| Modified | `src/shared/contracts/client-command/agent.ts` |
| Modified | `src/shared/contracts/client-command/app.ts` |
| Added | `src/shared/contracts/client-command/delegation.ts` |
| Modified | `src/shared/contracts/client-command/index.ts` |
| Added | `src/shared/contracts/client-command/observed-children.ts` |
| Modified | `src/shared/contracts/conversation-detail.ts` |
| Modified | `src/shared/contracts/events.ts` |
| Modified | `src/shared/contracts/server-event-schema.ts` |
| Added | `src/shared/observed-child-thread.ts` |
| Added | `src/shared/orchestration-delegation.ts` |
| Modified | `src/shared/orchestration-v2.ts` |
| Modified | `src/shared/queued-messages.ts` |
| Modified | `src/shared/restore-defaults.ts` |

## Tests

Server, migration, renderer DOM, contract and Electron coverage for the package; the capture effect, attestation and per-turn file-change cases; updated expectations in existing migration, fixture, handoff, continuity and query plan tests; command test stubs given the upstream `conversationWork` dependency.

| Status | Repository-relative path |
| --- | --- |
| Modified | `tests/contracts.test.ts` |
| Added | `tests/e2e/delegation-wake.spec.ts` |
| Modified | `tests/fixtures/agent-surface-budget.json` |
| Modified | `tests/renderer/conversation-detail.test.ts` |
| Added | `tests/renderer/delegated-completion-card.dom.test.tsx` |
| Added | `tests/renderer/delegation-automatic-wakes-settings.dom.test.tsx` |
| Added | `tests/renderer/delegation-fixtures.ts` |
| Added | `tests/renderer/delegation-panel.dom.test.tsx` |
| Added | `tests/renderer/observed-child-view.dom.test.tsx` |
| Modified | `tests/renderer/runtime-composer-queue.dom.test.tsx` |
| Added | `tests/renderer/streaming-detail-refresh.dom.test.tsx` |
| Modified | `tests/server/__snapshots__/runtime-query-plans.test.ts.snap` |
| Added | `tests/server/agent-thread-delegation.test.ts` |
| Modified | `tests/server/compact-and-send-command.test.ts` |
| Modified | `tests/server/conversation-context-v3.test.ts` |
| Modified | `tests/server/database-migration-lineage.test.ts` |
| Modified | `tests/server/database-migrations.test.ts` |
| Modified | `tests/server/database-recovery-schema-columns.test.ts` |
| Added | `tests/server/delegated-tasks-migration.test.ts` |
| Added | `tests/server/delegation-boot-order.test.ts` |
| Added | `tests/server/delegation-cancel.test.ts` |
| Added | `tests/server/delegation-command-policy.test.ts` |
| Added | `tests/server/delegation-holds.test.ts` |
| Added | `tests/server/delegation-queue.test.ts` |
| Added | `tests/server/delegation-wait.test.ts` |
| Modified | `tests/server/duo-comparison-briefs-migration.test.ts` |
| Added | `tests/server/observed-child-projection.test.ts` |
| Added | `tests/server/observed-child-stop.test.ts` |
| Modified | `tests/server/orchestration-backings.test.ts` |
| Added | `tests/server/orchestration-delegation-core.test.ts` |
| Added | `tests/server/orchestration-delegation-delivery.test.ts` |
| Added | `tests/server/orchestration-delegation-recovery.test.ts` |
| Modified | `tests/server/orchestration-history-rollback.test.ts` |
| Modified | `tests/server/orchestration-v2-outbox.test.ts` |
| Modified | `tests/server/private-connect/message-origin.test.ts` |
| Modified | `tests/server/provider-handoff-continuation.test.ts` |
| Modified | `tests/server/session-continuity.test.ts` |
| Modified | `tests/server/turn-interaction-commands.test.ts` |
| Modified | `tests/server/turn-scoped-indexes-migration.test.ts` |
| Modified | `tests/server/watcher-link-migration.test.ts` |
| Added | `tests/support/delegation-fixture.ts` |
| Added | `tests/support/delegation-manager-fixture.ts` |
| Added | `tests/support/delegation-queue-fixture.ts` |
| Modified | `tests/support/legacy-project-settings-schema.ts` |
