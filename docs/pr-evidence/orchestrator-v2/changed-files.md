# Phase 3 polish changed-files inventory

Snapshot: 2026-10-31T19:25:28+01:00.

Repository: `D:\MORELIFE\inertia-wt-orchestrator-v2-p3` (worktree); branch
`orchestrator-v2-p3`; baseline HEAD `52315e95067439138dd516bcfe8283d4f8343551`
(PR #686 with Phase 0 stabilization).

Includes the union of `git diff --name-only HEAD` (index and working-tree
changes) and `git ls-files --others --exclude-standard` (individual untracked
files), including this inventory. Ignored artifacts such as `out/` and
`test-results/`, and changes already committed at HEAD, are excluded.

**70 files: 57 tracked changes and 13 untracked additions.**

Results and remaining limits are recorded in
[implementation-progress.md](../../orchestrator-v2/implementation-progress.md#phase-3-polish--2026-10-31)
and [phase3-verification.md](../../orchestrator-v2/phase3-verification.md#phase-3-polish-evidence).

## Documentation and evidence

Polish checkpoint and verification, T3 recomparison at `15fe2832`, bundle accounting, this inventory and fourteen desktop captures from the verified Electron run.

| Status | Repository-relative path |
| --- | --- |
| Tracked change | `docs/orchestrator-v2/README.md` |
| Tracked change | `docs/orchestrator-v2/implementation-plan.md` |
| Tracked change | `docs/orchestrator-v2/implementation-progress.md` |
| Tracked change | `docs/orchestrator-v2/phase3-verification.md` |
| Tracked change | `docs/orchestrator-v2/source-manifest.json` |
| Untracked addition | `docs/orchestrator-v2/t3code-delta-2026-10-31.md` |
| Tracked change | `docs/orchestrator-v2/t3code-evolution.md` |
| Tracked change | `docs/orchestrator-v2/t3code-orchestration.md` |
| Tracked change | `docs/pr-evidence/orchestrator-v2/changed-files.md` |
| Tracked change | `docs/pr-evidence/orchestrator-v2/renderer-bundle.json` |
| Untracked addition | `docs/pr-evidence/orchestrator-v2/screenshots/fork-merge-up-to-here-dark.png` |
| Untracked addition | `docs/pr-evidence/orchestrator-v2/screenshots/fork-merge-up-to-here-light.png` |
| Tracked change | `docs/pr-evidence/orchestrator-v2/screenshots/merge-back-confirmation-dark.png` |
| Tracked change | `docs/pr-evidence/orchestrator-v2/screenshots/merge-back-confirmation-light.png` |
| Tracked change | `docs/pr-evidence/orchestrator-v2/screenshots/merge-back-source-draft-dark.png` |
| Tracked change | `docs/pr-evidence/orchestrator-v2/screenshots/merge-back-source-draft-light.png` |
| Untracked addition | `docs/pr-evidence/orchestrator-v2/screenshots/rollback-chat-start-confirmation-dark.png` |
| Untracked addition | `docs/pr-evidence/orchestrator-v2/screenshots/rollback-chat-start-confirmation-light.png` |
| Tracked change | `docs/pr-evidence/orchestrator-v2/screenshots/rollback-confirmation-dark.png` |
| Tracked change | `docs/pr-evidence/orchestrator-v2/screenshots/rollback-confirmation-light.png` |
| Untracked addition | `docs/pr-evidence/orchestrator-v2/screenshots/rollback-files-confirmation-dark.png` |
| Untracked addition | `docs/pr-evidence/orchestrator-v2/screenshots/rollback-files-confirmation-light.png` |
| Tracked change | `docs/pr-evidence/orchestrator-v2/screenshots/rollback-retained-turn-dark.png` |
| Tracked change | `docs/pr-evidence/orchestrator-v2/screenshots/rollback-retained-turn-light.png` |

## Build, migration lineage and generated resources

Appended lineage entry for migration 110 and the two raised renderer budgets. `windows-runtime-job-integrity.json` was rewritten by the Windows `prebuild:bundle` step (the committed value is `null`); it is a local build output, not part of the package.

| Status | Repository-relative path |
| --- | --- |
| Tracked change | `database-migration-lineage.json` |
| Tracked change | `resources/generated/windows-runtime-job-integrity.json` |
| Tracked change | `scripts/check-renderer-bundle.mjs` |

## Renderer history controls and timeline

Rollback with opt-in file restore, rollback to the chat start, merge-up-to-here, attributed recovery checkpoint actions and omitted-command lines in context previews.

| Status | Repository-relative path |
| --- | --- |
| Tracked change | `src/renderer/src/components/ChatWorkspace.tsx` |
| Tracked change | `src/renderer/src/components/ConversationActionsMenu.tsx` |
| Tracked change | `src/renderer/src/components/composer/ComposerConversationContextCards.tsx` |
| Tracked change | `src/renderer/src/components/orchestration/fork-history-view.tsx` |
| Tracked change | `src/renderer/src/components/orchestration/fork-surface-model.ts` |
| Tracked change | `src/renderer/src/components/orchestration/fork-surface.tsx` |
| Untracked addition | `src/renderer/src/components/orchestration/history-actions.css` |
| Tracked change | `src/renderer/src/components/orchestration/history-actions.tsx` |
| Untracked addition | `src/renderer/src/components/orchestration/history-session.ts` |
| Tracked change | `src/renderer/src/components/response-timeline/layers.tsx` |
| Tracked change | `src/renderer/src/utils/response-timeline/model.ts` |
| Tracked change | `src/renderer/src/utils/response-timeline/virtualization.ts` |

## Durable orchestration and persistence

Cross-fork merge-back exclusivity, explicit source point, work summary in the packet supplement, migration 110, rollback file-restore outcomes and per-thread native-control command identities.

| Status | Repository-relative path |
| --- | --- |
| Tracked change | `src/server/orchestration-v2/history-projector.ts` |
| Tracked change | `src/server/orchestration-v2/history-rollback-repository.ts` |
| Tracked change | `src/server/orchestration-v2/merge-back-repository.ts` |
| Tracked change | `src/server/orchestration-v2/native-control-repository.ts` |
| Tracked change | `src/server/orchestration-v2/projector.ts` |
| Tracked change | `src/server/persistence/conversation-context-format.ts` |
| Tracked change | `src/server/persistence/conversation-context-packet-codec.ts` |
| Tracked change | `src/server/persistence/conversation-context-packet-repository.ts` |
| Tracked change | `src/server/persistence/migrations/catalog.ts` |
| Untracked addition | `src/server/persistence/migrations/conversation-context-supplement-bound.ts` |
| Tracked change | `src/server/persistence/migrations/recent-migrations.ts` |

## Runtime commands and file restore

Combined rollback and file restore orchestration, restore-safety refusals, attributed recovery checkpoints and the merge-back source point command.

| Status | Repository-relative path |
| --- | --- |
| Tracked change | `src/server/runtime/checkpoint-restoration.ts` |
| Tracked change | `src/server/runtime/commands/conversation-commands.ts` |
| Tracked change | `src/server/runtime/history-rollback-service.ts` |
| Untracked addition | `src/server/runtime/rollback-file-restore.ts` |

## Shared contracts

Merge-back source point and summary, rollback file outcomes and the context supplement's omitted counts.

| Status | Repository-relative path |
| --- | --- |
| Tracked change | `src/shared/contracts/client-command/forks.ts` |
| Tracked change | `src/shared/conversation-context.ts` |
| Tracked change | `src/shared/orchestration-history.ts` |
| Tracked change | `src/shared/orchestration-merge-back.ts` |

## Tests

Server, migration, renderer DOM and Electron coverage for the package, plus the Windows store-closing fix in `orchestration-v2.test.ts`.

| Status | Repository-relative path |
| --- | --- |
| Tracked change | `tests/e2e/history-rollback-merge-back.spec.ts` |
| Tracked change | `tests/renderer/checkpoint-notice.dom.test.tsx` |
| Tracked change | `tests/renderer/composer-chat-references.dom.test.tsx` |
| Tracked change | `tests/renderer/fork-surface.dom.test.tsx` |
| Tracked change | `tests/renderer/history-actions.dom.test.tsx` |
| Tracked change | `tests/renderer/response-timeline.test.ts` |
| Untracked addition | `tests/server/conversation-context-supplement-migration.test.ts` |
| Tracked change | `tests/server/database-migrations.test.ts` |
| Tracked change | `tests/server/orchestration-merge-back.test.ts` |
| Tracked change | `tests/server/orchestration-native-forks.test.ts` |
| Untracked addition | `tests/server/orchestration-rollback-restore.test.ts` |
| Tracked change | `tests/server/orchestration-v2.test.ts` |
