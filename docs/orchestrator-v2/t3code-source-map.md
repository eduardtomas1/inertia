# T3 Code source map

All source links below are pinned to `dd148481531a0a090780a2ade20588566db099a2` (2026-10-29). See [manifest](source-manifest.json) for the original merge and release boundaries. These are the inspected implementation entry points and related regression tests; listing a test is **not** a claim that it was executed in this study.

The architecture study cites these group IDs. Use symbol search inside the local source cache for deeper navigation. Current code and focused tests take precedence over historical design prose where they disagree.

## T01

Execution ownership and current architecture

- [docs/internals/overview.md](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/docs/internals/overview.md)
- [docs/internals/providers.md](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/docs/internals/providers.md)
- [docs/orchestration-v2/README.md](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/docs/orchestration-v2/README.md)

## T02

Graph and typed identities

- [packages/contracts/src/orchestrationV2.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/packages/contracts/src/orchestrationV2.ts)
- [docs/orchestration-v2/entity-ids-and-correlation.md](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/docs/orchestration-v2/entity-ids-and-correlation.md)
- [docs/orchestration-v2/core-graph-and-data-model.md](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/docs/orchestration-v2/core-graph-and-data-model.md)

## T03

Command admission, transactions and receipts

- [apps/server/src/orchestration-v2/Orchestrator.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/Orchestrator.ts)
- [apps/server/src/orchestration-v2/EventSink.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/EventSink.ts)
- [apps/server/src/orchestration-v2/ThreadCommandExecutor.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/ThreadCommandExecutor.ts)
- [apps/server/src/orchestration-v2/FoundationPersistence.test.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/FoundationPersistence.test.ts)

## T04

Durable side effects and execution lanes

- [apps/server/src/orchestration-v2/EffectOutbox.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/EffectOutbox.ts)
- [apps/server/src/orchestration-v2/EffectWorker.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/EffectWorker.ts)
- [apps/server/src/orchestration-v2/EffectWorker.test.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/EffectWorker.test.ts)

## T05

Queue delivery and finalization

- [apps/server/src/orchestration-v2/QueuedRunOrder.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/QueuedRunOrder.ts)
- [apps/server/src/orchestration-v2/QueuedRunOrder.test.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/QueuedRunOrder.test.ts)
- [apps/server/src/orchestration-v2/RunFinalizationService.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/RunFinalizationService.ts)
- [apps/server/src/orchestration-v2/RunFinalizationQueue.test.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/RunFinalizationQueue.test.ts)

## T06

Provider selection and transition planning

- [apps/server/src/orchestration-v2/ProviderSwitchService.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/ProviderSwitchService.ts)
- [apps/server/src/orchestration-v2/ProviderSessionTransitionPolicy.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/ProviderSessionTransitionPolicy.ts)
- [apps/server/src/orchestration-v2/ProviderSwitchService.test.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/ProviderSwitchService.test.ts)
- [apps/server/src/orchestration-v2/testkit/ProviderSwitch.integration.test.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/testkit/ProviderSwitch.integration.test.ts)

## T07

Portable history selection and delivery

- [packages/provider-core/src/server/handoffBudget.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/packages/provider-core/src/server/handoffBudget.ts)
- [apps/server/src/orchestration-v2/ContextHandoffService.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/ContextHandoffService.ts)
- [apps/server/src/orchestration-v2/ContextHandoffDelivery.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/ContextHandoffDelivery.ts)
- [apps/server/src/orchestration-v2/ContextHandoffBudget.test.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/ContextHandoffBudget.test.ts)

## T08

Turn start and fallback recovery

- [apps/server/src/orchestration-v2/ProviderTurnStartService.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/ProviderTurnStartService.ts)
- [apps/server/src/orchestration-v2/ProviderTurnStartService.test.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/ProviderTurnStartService.test.ts)

## T09

Forks and lineage

- [apps/server/src/orchestration-v2/ThreadForkService.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/ThreadForkService.ts)
- [apps/server/src/orchestration-v2/ThreadForkService.test.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/ThreadForkService.test.ts)
- [docs/orchestration-v2/thread-lineage-and-context-transfer.md](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/docs/orchestration-v2/thread-lineage-and-context-transfer.md)

## T10

Delegation and completion delivery

- [apps/server/src/mcp/OrchestratorMcpService.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/mcp/OrchestratorMcpService.ts)
- [apps/server/src/mcp/OrchestratorMcpService.test.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/mcp/OrchestratorMcpService.test.ts)
- [apps/server/src/orchestration-v2/NotificationMailbox.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/NotificationMailbox.ts)
- [apps/server/src/orchestration-v2/DelegatedCompletionDelivery.test.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/DelegatedCompletionDelivery.test.ts)

## T11

Native subagent projection

- [apps/server/src/orchestration-v2/SubagentProjection.test.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/SubagentProjection.test.ts)
- [packages/client-runtime/src/state/threadSubagents.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/packages/client-runtime/src/state/threadSubagents.ts)
- [packages/client-runtime/src/state/threadSubagents.test.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/packages/client-runtime/src/state/threadSubagents.test.ts)
- [apps/server/src/mcp/TaskCancelNativeSubagent.integration.test.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/mcp/TaskCancelNativeSubagent.integration.test.ts)

## T12

Agent tools and explicit targets

- [apps/server/src/mcp/toolkits/orchestrator/tools.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/mcp/toolkits/orchestrator/tools.ts)
- [apps/server/src/mcp/toolkits/thread/tools.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/mcp/toolkits/thread/tools.ts)
- [apps/server/src/mcp/toolkits/thread/handlers.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/mcp/toolkits/thread/handlers.ts)
- [apps/server/src/mcp/toolkits/project/handlers.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/mcp/toolkits/project/handlers.ts)
- [docs/orchestration-v2/orchestrator-mcp-server.md](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/docs/orchestration-v2/orchestrator-mcp-server.md)

## T13

MCP credentials, authorization and race checks

- [apps/server/src/mcp/McpSessionRegistry.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/mcp/McpSessionRegistry.ts)
- [apps/server/src/mcp/McpToolAccess.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/mcp/McpToolAccess.ts)
- [apps/server/src/mcp/threadAccess.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/mcp/threadAccess.ts)
- [apps/server/src/mcp/McpToolAccess.test.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/mcp/McpToolAccess.test.ts)
- [apps/server/src/mcp/McpToolAccess.race.test.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/mcp/McpToolAccess.race.test.ts)
- [apps/server/src/mcp/McpSessionRegistry.test.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/mcp/McpSessionRegistry.test.ts)

## T14

Restart reconciliation and continuation

- [apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts)
- [apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.test.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.test.ts)
- [apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.regression.test.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.regression.test.ts)
- [apps/server/src/orchestration-v2/RestartContinuation.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/RestartContinuation.ts)
- [apps/server/src/orchestration-v2/RestartContinuation.test.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/RestartContinuation.test.ts)

## T15

Usage limits

- [apps/server/src/orchestration-v2/UsageLimitRecoveryWorker.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/UsageLimitRecoveryWorker.ts)

## T16

Provider contract and instance registry

- [packages/provider-core/src/server/ProviderAdapter.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/packages/provider-core/src/server/ProviderAdapter.ts)
- [apps/server/src/provider/ProviderInstanceRegistry.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/provider/ProviderInstanceRegistry.ts)
- [apps/server/src/provider/ProviderRegistry.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/provider/ProviderRegistry.ts)
- [docs/orchestration-v2/provider-capability-system.md](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/docs/orchestration-v2/provider-capability-system.md)

## T17

Codex native turns and revert

- [apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts)
- [apps/server/src/provider/CodexThreadRevert.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/provider/CodexThreadRevert.ts)
- [apps/server/src/orchestration-v2/testkit/CodexReplayFixtures.integration.test.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/testkit/CodexReplayFixtures.integration.test.ts)

## T18

Claude native integration

- [apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts)
- [apps/server/src/orchestration-v2/testkit/ClaudeReplayFixtures.integration.test.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/testkit/ClaudeReplayFixtures.integration.test.ts)

## T19

Pi integration

- [packages/provider-pi/src/server/adapter.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/packages/provider-pi/src/server/adapter.ts)
- [apps/server/src/orchestration-v2/testkit/PiReplayFixtures.integration.test.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/testkit/PiReplayFixtures.integration.test.ts)

## T20

Cursor SDK and account isolation

- [packages/provider-cursor/src/server/adapter.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/packages/provider-cursor/src/server/adapter.ts)
- [packages/provider-cursor/src/server/CursorAgentSdk.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/packages/provider-cursor/src/server/CursorAgentSdk.ts)
- [packages/provider-cursor/src/server/auth.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/packages/provider-cursor/src/server/auth.ts)
- [packages/provider-cursor/src/server/credentialStore.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/packages/provider-cursor/src/server/credentialStore.ts)
- [apps/server/src/orchestration-v2/testkit/CursorReplayFixtures.integration.test.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/testkit/CursorReplayFixtures.integration.test.ts)

## T21

OpenCode versions and server ownership

- [packages/provider-opencode/src/server/adapter.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/packages/provider-opencode/src/server/adapter.ts)
- [packages/provider-opencode/src/server/v2/adapter.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/packages/provider-opencode/src/server/v2/adapter.ts)
- [packages/provider-opencode/src/server/v2/OpenCode2Server.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/packages/provider-opencode/src/server/v2/OpenCode2Server.ts)
- [packages/provider-opencode/src/server/OpenCodeServerLedger.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/packages/provider-opencode/src/server/OpenCodeServerLedger.ts)
- [apps/server/src/orchestration-v2/testkit/OpenCodeReplayFixtures.integration.test.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/testkit/OpenCodeReplayFixtures.integration.test.ts)

## T22

ACP registry and negotiated runtime

- [packages/provider-acp-registry/src/server/AcpRegistrySupport.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/packages/provider-acp-registry/src/server/AcpRegistrySupport.ts)
- [packages/provider-acp-registry/src/server/adapter.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/packages/provider-acp-registry/src/server/adapter.ts)
- [packages/provider-acp/src/server/adapter.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/packages/provider-acp/src/server/adapter.ts)
- [packages/provider-acp/src/server/AcpSessionRuntime.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/packages/provider-acp/src/server/AcpSessionRuntime.ts)
- [apps/server/src/orchestration-v2/testkit/AcpRegistryReplayFixtures.integration.test.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/testkit/AcpRegistryReplayFixtures.integration.test.ts)

## T23

Worktrees, launch and ownership

- [apps/server/src/mcp/WorktreeMcpService.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/mcp/WorktreeMcpService.ts)
- [apps/server/src/mcp/WorktreeMcpService.test.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/mcp/WorktreeMcpService.test.ts)
- [apps/server/src/orchestration-v2/ThreadLaunchService.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/ThreadLaunchService.ts)
- [apps/server/src/orchestration-v2/ThreadLaunchService.test.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/ThreadLaunchService.test.ts)

## T24

Checkpoint and filesystem reversal safety

- [apps/server/src/orchestration-v2/CheckpointRollbackService.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/CheckpointRollbackService.ts)
- [apps/server/src/orchestration-v2/CheckpointRestoreSafety.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/CheckpointRestoreSafety.ts)
- [apps/server/src/orchestration-v2/CheckpointRestoreSafety.test.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/CheckpointRestoreSafety.test.ts)
- [apps/server/src/orchestration-v2/CheckpointScopeOwnership.test.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/CheckpointScopeOwnership.test.ts)
- [apps/server/src/orchestration-v2/CheckpointRollbackService.test.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/CheckpointRollbackService.test.ts)

## T25

Scheduling and server-owned settlement

- [apps/server/src/scheduledTasks/ScheduledTaskService.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/scheduledTasks/ScheduledTaskService.ts)
- [apps/server/src/scheduledTasks/ScheduledTaskService.schedule.test.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/scheduledTasks/ScheduledTaskService.schedule.test.ts)
- [apps/server/src/scheduledTasks/ScheduledTaskService.interval.test.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/scheduledTasks/ScheduledTaskService.interval.test.ts)
- [apps/server/src/orchestration-v2/ThreadSettlementService.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/ThreadSettlementService.ts)

## T26

Migration and durable schema compatibility

- [apps/server/src/persistence/Migrations/055_OrchestrationV2.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/persistence/Migrations/055_OrchestrationV2.ts)
- [apps/server/src/persistence/Migrations.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/persistence/Migrations.ts)
- [apps/server/src/orchestration-v2/legacy/LegacyV1ThreadImporter.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/legacy/LegacyV1ThreadImporter.ts)
- [apps/server/src/orchestration-v2/legacy/LegacyV1Cutover.integration.test.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/legacy/LegacyV1Cutover.integration.test.ts)
- [docs/internals/legacy-orchestration-migration.md](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/docs/internals/legacy-orchestration-migration.md)
- [docs/user/thread-migration.md](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/docs/user/thread-migration.md)

## T27

Client projections and bounded history

- [packages/client-runtime/src/state/orchestrationV2Projection.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/packages/client-runtime/src/state/orchestrationV2Projection.ts)
- [packages/client-runtime/src/state/orchestrationV2Projection.test.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/packages/client-runtime/src/state/orchestrationV2Projection.test.ts)
- [packages/client-runtime/src/state/boundedThreadSnapshotHttp.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/packages/client-runtime/src/state/boundedThreadSnapshotHttp.ts)
- [docs/internals/connection-runtime.md](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/docs/internals/connection-runtime.md)

## T28

Replay and transport-level verification

- [apps/server/src/orchestration-v2/testkit/ProviderReplayHarness.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/testkit/ProviderReplayHarness.ts)
- [apps/server/src/orchestration-v2/testkit/ProviderReplayFixtures.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/testkit/ProviderReplayFixtures.ts)
- [apps/server/src/orchestration-v2/testkit/OrchestratorReplayRecovery.integration.test.ts](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/testkit/OrchestratorReplayRecovery.integration.test.ts)
- [docs/orchestration-v2/testing-strategy.md](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/docs/orchestration-v2/testing-strategy.md)

## Implementation landmarks

Verified one-based line anchors in the pinned snapshot:

| Topic | Entry point |
| --- | --- |
| Atomic command commit | [EventSink.ts:635](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/EventSink.ts#L635) |
| Ordered post-commit publication | [EventSink.ts:259](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/EventSink.ts#L259) |
| Process-bound effects | [EffectOutbox.ts:138](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/EffectOutbox.ts#L138) |
| Replay-safe effects | [EffectOutbox.ts:125](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/EffectOutbox.ts#L125) |
| Delivery ordering | [QueuedRunOrder.ts:12](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/QueuedRunOrder.ts#L12) |
| Provider transition decision | [ProviderSessionTransitionPolicy.ts:32](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/ProviderSessionTransitionPolicy.ts#L32) |
| Historical entry normalization | [handoffBudget.ts:127](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/packages/provider-core/src/server/handoffBudget.ts#L127) |
| Budget calculation | [handoffBudget.ts:99](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/packages/provider-core/src/server/handoffBudget.ts#L99) |
| Whole-entry history selection | [handoffBudget.ts:214](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/packages/provider-core/src/server/handoffBudget.ts#L214) |
| Delivery uncertainty | [ContextHandoffDelivery.ts:143](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/ContextHandoffDelivery.ts#L143) |
| Native/inline delivery | [ContextHandoffDelivery.ts:16](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/ContextHandoffDelivery.ts#L16) |
| Forkable source states | [ThreadForkService.ts:35](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/ThreadForkService.ts#L35) |
| Usage-limit recovery candidate | [UsageLimitRecoveryWorker.ts:11](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/UsageLimitRecoveryWorker.ts#L11) |
| Restart continuation cap | [RestartContinuation.ts:33](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/RestartContinuation.ts#L33) |
| Restart continuation decision | [RestartContinuation.ts:111](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/RestartContinuation.ts#L111) |
| Codex rollback | [CodexAdapterV2.ts:7569](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts#L7569) |
| Codex native fork | [CodexAdapterV2.ts:7645](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts#L7645) |
| MCP live caller | [threadAccess.ts:123](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/mcp/threadAccess.ts#L123) |
| MCP explicit target read | [threadAccess.ts:181](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/mcp/threadAccess.ts#L181) |
| MCP questions only | [handlers.ts:53](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/mcp/toolkits/thread/handlers.ts#L53) |
| MCP launch retry namespace | [handlers.ts:63](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/mcp/toolkits/project/handlers.ts#L63) |
| MCP token lifetime | [McpSessionRegistry.ts:64](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/mcp/McpSessionRegistry.ts#L64) |
| Worktree handoff serialization | [WorktreeMcpService.ts:67](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/mcp/WorktreeMcpService.ts#L67) |
| Provider rollback before file restore | [CheckpointRollbackService.ts:276](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/apps/server/src/orchestration-v2/CheckpointRollbackService.ts#L276) |
| Cursor platform-specific sandbox policy | [adapter.ts:176](https://github.com/pingdotgg/t3code/blob/dd148481531a0a090780a2ade20588566db099a2/packages/provider-cursor/src/server/adapter.ts#L176) |

## Original merge landmarks

These anchors are in the PR merge tree, not the current snapshot, and support the documentation-drift corrections.

| Finding | Merge source |
| --- | --- |
| Outbox already at merge | [EffectOutbox.ts:118](https://github.com/pingdotgg/t3code/blob/de343914273eceb852a1d1d739cd1d38df7796ee/apps/server/src/orchestration-v2/EffectOutbox.ts#L118) |
| Atomic commit already at merge | [EventSink.ts:490](https://github.com/pingdotgg/t3code/blob/de343914273eceb852a1d1d739cd1d38df7796ee/apps/server/src/orchestration-v2/EventSink.ts#L490) |
| Historical command context already at merge | [ContextHandoffBudget.ts:140](https://github.com/pingdotgg/t3code/blob/de343914273eceb852a1d1d739cd1d38df7796ee/apps/server/src/orchestration-v2/ContextHandoffBudget.ts#L140) |
| Paginated Codex rollback already at merge | [CodexAdapterV2.ts:6127](https://github.com/pingdotgg/t3code/blob/de343914273eceb852a1d1d739cd1d38df7796ee/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts#L6127) |
