import type { ProviderInfo } from "../../../shared/contracts";
import type { RuntimeStore } from "../../database";
import { githubIssuePublisher } from "../../git/github-issue-report";
import type { PrivateConnectTranscriptCache } from "../../private-connect/transcript-cache";
import type { ProviderMaintenanceController } from "../../provider/maintenance-controller";
import type { ProviderMetadata } from "../../provider/metadata";
import type { ProviderManager } from "../../providers";
import { publicRuntimeError } from "../../runtime-errors";
import type { RuntimeOptions } from "../../runtime-types";
import type { AgentThreadRuntime } from "../agent-thread-runtime";
import type { AgentWorkflowController } from "../agent-workflow-controller";
import type { DuoLaunchCoordinator } from "../duo/duo-launch-coordinator";
import { rollbackConversationHistory } from "../history-rollback-service";
import { createManualUsageRefresh, type ProviderUsageRefreshDependencies } from "../provider-usage-refresh";
import type { createQueuedMessageRuntime } from "../queued-message-runtime";
import type { TurnController } from "../turns/turn-controller";
import type { WatcherRuntime } from "../watcher/watcher-runtime";
import { createAgentWorkflowCommandHandler } from "./agent-workflow-commands";
import { createCliConversationCommandHandler } from "./cli-conversation-commands";
import type { RuntimeCommandHandler } from "./command-router";
import { createConversationCommandHandler, type ConversationCommandDependencies } from "./conversation-commands";
import { createConversationCompactionCommandHandler } from "./conversation-compaction-commands";
import { createCursorSdkLoginCommandHandler } from "./cursor-sdk-login-commands";
import { createDiffReviewCommandHandler } from "./diff-review-commands";
import { createDuoCommandHandler } from "./duo-commands";
import { createIsolatedReviewCommandHandler } from "./isolated-review-commands";
import { createIssueReportCommandHandler } from "./issue-report-commands";
import { createProjectWorkspaceCommandHandler, type ProjectWorkspaceCommandDependencies } from "./project-workspace-commands";
import { createProviderCommandHandler } from "./provider-commands";
import { createReadCommandHandlers } from "./read-commands";
import { createSettingsBackendCommandHandler } from "./settings-backend-commands";
import { createSourceControlCommandHandler } from "./source-control-commands";
import { createTodoCommandHandler } from "./todo-commands";
import type { TurnInteractionCommandDependencies } from "./turn-interaction-commands";

type IsolatedReviewDependencies = Parameters<typeof createIsolatedReviewCommandHandler>[0];
type ReadDependencies = Parameters<typeof createReadCommandHandlers>[0];
type CursorSdkLoginDependencies = Parameters<typeof createCursorSdkLoginCommandHandler>[0];

export interface RuntimeCommandHandlerServices {
  store: RuntimeStore;
  providers: ProviderManager;
  turns: TurnController;
  enableProviders: boolean;
  lifetimeSignal: AbortSignal;
  dataDirectory: string;
  databasePath: string;
  defaultWorkspacePath: RuntimeOptions["defaultWorkspacePath"];
  issueEvidence: RuntimeOptions["issueEvidence"];
  reviewSummaryTimeoutMs: IsolatedReviewDependencies["reviewSummaryTimeoutMs"];
  send: ConversationCommandDependencies["send"];
  broadcast: TurnInteractionCommandDependencies["broadcast"];
  broadcastSnapshot(): void;
  flushSnapshot(): void;
  broadcastConversationShell(conversationId: string): void;
  currentSnapshot: Parameters<typeof createProviderCommandHandler>[0]["currentSnapshot"];
  providerInfo(): readonly ProviderInfo[];
  trackRuntimeOperation: CursorSdkLoginDependencies["track"];
  reportIncident: NonNullable<ConversationCommandDependencies["reportIncident"]>;
  backendProfileController: ConversationCommandDependencies["backendProfileController"];
  providerTerminalResumes: ConversationCommandDependencies["providerTerminalResumes"];
  providerMaintenance: ProviderMaintenanceController;
  terminals: ProjectWorkspaceCommandDependencies["terminals"];
  refreshProviderInfo: Parameters<typeof createProviderCommandHandler>[0]["refreshProviderInfo"];
  providerUsage: ProviderUsageRefreshDependencies<ProviderMetadata>;
  runtimeSync: ConversationCommandDependencies["runtimeSync"];
  canStopWorkspaceRun: ReadDependencies["canStopWorkspaceRun"];
  conversationAttachments: ConversationCommandDependencies["conversationAttachments"];
  workspaceRuns: ConversationCommandDependencies["workspaceRuns"];
  isolatedRuns: IsolatedReviewDependencies["isolatedRuns"];
  deletedConversationIds: Set<string>;
  rememberDeletedConversation(conversationId: string): void;
  privateConnectTranscriptCache: PrivateConnectTranscriptCache;
  compactions: Parameters<typeof createConversationCompactionCommandHandler>[0]["compactions"];
  turnGitArtifacts: Parameters<typeof createSourceControlCommandHandler>[0]["turnGitArtifacts"];
  secureFiles: ProjectWorkspaceCommandDependencies["secureFiles"];
  secureFileAuthorities: ProjectWorkspaceCommandDependencies["secureFileAuthorities"];
  workspacePath: ProjectWorkspaceCommandDependencies["workspacePath"];
  duoLaunches: DuoLaunchCoordinator;
  visibleDuoLaunchIds: Parameters<typeof createDuoCommandHandler>[0]["visibleLaunchIds"];
  watchers: WatcherRuntime;
  agentThreads: AgentThreadRuntime;
  agentWorkflows: AgentWorkflowController;
  queuedMessages: ReturnType<typeof createQueuedMessageRuntime>;
  usageHandlers: readonly RuntimeCommandHandler[];
  turnInteraction: TurnInteractionCommandDependencies;
}

export function createRuntimeCommandHandlers(services: RuntimeCommandHandlerServices): RuntimeCommandHandler[] {
  const {
    store, providers, turns, enableProviders, lifetimeSignal, dataDirectory, send, broadcast, broadcastSnapshot,
    flushSnapshot, providerTerminalResumes, backendProfileController, workspaceRuns, isolatedRuns, secureFiles,
    secureFileAuthorities, workspacePath, providerMaintenance, refreshProviderInfo, conversationAttachments,
  } = services;
  const forgetRemoteTranscript = (conversationId: string): void =>
    services.privateConnectTranscriptCache.invalidateConversation(conversationId);
  return [
    createCursorSdkLoginCommandHandler({
      enabled: enableProviders,
      signal: lifetimeSignal,
      login: (onUrl, signal) => providers.loginCursorSdk(onUrl, signal),
      status: (signal) => providers.cursorSdkStatus(signal),
      models: (signal) => providers.cursorSdkModels(signal),
      track: services.trackRuntimeOperation,
      send,
    }),
    createCliConversationCommandHandler({ store, providers, signal: lifetimeSignal, broadcastSnapshot: flushSnapshot, send }),
    services.queuedMessages.handler,
    ...services.usageHandlers,
    createIssueReportCommandHandler({
      store,
      evidence: services.issueEvidence,
      snapshot: services.currentSnapshot,
      providerInfo: services.providerInfo,
      publisher: githubIssuePublisher(dataDirectory, lifetimeSignal),
      send,
    }),
    createDuoCommandHandler({
      coordinator: services.duoLaunches,
      visibleLaunchIds: services.visibleDuoLaunchIds,
      broadcastSnapshot: flushSnapshot,
      send,
    }),
    services.watchers.handler,
    createTodoCommandHandler({ ...services.turnInteraction, creation: services.agentThreads.creation, broadcastSnapshot: flushSnapshot }),
    createAgentWorkflowCommandHandler({
      workflows: services.agentWorkflows,
      providerTerminalResumes,
      conversationWork: store.conversationWork,
      broadcast,
      send,
    }),
    createProviderCommandHandler({
      providers,
      providerMaintenance,
      terminals: services.terminals,
      defaultWorkspacePath: services.defaultWorkspacePath,
      currentSnapshot: services.currentSnapshot,
      refreshProviderInfo,
      refreshProviderUsage: createManualUsageRefresh(services.providerUsage),
      send,
    }),
    ...createReadCommandHandlers({
      store,
      send,
      databasePath: services.databasePath,
      lifetimeSignal,
      reveal: (target) => services.runtimeSync.focusDetachedMessage(target),
      canStopWorkspaceRun: services.canStopWorkspaceRun,
    }),
    createConversationCommandHandler({
      store,
      conversationAttachments,
      providers,
      backendProfileController,
      workspaceRuns,
      providerTerminalResumes,
      duoLaunches: services.duoLaunches,
      watchers: services.watchers,
      runtimeSync: services.runtimeSync,
      deletedConversationIds: services.deletedConversationIds,
      dataDirectory,
      rememberDeletedConversation: services.rememberDeletedConversation,
      forgetRemoteTranscript,
      broadcastSnapshot: flushSnapshot,
      publicError: publicRuntimeError,
      send,
      creation: services.agentThreads.creation,
      contextRequests: services.agentThreads.contextRequests,
      reportIncident: services.reportIncident,
      rollbackHistory: enableProviders
        ? (input) => rollbackConversationHistory({ store, providers, turns, providerTerminalResumes }, input, lifetimeSignal)
        : undefined,
    }),
    services.queuedMessages.turnInteractionHandler,
    createConversationCompactionCommandHandler({
      store,
      providers,
      backendProfileController,
      turns,
      isolatedRuns,
      providerTerminalResumes,
      enableProviders,
      lifetimeSignal,
      compactions: services.compactions,
      instructions: turns,
      interaction: services.turnInteraction,
      settings: () => store.shellSnapshot().settings,
      refreshProviderAccount: (providerId) => refreshProviderInfo(providerId),
      providerInfo: services.providerInfo,
      broadcast,
      broadcastConversationShell: services.broadcastConversationShell,
      send,
    }),
    createSourceControlCommandHandler({
      store,
      workspaceRuns,
      turnGitArtifacts: services.turnGitArtifacts,
      secureFiles,
      secureFileAuthorities,
      workspacePath,
      broadcastSnapshot,
      send,
    }),
    createDiffReviewCommandHandler({ store, workspaceRuns, secureFiles, secureFileAuthorities, workspacePath, broadcastSnapshot, send }),
    createIsolatedReviewCommandHandler({
      store,
      backendProfileController,
      turns,
      isolatedRuns,
      secureFiles,
      dataDirectory,
      enableProviders,
      reviewSummaryTimeoutMs: services.reviewSummaryTimeoutMs,
      providerInfo: services.providerInfo,
      publicError: publicRuntimeError,
      broadcastSnapshot,
      send,
    }),
    createSettingsBackendCommandHandler({
      store,
      turns,
      conversationAttachments,
      providers,
      backendProfileController,
      defaultWorkspacePath: services.defaultWorkspacePath,
      providerMaintenanceBlocked: (providerId) => providerMaintenance.hasBlockingAuthority(providerId),
      refreshProviderInfo,
      broadcastSnapshot,
      send,
    }),
    createProjectWorkspaceCommandHandler({
      store,
      conversationAttachments,
      dataDirectory,
      workspaceRuns,
      turns,
      providers,
      providerTerminalResumes,
      duoLaunches: services.duoLaunches,
      watchers: services.watchers,
      terminals: services.terminals,
      secureFiles,
      secureFileAuthorities,
      workspacePath,
      rememberDeletedConversation: services.rememberDeletedConversation,
      forgetRemoteTranscript,
      broadcastSnapshot,
      reportTerminalProviderResumeRejection: (diagnostic) => {
        console.warn("Terminal provider resume rejected.", diagnostic);
      },
      reportIncident: services.reportIncident,
      send,
    }),
  ];
}
