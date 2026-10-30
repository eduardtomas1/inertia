# Phase 3 changed-files inventory

Snapshot: 2026-10-30T12:34:08+01:00.

Repository: `/home/etomas/Documentos/TMP1/inertia-orchestrator-v2`; branch
`orchestrator-v2`; baseline HEAD `e6189b9b7be91b0aad4f917c81f38c425985e8e5`.

Includes the union of `git diff --name-only HEAD` (index and working-tree
changes) and `git ls-files --others --exclude-standard` (individual untracked
files), including this inventory. Ignored artifacts and historical changes
already committed at HEAD are excluded. The inventory was rechecked at the user-requested stop; the file set is unchanged.

**166 files: 85 tracked changes and 81 untracked additions.**

Results, review disposition and remaining verification are recorded in
[phase3-verification.md](../../orchestrator-v2/phase3-verification.md).

## Documentation and evidence

Checkpoint, scope/progress, license provenance, measured bundle accounting and nine desktop captures.

| Status | Repository-relative path |
| --- | --- |
| Untracked addition | `docs/orchestrator-v2/cursor-sdk-license-evidence.md` |
| Untracked addition | `docs/orchestrator-v2/cursor-sdk-ui-progress.md` |
| Tracked change | `docs/orchestrator-v2/implementation-plan.md` |
| Tracked change | `docs/orchestrator-v2/implementation-progress.md` |
| Untracked addition | `docs/orchestrator-v2/phase3-verification.md` |
| Tracked change | `docs/orchestrator-v2/provider-implementation-progress.md` |
| Tracked change | `docs/orchestrator-v2/provider-integration-seams.md` |
| Untracked addition | `docs/pr-evidence/orchestrator-v2/changed-files.md` |
| Untracked addition | `docs/pr-evidence/orchestrator-v2/renderer-bundle.json` |
| Untracked addition | `docs/pr-evidence/orchestrator-v2/screenshots/cursor-sdk-account.png` |
| Untracked addition | `docs/pr-evidence/orchestrator-v2/screenshots/merge-back-confirmation-dark.png` |
| Untracked addition | `docs/pr-evidence/orchestrator-v2/screenshots/merge-back-confirmation-light.png` |
| Untracked addition | `docs/pr-evidence/orchestrator-v2/screenshots/merge-back-source-draft-dark.png` |
| Untracked addition | `docs/pr-evidence/orchestrator-v2/screenshots/merge-back-source-draft-light.png` |
| Untracked addition | `docs/pr-evidence/orchestrator-v2/screenshots/rollback-confirmation-dark.png` |
| Untracked addition | `docs/pr-evidence/orchestrator-v2/screenshots/rollback-confirmation-light.png` |
| Untracked addition | `docs/pr-evidence/orchestrator-v2/screenshots/rollback-retained-turn-dark.png` |
| Untracked addition | `docs/pr-evidence/orchestrator-v2/screenshots/rollback-retained-turn-light.png` |

## Build, packaging, migration lineage and verification configuration

SDK worker entry/unpacking, append-only migration lineage, explicit measured bundle allocations and portable test registration.

| Status | Repository-relative path |
| --- | --- |
| Tracked change | `database-migration-lineage.json` |
| Tracked change | `electron.vite.config.ts` |
| Tracked change | `package.json` |
| Tracked change | `scripts/check-renderer-bundle.mjs` |
| Tracked change | `scripts/ci/portable-test-manifest.mjs` |

## Node-only SDK boundaries

Private worker channel, login, models and protocol contracts.

| Status | Repository-relative path |
| --- | --- |
| Untracked addition | `src/node/cursor-sdk-channel.ts` |
| Untracked addition | `src/node/cursor-sdk-login.ts` |
| Untracked addition | `src/node/cursor-sdk-models.ts` |
| Untracked addition | `src/node/cursor-sdk-protocol.ts` |

## Renderer integration and history controls

SDK account/catalogue routes, lazy chooser and history surfaces, rollback markers and runtime-command policy.

| Status | Repository-relative path |
| --- | --- |
| Tracked change | `src/renderer/src/App.tsx` |
| Tracked change | `src/renderer/src/components/ChatWorkspace.tsx` |
| Tracked change | `src/renderer/src/components/ModelBackendsSettings.tsx` |
| Tracked change | `src/renderer/src/components/ModelChooser.tsx` |
| Untracked addition | `src/renderer/src/components/ModelChooserLoaded.tsx` |
| Untracked addition | `src/renderer/src/components/cursor-sdk/CursorSdkAccount.css` |
| Untracked addition | `src/renderer/src/components/cursor-sdk/CursorSdkAccount.tsx` |
| Untracked addition | `src/renderer/src/components/cursor-sdk/CursorSdkContext.ts` |
| Untracked addition | `src/renderer/src/components/cursor-sdk/CursorSdkEntry.tsx` |
| Untracked addition | `src/renderer/src/components/cursor-sdk/CursorSdkModels.tsx` |
| Untracked addition | `src/renderer/src/components/cursor-sdk/cursorSdkModelRoute.ts` |
| Untracked addition | `src/renderer/src/components/cursor-sdk/useCursorSdkAccount.ts` |
| Untracked addition | `src/renderer/src/components/orchestration/fork-history-view.tsx` |
| Untracked addition | `src/renderer/src/components/orchestration/fork-surface-model.ts` |
| Tracked change | `src/renderer/src/components/orchestration/fork-surface.css` |
| Tracked change | `src/renderer/src/components/orchestration/fork-surface.tsx` |
| Untracked addition | `src/renderer/src/components/orchestration/history-actions.tsx` |
| Tracked change | `src/renderer/src/components/response-timeline/turn.tsx` |
| Tracked change | `src/renderer/src/components/workspace-scene/createWorkspaceSceneModel.ts` |
| Tracked change | `src/renderer/src/utils/conversationHistory.ts` |
| Tracked change | `src/renderer/src/utils/modelChooserRoutes.ts` |
| Tracked change | `src/renderer/src/utils/runtimeCommandPolicy.ts` |

## Durable orchestration and persistence

History rollback, merge-back receipts/projections, backing/native-control state, thread registration and SDK provider migration.

| Status | Repository-relative path |
| --- | --- |
| Tracked change | `src/server/orchestration-v2/backing-projector.ts` |
| Tracked change | `src/server/orchestration-v2/backing-repository.ts` |
| Tracked change | `src/server/orchestration-v2/fork-history.ts` |
| Tracked change | `src/server/orchestration-v2/fork-repository.ts` |
| Untracked addition | `src/server/orchestration-v2/history-projector.ts` |
| Untracked addition | `src/server/orchestration-v2/history-rollback-repository.ts` |
| Untracked addition | `src/server/orchestration-v2/merge-back-projector.ts` |
| Untracked addition | `src/server/orchestration-v2/merge-back-repository.ts` |
| Tracked change | `src/server/orchestration-v2/native-control-projector.ts` |
| Tracked change | `src/server/orchestration-v2/native-control-repository.ts` |
| Tracked change | `src/server/orchestration-v2/portable-history-source.ts` |
| Tracked change | `src/server/orchestration-v2/projector.ts` |
| Untracked addition | `src/server/orchestration-v2/thread-registration.ts` |
| Tracked change | `src/server/orchestration-v2/turn-repository.ts` |
| Tracked change | `src/server/persistence/migrations/catalog.ts` |
| Untracked addition | `src/server/persistence/migrations/cursor-sdk-provider.ts` |
| Tracked change | `src/server/persistence/migrations/recent-migrations.ts` |
| Tracked change | `src/server/persistence/snapshot-repository.ts` |
| Tracked change | `src/server/persistence/types.ts` |

## Provider runtime and SDK storage

SDK supervision, loader, host tools, admission/cleanup, journal store and harness/capability/continuation integration.

| Status | Repository-relative path |
| --- | --- |
| Tracked change | `src/server/provider/agent-harness-registry.ts` |
| Tracked change | `src/server/provider/agent-harness.ts` |
| Tracked change | `src/server/provider/capability-manifest.ts` |
| Tracked change | `src/server/provider/contracts.ts` |
| Untracked addition | `src/server/provider/cursor-sdk-controller.ts` |
| Untracked addition | `src/server/provider/cursor-sdk-harness.ts` |
| Untracked addition | `src/server/provider/cursor-sdk-host-tools.ts` |
| Untracked addition | `src/server/provider/cursor-sdk-installation.ts` |
| Untracked addition | `src/server/provider/cursor-sdk-loader.ts` |
| Untracked addition | `src/server/provider/cursor-sdk-process.ts` |
| Untracked addition | `src/server/provider/cursor-sdk-service.ts` |
| Untracked addition | `src/server/provider/cursor-sdk-session.ts` |
| Untracked addition | `src/server/provider/cursor-sdk-store-records.ts` |
| Untracked addition | `src/server/provider/cursor-sdk-store.ts` |
| Untracked addition | `src/server/provider/cursor-sdk-worker.ts` |
| Tracked change | `src/server/provider/fresh-session-fallback.ts` |
| Tracked change | `src/server/provider/provider-capability-authority.ts` |
| Untracked addition | `src/server/provider/provider-run-installation.ts` |
| Tracked change | `src/server/provider/run-coordinator.ts` |
| Tracked change | `src/server/provider/watcher-harness-profile.ts` |
| Tracked change | `src/server/providers.ts` |

## Runtime command and turn wiring

Command handler extraction, account/login operations, command lanes, rollback service and continuation transport.

| Status | Repository-relative path |
| --- | --- |
| Tracked change | `src/server/index.ts` |
| Tracked change | `src/server/runtime/commands/conversation-commands.ts` |
| Untracked addition | `src/server/runtime/commands/cursor-sdk-account-probes.ts` |
| Untracked addition | `src/server/runtime/commands/cursor-sdk-login-commands.ts` |
| Tracked change | `src/server/runtime/commands/project-workspace-commands.ts` |
| Untracked addition | `src/server/runtime/commands/runtime-command-handlers.ts` |
| Tracked change | `src/server/runtime/conversation-context-service.ts` |
| Tracked change | `src/server/runtime/fork-session-service.ts` |
| Untracked addition | `src/server/runtime/history-rollback-service.ts` |
| Tracked change | `src/server/runtime/turns/turn-fresh-session-fallback.ts` |
| Tracked change | `src/server/runtime/turns/turn-provider-event-projector.ts` |
| Tracked change | `src/server/runtime/turns/turn-request-preparation.ts` |

## Shared contracts

Validated SDK authentication/models, history/merge-back and provider/backing/native-control contracts.

| Status | Repository-relative path |
| --- | --- |
| Untracked addition | `src/shared/contracts/client-command/cursor-sdk.ts` |
| Tracked change | `src/shared/contracts/client-command/forks.ts` |
| Tracked change | `src/shared/contracts/client-command/index.ts` |
| Tracked change | `src/shared/contracts/conversation-detail.ts` |
| Untracked addition | `src/shared/contracts/cursor-sdk-auth-schema.ts` |
| Tracked change | `src/shared/contracts/events.ts` |
| Tracked change | `src/shared/contracts/server-event-schema.ts` |
| Untracked addition | `src/shared/cursor-sdk-auth.ts` |
| Untracked addition | `src/shared/cursor-sdk-models.ts` |
| Tracked change | `src/shared/model-routing.ts` |
| Tracked change | `src/shared/orchestration-backings.ts` |
| Untracked addition | `src/shared/orchestration-history.ts` |
| Untracked addition | `src/shared/orchestration-merge-back.ts` |
| Tracked change | `src/shared/orchestration-native-control.ts` |
| Tracked change | `src/shared/orchestration-v2.ts` |
| Tracked change | `src/shared/provider.ts` |

## Tests, fixtures and support

Focused SDK/history/renderer coverage; continuity, migration, Duo, query-plan and tool-budget corrections; Electron resource policy.

| Status | Repository-relative path |
| --- | --- |
| Untracked addition | `tests/e2e/history-rollback-merge-back.spec.ts` |
| Tracked change | `tests/e2e/provider-settings-visual.spec.ts` |
| Tracked change | `tests/fixtures/agent-surface-budget.json` |
| Untracked addition | `tests/main/cursor-sdk-login.test.ts` |
| Tracked change | `tests/main/e2e-resource-policy.test.ts` |
| Tracked change | `tests/renderer/accessibility-focus-policy.dom.test.tsx` |
| Tracked change | `tests/renderer/composer-ownership.dom.test.tsx` |
| Untracked addition | `tests/renderer/cursor-sdk-account.dom.test.tsx` |
| Untracked addition | `tests/renderer/cursor-sdk-model-route.test.ts` |
| Untracked addition | `tests/renderer/cursor-sdk-models.dom.test.tsx` |
| Untracked addition | `tests/renderer/history-actions.dom.test.tsx` |
| Untracked addition | `tests/renderer/model-chooser-lazy.dom.test.tsx` |
| Tracked change | `tests/renderer/model-chooser.dom.test.tsx` |
| Tracked change | `tests/renderer/model-chooser.test.ts` |
| Tracked change | `tests/renderer/multi-spawn.dom.test.tsx` |
| Tracked change | `tests/renderer/native-preview-suspension.dom.test.tsx` |
| Tracked change | `tests/server/__snapshots__/runtime-query-plans.test.ts.snap` |
| Tracked change | `tests/server/conversation-context-v3.test.ts` |
| Untracked addition | `tests/server/cursor-sdk-channel.test.ts` |
| Untracked addition | `tests/server/cursor-sdk-controller.test.ts` |
| Untracked addition | `tests/server/cursor-sdk-harness.test.ts` |
| Untracked addition | `tests/server/cursor-sdk-host-tools.test.ts` |
| Untracked addition | `tests/server/cursor-sdk-login-commands.test.ts` |
| Untracked addition | `tests/server/cursor-sdk-migration.test.ts` |
| Untracked addition | `tests/server/cursor-sdk-models.test.ts` |
| Untracked addition | `tests/server/cursor-sdk-packaging.test.ts` |
| Untracked addition | `tests/server/cursor-sdk-process.test.ts` |
| Untracked addition | `tests/server/cursor-sdk-service.test.ts` |
| Untracked addition | `tests/server/cursor-sdk-session.test.ts` |
| Untracked addition | `tests/server/cursor-sdk-store.test.ts` |
| Tracked change | `tests/server/database-migration-lineage.test.ts` |
| Tracked change | `tests/server/database-migrations.test.ts` |
| Tracked change | `tests/server/duo-deletion-commands.test.ts` |
| Tracked change | `tests/server/duo-inactive-recovery.test.ts` |
| Untracked addition | `tests/server/orchestration-history-backing-limit.test.ts` |
| Untracked addition | `tests/server/orchestration-history-pages.test.ts` |
| Untracked addition | `tests/server/orchestration-history-rollback.test.ts` |
| Untracked addition | `tests/server/orchestration-merge-back.test.ts` |
| Tracked change | `tests/server/orchestration-native-forks.test.ts` |
| Tracked change | `tests/server/provider-capability-manifest.test.ts` |
| Tracked change | `tests/server/provider-conformance.test.ts` |
| Tracked change | `tests/server/provider-session-fallback.test.ts` |
| Tracked change | `tests/server/provider-terminal-resume-command.test.ts` |
| Tracked change | `tests/server/session-continuity.test.ts` |
| Tracked change | `tests/server/turn-provider-event-projector.test.ts` |
| Untracked addition | `tests/shared/cursor-sdk-auth-contracts.test.ts` |
| Tracked change | `tests/source-usage.test.ts` |
| Tracked change | `tests/support/e2e-resource-policy.ts` |
| Tracked change | `tests/support/turn-controller-runtime.ts` |
