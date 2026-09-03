import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import WebSocket from "ws";

import {
  type AgentApprovalRequest,
  type AgentInputRequest,
  type AgentPlan,
  type AppSnapshot,
  type ProviderInfo,
  type ProviderMaintenanceProviderId,
  type RuntimeMutationEvent,
  type RuntimeSyncCursor,
} from "../shared/contracts";
import { RuntimeStore } from "./database";
import { TurnController } from "./runtime/turns/turn-controller";
import { DuoLaunchCoordinator } from "./runtime/duo/duo-launch-coordinator";
import { resolveAuthoritativeProjectPath } from "./project-path";
import { PROVIDER_IDS, ProviderManager, type ProviderDetection } from "./providers";
import { ProviderMetadataCache, type ProviderMetadata } from "./provider/metadata";
import { ProviderMaintenanceController } from "./provider/maintenance-controller";
import type { ProviderMaintenanceTarget } from "./provider/maintenance-capabilities";
import { ProviderTerminalResumeRegistry } from "./provider/terminal-resume";
import { TerminalManager } from "./terminal";
import { runRuntimeShutdownPhases } from "./runtime-shutdown";
import { requireRuntimeDirectory as ensureDirectory } from "./runtime-commands";
import { publicRuntimeError as publicError, RuntimeRequestError as RequestError } from "./runtime-errors";
import {
  ProjectIdentityRefresher,
  projectIdentityIsUsable,
} from "./project-identity-refresh";
import { TurnGitArtifactManager } from "./turn-git-artifacts";
import { sendRuntimeEvent } from "./runtime-protocol";
import { createTestStreamingTrace } from "./runtime/test-streaming-trace";
import {
  initialProviderSnapshots,
  providerSnapshot,
} from "./runtime-snapshots";
import { DEFAULT_REVIEW_SUMMARY_TIMEOUT_MS } from "./review-summary";
import { IsolatedRunController } from "./runtime/reviews/isolated-run-controller";
import {
  BackendProfileController,
} from "./runtime/backends/backend-profile-controller";
import { RuntimeSyncHub } from "./runtime/runtime-sync-hub";
import type { RuntimeClientAuthority } from "./runtime/runtime-client-authority";
import { createDetachedChatRuntimeSecurity } from "./runtime/detached-chat-runtime-security";
import { SnapshotBroadcastCoalescer } from "./runtime/snapshot-broadcast-coalescer";
import { WorkspaceRunController } from "./runtime/workspace-run-controller";
import {
  createRuntimeCommandExecutor,
} from "./runtime/commands/command-router";
import { runtimeSafetyAllowsCommand } from "./runtime/commands/runtime-safety";
import {
  createConversationCommandHandler,
} from "./runtime/commands/conversation-commands";
import {
  createDiffReviewCommandHandler,
} from "./runtime/commands/diff-review-commands";
import {
  createDuoCommandHandler,
} from "./runtime/commands/duo-commands";
import {
  createIsolatedReviewCommandHandler,
} from "./runtime/commands/isolated-review-commands";
import {
  createProjectWorkspaceCommandHandler,
} from "./runtime/commands/project-workspace-commands";
import {
  createProviderCommandHandler,
} from "./runtime/commands/provider-commands";
import {
  createSettingsBackendCommandHandler,
} from "./runtime/commands/settings-backend-commands";
import { createSourceControlCommandHandler } from "./runtime/commands/source-control-commands";
import { createTurnInteractionCommandHandler } from "./runtime/commands/turn-interaction-commands";
import { createConversationCompactionCommandHandler } from "./runtime/commands/conversation-compaction-commands";
import { createUsageCommandHandler } from "./runtime/commands/usage-commands";
import {
  createAgentWorkflowCommandHandler,
} from "./runtime/commands/agent-workflow-commands";
import { AgentWorkflowController } from "./runtime/agent-workflow-controller";
import { createAgentThreadRuntime, type AgentThreadRuntime } from "./runtime/agent-thread-runtime";
import {
  attachRuntimeWebSocketBoundary,
} from "./runtime/websocket-boundary";
import {
  TrustedAttachmentResolver,
} from "./runtime/attachments/trusted-attachment-resolver";
import { PrivateGeneratedAttachmentStore } from "./runtime/attachments/private-generated-attachments";
import {
  SecureFileError,
  type RuntimeSecureFileBroker,
} from "./secure-files";
import { SecureFileAuthorityRegistry } from "./runtime/secure-file-authorities";
import { PrivateConnectRuntimeGateway } from "./private-connect/runtime-gateway";
import { queuePrivateConnectPrompt } from "./private-connect/prompt-admission";
import { PrivateConnectTranscriptCache } from "./private-connect/transcript-cache";
import {
  privateConnectPromptSafetyForHarness,
} from "../shared/private-connect/prompt-safety";
import {
  writeDatabaseRecoveryExportFile,
} from "./persistence/database-export-file";
import { runRecoveryImportWorker } from "./persistence/database-recovery-import-worker-client";
import { runPackagedImageRetentionSmoke } from "./runtime/attachments/package-smoke-image";
import type { RunningRuntime, RuntimeOptions } from "./runtime-types";
import { RuntimeUpdatePreparationGate } from "./runtime-update-preparation";
import { gitScanCoordinator } from "./git/scan-coordinator";
import { recordSystemSuspendInterval } from "./runtime/system-suspend-coordinator";
import {
  initializeRuntimePersistence,
  prepareRuntimeStartupRecovery,
  runtimeSafetyError,
} from "./runtime-startup-recovery";
export type {
  RunningRuntime,
  RuntimeBackendCredentialBroker,
  RuntimeOptions,
} from "./runtime-types";
export {
  assembleReadOnlyReviewRequest,
} from "./runtime/commands/review-support";

export async function startRuntime(options: RuntimeOptions): Promise<RunningRuntime> {
  const startupRecovery = prepareRuntimeStartupRecovery(options);
  const {
    dataDirectory,
    manuallyRetiredGenerations,
    authorizedModernGenerationIds,
    runtimeSafetyLock,
  } = startupRecovery;
  const generatedAttachments = await PrivateGeneratedAttachmentStore.create(
    dataDirectory,
    {
      preserveExisting: runtimeSafetyLock
        || manuallyRetiredGenerations.length > 0
        || authorizedModernGenerationIds.size > 0,
    },
  );
  const databasePath = join(dataDirectory, "inertia.sqlite");
  let turns: TurnController;
  let agentThreads: AgentThreadRuntime | undefined;
  let duoLaunches: DuoLaunchCoordinator | null = null;
  let closed = false;
  let databaseRecoveryImportActive = false;
  let activeRuntimeCommands = 0;
  const updatePreparation = new RuntimeUpdatePreparationGate({
    isClosed: () => closed,
    activeRuntimeCommands: () => activeRuntimeCommands,
    databaseRecoveryActive: () => databaseRecoveryImportActive,
    agentWorkActive: () => {
      const snapshot = currentSnapshot();
      return turns.activeConversationIds().length > 0
        || isolatedRuns.activeCount() > 0
        || snapshot.runs.some(
          ({ status }) => status === "running" || status === "waiting",
        );
    },
    terminalActivity: () => terminals.hasUpdateBlockingActivity(),
    providerMaintenanceActive: () =>
      providerMaintenance.activeOperations().length > 0,
    providerRefreshActive: () => activeProviderRefreshes > 0,
    artifactReconciliationActive: () => artifactReconciliationActive,
    holdTerminalAdmission: () => terminals.holdForUpdatePreparation(),
    releaseTerminalAdmission: () => terminals.releaseUpdatePreparation(),
    drainAdditionalOperations: async () => {
      await projectIdentities.drain();
      await artifactReconciliation;
    },
  });
  const trackRuntimeOperation = <T>(operation: () => Promise<T>): Promise<T> =>
    updatePreparation.track(operation);
  const streamingTrace = createTestStreamingTrace(dataDirectory);
  const send = (
    socket: WebSocket,
    event: Parameters<typeof sendRuntimeEvent>[1],
  ): void => {
    const isStreamingEvent = event.type === "runtime.event"
      && event.event.type === "agent.text";
    if (isStreamingEvent) streamingTrace.mark("runtime-event-serialized");
    if (isStreamingEvent) streamingTrace.mark("runtime-websocket-send-started");
    sendRuntimeEvent(socket, event);
    if (isStreamingEvent) streamingTrace.mark("runtime-websocket-send-accepted");
  };
  let onDatabaseBackupCreated = (): void => undefined;
  const store = new RuntimeStore(
    databasePath,
    options.defaultWorkspacePath,
    {
      recoverInterruptedRuns: false,
      canStartDatabaseBackup: () =>
        !closed
        && !databaseRecoveryImportActive
        && activeRuntimeCommands === 0
        && (turns?.activeConversationIds().length ?? 0) === 0,
      onDatabaseBackupCreated: () => onDatabaseBackupCreated(),
    },
  );
  const {
    conversationAttachments: initializedConversationAttachments,
    recovery,
  } = await initializeRuntimePersistence(options, startupRecovery, store);
  const recoveryImportFault = process.env.NODE_ENV === "test"
    ? options.recoveryImportFault
    : undefined;
  const testOnlyOnTurnSettled = process.env.NODE_ENV === "test"
    ? options.testOnlyOnTurnSettled
    : undefined;
  const testOnlyProjectIdentityRefresh = process.env.NODE_ENV === "test"
    ? options.testOnlyProjectIdentityRefresh
    : undefined;
  const testOnlyBeforeRuntimeCommand = process.env.NODE_ENV === "test"
    ? options.testOnlyBeforeRuntimeCommand
    : undefined;
  const testOnlyProviderRefresh = process.env.NODE_ENV === "test"
    ? options.testOnlyProviderRefresh
    : undefined;
  const secureFiles: RuntimeSecureFileBroker = options.secureFiles ?? {
    authorizeRoot: async () => {
      throw new SecureFileError(
        "unavailable",
        "Secure workspace file access is unavailable.",
      );
    },
    verifyRoot: async () => {
      throw new SecureFileError(
        "unavailable",
        "Secure workspace file access is unavailable.",
      );
    },
    read: async () => {
      throw new SecureFileError(
        "unavailable",
        "Secure workspace file access is unavailable.",
      );
    },
    replace: async () => {
      throw new SecureFileError(
        "unavailable",
        "Secure workspace file access is unavailable.",
      );
    },
  };
  const secureFileAuthorities = new SecureFileAuthorityRegistry(secureFiles);
  if (options.attachments && recovery.recoveredAttachmentIds.length > 0) {
    void Promise.allSettled(recovery.recoveredAttachmentIds.map(
      (attachmentId) => options.attachments!.cleanup(attachmentId),
    ));
  }
  const projectIdentities = new ProjectIdentityRefresher({
    apply: (projectId, identity) => {
      try {
        store.updateProject(projectId, identity);
      } catch {
        return;
      }
    },
  });
  const projectIdentityCandidates = store.shellSnapshot().projects.map(
    ({ id, path }) => ({ id, path }),
  );
  const projectIdentityRefresh: Promise<void> = runtimeSafetyLock
    ? Promise.resolve()
    : trackRuntimeOperation(() => projectIdentities
        .refreshAll(projectIdentityCandidates)
        .catch(() => undefined)
        .then(() => testOnlyProjectIdentityRefresh));
  const projectIdentityAuthority = {
    revalidate: async (projectId: string, projectPath: string) => {
      if (projectIdentityIsUsable(projectIdentities.state(projectId))) {
        return true;
      }
      return projectIdentityIsUsable(
        await projectIdentities.refresh({ id: projectId, path: projectPath }),
      );
    },
  };
  const privateConnectTranscriptCache = new PrivateConnectTranscriptCache();
  const turnGitArtifacts = new TurnGitArtifactManager(store, dataDirectory);
  const enableProviders = !runtimeSafetyLock && (options.enableProviders ?? true);
  const terminals = new TerminalManager({
    onOwnedProcessCleanupUnconfirmed:
      options.onOwnedProcessCleanupUnconfirmed,
  });
  const providerTerminalResumes = new ProviderTerminalResumeRegistry(store.conversationWork);
  const metadataCache = new ProviderMetadataCache({
    persistence: {
      load: () => store.loadProviderMetadata(),
      save: (metadata) => store.saveProviderMetadata(metadata),
    },
  });
  const savedSettings = store.shellSnapshot().settings;
  const backendProfileController = await BackendProfileController.create({
    store,
    credentials: options.backendCredentials,
    builtInClaudeProfiles: options.kimiClaudeProfiles ?? [],
  });
  const providers = new ProviderManager({
    metadataCache,
    commands: options.codexBinaryPath
      ? { codex: options.codexBinaryPath }
      : savedSettings.codexBinaryPath
        ? { codex: savedSettings.codexBinaryPath }
        : undefined,
    ...backendProfileController.providerManagerOptions(),
  }, options.agentHarnessRegistry);
  backendProfileController.attachProviderManager(providers);
  const agentWorkflows = new AgentWorkflowController(store, providers);
  const attachmentResolver = options.attachmentRoot && options.attachments
    ? new TrustedAttachmentResolver(
        resolve(options.attachmentRoot),
        options.attachments,
      )
    : null;
  const cachedProviderMetadata = Object.fromEntries(PROVIDER_IDS.map((providerId) => [providerId, providers.cachedMetadata(providerId)]));
  let providerInfo = initialProviderSnapshots(enableProviders, cachedProviderMetadata);
  let providerMaintenance: ProviderMaintenanceController;
  const runtimeSync = new RuntimeSyncHub<WebSocket>(send);
  const pendingApprovals = new Map<string, AgentApprovalRequest>();
  const pendingInputs = new Map<string, AgentInputRequest>();
  const deletedConversationIds = new Set<string>();
  const rememberDeletedConversation = (conversationId: string): void => {
    deletedConversationIds.delete(conversationId);
    deletedConversationIds.add(conversationId);
    if (deletedConversationIds.size <= 512) return;
    const oldest = deletedConversationIds.values().next().value;
    if (typeof oldest === "string") deletedConversationIds.delete(oldest);
  };
  const agentPlans = new Map<string, AgentPlan>();
  let isolatedRuns: IsolatedRunController<WebSocket>;
  let workspaceRuns: WorkspaceRunController<WebSocket>;
  const token = randomBytes(32).toString("base64url");
  const websocketPath = `/runtime/${token}`;
  const runtimeCommandDrainWaiters = new Set<() => void>();
  let artifactReconciliation: Promise<void> | null = null;
  let artifactReconciliationActive = false;

  const server = createServer((_request, response) => {
    response.writeHead(404, {
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'",
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    });
    response.end("Not found");
  });
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 1_000;
  server.maxHeadersCount = 32;

  const canStopWorkspaceRun = (run: AppSnapshot["runs"][number]): boolean => {
    if (run.status !== "running" && run.status !== "waiting") return false;
    if (run.kind === "check" || run.kind === "service") {
      return workspaceRuns?.canStopManagedAction(run) ?? false;
    }
    if (run.kind !== "agent" || !run.conversationId) return false;
    return turns?.isActive(run.conversationId)
      || isolatedRuns?.ownsWorkspaceRun(run.id);
  };
  const currentSnapshot = (sync: RuntimeSyncCursor = runtimeSync.cursor()): AppSnapshot => {
    const snapshot = store.shellSnapshot(providerInfo);
    const approvalConversationIds = new Set([...pendingApprovals.values()].map(({ conversationId }) => conversationId));
    const inputConversationIds = new Set([...pendingInputs.values()].map(({ conversationId }) => conversationId));
    return {
      ...snapshot,
      backendProfiles: backendProfileController.profiles(providerInfo),
      backendDefaults: backendProfileController.defaults(),
      maintenanceOperations: providerMaintenance.activeOperations(),
      conversations: snapshot.conversations.map((conversation) => ({
        ...conversation,
        pendingApproval: approvalConversationIds.has(conversation.id),
        pendingInput: inputConversationIds.has(conversation.id),
      })),
      runs: snapshot.runs.map((run) => ({ ...run, canStop: canStopWorkspaceRun(run) })),
      sync,
    };
  };
  const detachedChatRuntimeSecurity = createDetachedChatRuntimeSecurity({ websocketPath, store, snapshot: currentSnapshot, pendingApprovals, pendingInputs });
  const broadcast = (event: RuntimeMutationEvent): void => {
    runtimeSync.broadcast(event);
  };
  const broadcastConversationShell = (conversationId: string): void => {
    const conversation = store.conversationShell(conversationId);
    if (!conversation) return;
    broadcast({
      type: "conversation.shell.updated",
      conversation: {
        ...conversation,
        pendingApproval: [...pendingApprovals.values()].some(
          (request) => request.conversationId === conversationId,
        ),
        pendingInput: [...pendingInputs.values()].some(
          (request) => request.conversationId === conversationId,
        ),
      },
      runs: store.workspaceRunsForConversation(conversationId).map((run) => ({
        ...run,
        canStop: canStopWorkspaceRun(run),
      })),
    });
  };
  const snapshotBroadcasts = new SnapshotBroadcastCoalescer(() => {
    runtimeSync.broadcastSnapshot(currentSnapshot);
  });
  const broadcastSnapshot = (): void => snapshotBroadcasts.request();
  const flushSnapshot = (): void => snapshotBroadcasts.flush();
  onDatabaseBackupCreated = () => {
    if (!closed) broadcastSnapshot();
  };
  workspaceRuns = new WorkspaceRunController(
    store,
    terminals,
    broadcastSnapshot,
    () => closed,
    (requestId, projectId, conversationId) => broadcast({
      type: "workspace.git.invalidated",
      requestId,
      projectId,
      conversationId,
    }),
  );
  isolatedRuns = new IsolatedRunController(
    store,
    providers,
    dataDirectory,
    broadcastSnapshot,
    {
      defaultTimeoutMs: options.reviewSummaryTimeoutMs ?? DEFAULT_REVIEW_SUMMARY_TIMEOUT_MS,
    },
  );
  const applyProviderMetadata = (providerId: ProviderInfo["id"], metadata: ProviderMetadata): void => {
    providerInfo = providerInfo.map((current) => current.id === providerId ? {
      ...current,
      models: metadata.models,
      rateLimits: metadata.rateLimits,
      metadataState: metadata.metadataState,
    } : current);
  };
  let activeProviderRefreshes = 0;
  const refreshProviderInfoCore = async (
    providerId?: ProviderInfo["id"],
    refreshEnvironment = false,
    forceMetadata = false,
  ): Promise<void> => {
    if (!enableProviders) return;
    const enrichedSnapshot = async (detection: ProviderDetection): Promise<ProviderInfo> => {
      if (!detection.canRun) return providerSnapshot(detection, providers.cachedMetadata(detection.provider.id));
      const metadata = await providers.metadata(
        detection.provider.id,
        options.defaultWorkspacePath,
        { force: forceMetadata },
      ).catch(() => providers.cachedMetadata(detection.provider.id));
      return providerSnapshot(detection, metadata);
    };
    if (providerId) {
      const detection = await providers.detect(providerId, {
        cwd: options.defaultWorkspacePath,
        timeoutMs: 4_000,
        refreshEnvironment,
      });
      const detected = providerSnapshot(
        detection,
        providers.cachedMetadata(detection.provider.id),
      );
      providerInfo = providerInfo.map((current) => current.id === providerId
        ? { ...detected, ...(current.maintenance ? { maintenance: current.maintenance } : {}) }
        : current);
      if (!closed) broadcastSnapshot();
      if (!detection.canRun) return;
      const next = await enrichedSnapshot(detection);
      providerInfo = providerInfo.map((current) => current.id === providerId
        ? { ...next, ...(current.maintenance ? { maintenance: current.maintenance } : {}) }
        : current);
    } else {
      const detections = await providers.detectAll({
        cwd: options.defaultWorkspacePath,
        timeoutMs: 4_000,
        refreshEnvironment,
      });
      const previous = new Map(providerInfo.map((provider) => [provider.id, provider]));
      providerInfo = detections.map((detection) => {
        const next = providerSnapshot(
          detection,
          providers.cachedMetadata(detection.provider.id),
        );
        const maintenance = previous.get(detection.provider.id)?.maintenance;
        return maintenance ? { ...next, maintenance } : next;
      });
      if (!closed) broadcastSnapshot();
      providerInfo = await Promise.all(detections.map(async (detection) => {
        const next = await enrichedSnapshot(detection);
        const maintenance = previous.get(detection.provider.id)?.maintenance;
        return maintenance ? { ...next, maintenance } : next;
      }));
    }
    if (!closed) broadcastSnapshot();
  };
  const refreshProviderInfo = async (
    providerId?: ProviderInfo["id"],
    refreshEnvironment = false,
    forceMetadata = false,
  ): Promise<void> => {
    await trackRuntimeOperation(async () => {
      activeProviderRefreshes += 1;
      try {
        await testOnlyProviderRefresh?.();
        if (closed) return;
        await refreshProviderInfoCore(
          providerId,
          refreshEnvironment,
          forceMetadata,
        );
      } finally {
        activeProviderRefreshes -= 1;
      }
    });
  };
  const maintenanceTarget = (
    providerId: ProviderMaintenanceProviderId,
  ): ProviderMaintenanceTarget => {
    const provider = providerInfo.find((candidate) => candidate.id === providerId);
    return {
      providerId,
      executable: provider?.executable ?? null,
      installedVersion: provider?.version ?? null,
      installed: provider?.installState === "installed" && provider.available,
    };
  };
  providerMaintenance = new ProviderMaintenanceController({
    target: maintenanceTarget,
    refreshTarget: async (providerId) => {
      await refreshProviderInfo(providerId, true, true);
      return maintenanceTarget(providerId);
    },
    onStatus: (status) => {
      providerInfo = providerInfo.map((provider) => provider.id === status.providerId
        ? { ...provider, maintenance: status }
        : provider);
      if (!closed) {
        broadcast({
          type: "provider.maintenance.updated",
          providers: providerMaintenance.current(),
        });
      }
    },
    onOperation: (operation) => {
      if (!closed) {
        broadcast({ type: "provider.maintenance.operation", operation });
      }
    },
  });
  const workspacePath = (projectId: string, conversationId?: string): string => {
    if (!conversationId) return ensureDirectory(store.projectPath(projectId));
    const conversation = store.conversation(conversationId);
    if (conversation.projectId !== projectId) throw new RequestError("The thread does not belong to this project.");
    return ensureDirectory(store.conversationPath(conversationId));
  };
  turns = new TurnController(
    store,
    providers,
    pendingApprovals,
    pendingInputs,
    agentPlans,
    {
      broadcast,
      broadcastSnapshot,
      broadcastConversationShell,
      providerInfo: () => providerInfo,
      harnessInstructionsForTurn: () => agentThreads?.manager.capabilityInstructions() ?? [],
      hostToolsForTurn: (input) => agentThreads?.manager.bridgeFor(input),
      applyProviderMetadata: (event) => {
        applyProviderMetadata(event.providerId, providers.cachedMetadata(event.providerId));
      },
      onNativeGoalSynchronized: ({ conversationId, providerSessionId }) => {
        return agentWorkflows.acknowledgeNativeGoalSynchronization(
          conversationId,
          providerSessionId,
        );
      },
      captureGitBefore: async (input) => {
        await turnGitArtifacts.captureBefore(input);
        broadcastSnapshot();
      },
      captureGitArtifacts: (input) => turnGitArtifacts.finalize(input),
      releaseTurnAttachments: ({ attachmentIds }) =>
        options.attachments
          ? Promise.all(attachmentIds.map((attachmentId) =>
              options.attachments!.release(attachmentId))).then(() => undefined)
          : undefined,
      releaseGeneratedAttachments: (paths) => generatedAttachments.release(paths),
      validateModelSelection: (selection) =>
        backendProfileController.validateSelection(selection),
      refreshProviderMetadata: async ({ providerId, turnId, runStartedAt, status }) => {
        if (status !== "completed") return;
        const turn = store.agentTurn(turnId);
        if (backendProfileController.isExternalSelection(turn.modelSelection)) return;
        const current = providers.cachedMetadata(providerId);
        const fields: Array<"models" | "rateLimits"> = [];
        if (current.metadataState.models.freshness !== "fresh" && providerId !== "cursor") {
          fields.push("models");
        }
        const rateLimitsUpdatedAt = current.metadataState.rateLimits.updatedAt
          ? Date.parse(current.metadataState.rateLimits.updatedAt)
          : Number.NaN;
        if (
          (providerId === "codex" || providerId === "claude")
          && !(rateLimitsUpdatedAt >= runStartedAt)
        ) {
          fields.push("rateLimits");
        }
        if (fields.length === 0) return;
        const metadata = await providers.metadata(
          providerId,
          options.defaultWorkspacePath,
          { fields, force: true },
        );
        applyProviderMetadata(providerId, metadata);
      },
      onTurnSettled: async (turn) => {
        // The durable turn is already terminal. Backup work stays off the
        // settlement path and the manager deduplicates it with quiet/hourly
        // triggers. Failed and cancelled turns restart the same quiet window:
        // their cleanup writes are just as real as a successful completion.
        void store.createInitialBackup({ quietGraceMs: 1_000 }).catch(() => undefined);
        await agentThreads?.manager.onSourceTurnSettled(turn);
        await duoLaunches?.onTurnSettled(turn);
        await testOnlyOnTurnSettled?.(turn);
      },
      testOnlyStreamingTrace: streamingTrace,
    },
    {
      runtimeGenerationId: options.runtimeGenerationId,
      systemBootId: options.systemBootId,
    },
  );
  agentThreads = createAgentThreadRuntime({
    store, providers, backendProfileController, workspaceRuns, dataDirectory, turns, providerTerminalResumes,
    providerInfo: () => providerInfo, broadcastSnapshot: flushSnapshot,
    broadcastConversationShell, pendingInputs, broadcast,
    agentBrowser: options.agentBrowser,
  });
  agentWorkflows.attachNativeGoalRuntime(turns);
  const duoLaunchCoordinator = new DuoLaunchCoordinator(
    store,
    providers,
    backendProfileController,
    turns,
    dataDirectory,
    () => providerInfo,
    { workspaceRuns },
  );
  duoLaunches = duoLaunchCoordinator;
  if (!runtimeSafetyLock) {
    await duoLaunchCoordinator.resumeComparisons();
  }

  const executeCommand = createRuntimeCommandExecutor({
    handlers: [
      createDuoCommandHandler({
        coordinator: duoLaunchCoordinator,
        broadcastSnapshot: flushSnapshot,
        send,
      }),
      createAgentWorkflowCommandHandler({
        workflows: agentWorkflows, providerTerminalResumes,
        conversationWork: store.conversationWork,
        broadcast,
        send,
      }),
      createProviderCommandHandler({
        providers,
        providerMaintenance,
        terminals,
        defaultWorkspacePath: options.defaultWorkspacePath,
        currentSnapshot,
        refreshProviderInfo,
        send,
      }),
      createUsageCommandHandler({ store, send }),
      createConversationCommandHandler({
        store, conversationAttachments: initializedConversationAttachments,
        providers,
        backendProfileController,
        workspaceRuns,
        providerTerminalResumes,
        duoLaunches: duoLaunchCoordinator,
        runtimeSync,
        deletedConversationIds,
        dataDirectory,
        rememberDeletedConversation,
      forgetRemoteTranscript: (conversationId: string) =>
          privateConnectTranscriptCache.invalidateConversation(conversationId),
        broadcastSnapshot: flushSnapshot,
        publicError,
        send,
        creation: agentThreads.creation,
        contextRequests: agentThreads.contextRequests,
      }),
      createTurnInteractionCommandHandler({
        store, conversationAttachments: initializedConversationAttachments,
        backendProfileController,
        turns,
        isolatedRuns,
        workspaceRuns,
        pendingApprovals,
        pendingInputs,
        dataDirectory,
        enableProviders,
        attachmentResolver,
        generatedAttachments,
        workflows: agentWorkflows,
        providerTerminalResumes,
        providerInfo: () => providerInfo,
        broadcast,
        broadcastSnapshot,
        send,
      }),
      createConversationCompactionCommandHandler({ store, providers, backendProfileController, turns, isolatedRuns, providerTerminalResumes, enableProviders, providerInfo: () => providerInfo, broadcast, send }),
      createSourceControlCommandHandler({
        store,
        workspaceRuns,
        turnGitArtifacts,
        secureFiles,
        secureFileAuthorities,
        workspacePath,
        broadcastSnapshot,
        send,
      }),
      createDiffReviewCommandHandler({
        store,
        workspaceRuns,
        secureFiles,
        secureFileAuthorities,
        workspacePath,
        broadcastSnapshot,
        send,
      }),
      createIsolatedReviewCommandHandler({
        store,
        turns,
        isolatedRuns,
        secureFiles,
        dataDirectory,
        enableProviders,
        reviewSummaryTimeoutMs: options.reviewSummaryTimeoutMs,
        providerInfo: () => providerInfo,
        publicError,
        broadcastSnapshot,
        send,
      }),
      createSettingsBackendCommandHandler({
        store,
        providers,
        backendProfileController,
        defaultWorkspacePath: options.defaultWorkspacePath,
        refreshProviderInfo,
        broadcastSnapshot,
        send,
      }),
      createProjectWorkspaceCommandHandler({
        store, conversationAttachments: initializedConversationAttachments,
        workspaceRuns,
        turns,
        providers,
        providerTerminalResumes,
        duoLaunches: duoLaunchCoordinator,
        terminals,
        secureFiles,
        secureFileAuthorities,
        workspacePath,
        rememberDeletedConversation,
      forgetRemoteTranscript: (conversationId: string) =>
          privateConnectTranscriptCache.invalidateConversation(conversationId),
        broadcastSnapshot,
        reportTerminalProviderResumeRejection: (diagnostic) => {
          console.warn("Terminal provider resume rejected.", diagnostic);
        },
        send,
      }),
    ],
    send,
    broadcastSnapshot: flushSnapshot,
    publicError,
  });
  const dispatchCommand = async (socket: WebSocket, command: Parameters<typeof executeCommand>[1], authority: RuntimeClientAuthority): Promise<void> => {
    if (closed) {
      send(socket, {
        type: "request.error",
        requestId: command.requestId,
        message: "The runtime is shutting down.",
      });
      return;
    }
    const detachedAuthorizationError = detachedChatRuntimeSecurity.authorizationError(authority, command);
    if (detachedAuthorizationError) { send(socket, detachedAuthorizationError); return; }
    if (updatePreparation.isAdmissionClosed()) {
      send(socket, {
        type: "request.error",
        requestId: command.requestId,
        message: "The runtime is preparing for an application update.",
      });
      return;
    }
    if (runtimeSafetyLock && !runtimeSafetyAllowsCommand(command.type)) {
      send(socket, {
        type: "request.error",
        requestId: command.requestId,
        message: runtimeSafetyError("Changes are unavailable in recovery safety mode."),
      });
      return;
    }
    if (databaseRecoveryImportActive) {
      send(socket, {
        type: "request.error",
        requestId: command.requestId,
        message: "Database recovery is in progress. Try again after it finishes.",
      });
      return;
    }
    activeRuntimeCommands += 1;
    try {
      await trackRuntimeOperation(async () => {
        await testOnlyBeforeRuntimeCommand?.();
        if (closed || updatePreparation.isAdmissionClosed()) {
          send(socket, {
            type: "request.error",
            requestId: command.requestId,
            message: closed
              ? "The runtime is shutting down."
              : "The runtime is preparing for an application update.",
          });
          return;
        }
        await executeCommand(socket, command);
      });
    } finally {
      activeRuntimeCommands -= 1;
      if (activeRuntimeCommands === 0) {
        for (const resolveDrain of runtimeCommandDrainWaiters) resolveDrain();
        runtimeCommandDrainWaiters.clear();
      }
    }
  };

  const webSocketBoundary = attachRuntimeWebSocketBoundary({
    server,
    websocketPath,
    runtimeSync,
    terminals,
    isolatedRuns,
    dispatchCommand,
    consumeDetachedCapability: (url) => detachedChatRuntimeSecurity.consumeCapability(url),
    beforeFreshSnapshot: () => turns.flushActiveStreamsForHydration(),
    currentSnapshot,
    approvals: () => pendingApprovals.values(),
    inputs: () => pendingInputs.values(),
    plans: () => agentPlans.values(),
    onDisconnect: (socket) => secureFileAuthorities.clearOwner(socket),
  });

  server.on("error", () => { /* Listen errors are surfaced below; later socket errors are isolated. */ });
  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error): void => rejectListen(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => { server.off("error", onError); resolveListen(); });
  }).catch((error: unknown) => { store.close(); throw error; });

  const address = server.address();
  if (!address || typeof address === "string") { store.close(); throw new Error("Runtime did not receive a local port."); }
  const websocketUrl = `ws://127.0.0.1:${address.port}${websocketPath}`; detachedChatRuntimeSecurity.activate(websocketUrl);

  // Reconcile durable pending artifacts only after the runtime can serve the
  // already-terminal turn snapshot. Restart recovery must not hold the app
  // startup screen behind Git work.
  if (!runtimeSafetyLock) {
    artifactReconciliationActive = true;
    artifactReconciliation = turnGitArtifacts.reconcile()
      .then((changed) => {
        if (changed && !closed) broadcastSnapshot();
      })
      .catch(() => undefined)
      .finally(() => {
        artifactReconciliationActive = false;
      });
  }

  if (enableProviders) {
    void refreshProviderInfo(undefined, true).then(async () => {
      // Remote version advisories are best-effort UI data and own no shutdown resources.
      if (!closed) await providerMaintenance.refresh(PROVIDER_IDS, false);
    }).catch(() => {
      if (closed) return;
      providerInfo = providerInfo.map((provider) => ({
        ...provider,
        installState: "error",
        authState: "error",
        canRun: false,
        statusMessage: "Agent discovery failed",
      }));
      broadcastSnapshot();
    });
  }

  const privateConnectGateway = new PrivateConnectRuntimeGateway({
    shell: currentSnapshot,
    detail: (conversationId) => store.conversationDetail(conversationId),
    isConversationActive: (conversationId) =>
      turns.isActive(conversationId) || isolatedRuns.has(conversationId),
    preparePrompt: async (conversation) => {
      if (!enableProviders) {
        throw new Error("Provider execution is disabled.");
      }
      const selectedProvider = providerInfo.find(
        ({ id }) => id === conversation.providerId,
      );
      backendProfileController.validateSelection(conversation.modelSelection);
      const backendReadiness = await backendProfileController.readiness(
        conversation.modelSelection,
        selectedProvider,
      );
      if (backendReadiness && !backendReadiness.ready) {
        throw new Error(
          backendReadiness.message ?? "The selected model backend is unavailable.",
        );
      }
      if (!backendReadiness && !selectedProvider?.canRun) {
        throw new Error(
          selectedProvider?.statusMessage
            ?? "This agent is not ready on the desktop.",
        );
      }
    },
    transcriptCache: privateConnectTranscriptCache,
    privateConnectPromptSafety: (conversation) =>
      privateConnectPromptSafetyForHarness(conversation.modelSelection.harnessId),
    queuePrompt: (conversationId, content) => queuePrivateConnectPrompt({
      authority: providerTerminalResumes,
      turns,
      isolatedRuns,
      onQueued: (queuedConversationId) => {
        broadcast({
          type: "conversation.detail.invalidated",
          conversationId: queuedConversationId,
        });
        broadcastSnapshot();
      },
    }, conversationId, content),
    respondToInput: (conversationId, inputRequestId, answers) => {
      const pending = pendingInputs.get(inputRequestId);
      if (!pending || pending.conversationContextRequest || pending.conversationId !== conversationId || pending.questions.some((question) => question.isSecret)) return false;
      const expected = new Map(pending.questions.map((question) => [question.id, question]));
      for (const [questionId, values] of Object.entries(answers)) {
        const question = expected.get(questionId);
        if (!question || values.length === 0 || (!question.allowMultiple && values.length !== 1)) return false;
        const optionIds = new Set(question.options.map((option) => option.id));
        if (question.options.length > 0 && values.some((value) => !optionIds.has(value) && !question.isOther)) return false;
      }
      if ([...expected.keys()].some((questionId) => !answers[questionId]?.length)) return false;
      return turns.respondToInput(conversationId, inputRequestId, answers);
    },
    stopRun: (conversationId, runId) => {
      const run = currentSnapshot().runs.find((candidate) => candidate.id === runId);
      if (!run || run.conversationId !== conversationId) return { stopped: false, alreadyStopped: false };
      if (run.status !== "running" && run.status !== "waiting") return { stopped: false, alreadyStopped: true };
      const stopped = isolatedRuns.stopConversation(conversationId) || turns.cancel(conversationId);
      return { stopped, alreadyStopped: false };
    },
    inputs: () => pendingInputs.values(),
  });

  return {
    runPackageSmokeImage: (inputPath, resultPath, signal) =>
      runPackagedImageRetentionSmoke(
        inputPath,
        resultPath,
        initializedConversationAttachments,
        signal,
      ),
    websocketUrl,
    databaseRecovery: store.databaseRecoveryReport(),
    recordSystemSuspendInterval: (interval) => recordSystemSuspendInterval(store, interval, broadcast, broadcastSnapshot),
    prepareForUpdate: (operationId) => updatePreparation.prepare(operationId),
    releaseUpdatePreparation: (operationId) =>
      updatePreparation.release(operationId),
    resolveProjectPath: (request) => trackRuntimeOperation(async () => {
      if (runtimeSafetyLock) {
        throw new Error(runtimeSafetyError("Project changes are unavailable in recovery safety mode."));
      }
      return (await resolveAuthoritativeProjectPath(
        store,
        request,
        projectIdentityAuthority,
      )).absolute;
    }),
    privateConnectRequest: (subject, request) =>
      updatePreparation.isAdmissionClosed()
      ? Promise.resolve({
          type: "response",
          requestId: request.requestId,
          ok: false,
          code: "unavailable",
          message: "The runtime is preparing for an application update.",
        })
      : runtimeSafetyLock
      ? Promise.resolve({
          type: "response",
          requestId: request.requestId,
          ok: false,
          code: "unavailable",
          message: runtimeSafetyError("Private Connect changes are unavailable in recovery safety mode."),
        })
      : databaseRecoveryImportActive
      ? Promise.resolve({
          type: "response",
          requestId: request.requestId,
          ok: false,
          code: "unavailable",
          message: "Database recovery is in progress.",
        })
      : trackRuntimeOperation(() => privateConnectGateway.request(subject, request)),
    preparePrivateConnectPrompt: (subject, request) =>
      updatePreparation.isAdmissionClosed()
      ? Promise.resolve({
          type: "response",
          requestId: request.requestId,
          ok: false,
          code: "unavailable",
          message: "The runtime is preparing for an application update.",
        })
      : runtimeSafetyLock
      ? Promise.resolve({
          type: "response",
          requestId: request.requestId,
          ok: false,
          code: "unavailable",
          message: runtimeSafetyError("Private Connect changes are unavailable in recovery safety mode."),
        })
      : databaseRecoveryImportActive
      ? Promise.resolve({
          type: "response",
          requestId: request.requestId,
          ok: false,
          code: "unavailable",
          message: "Database recovery is in progress.",
        })
      : trackRuntimeOperation(() => privateConnectGateway.preparePrompt(subject, request)),
    commitPrivateConnectPrompt: (subject, request, preparationId) =>
      updatePreparation.isAdmissionClosed()
        ? {
            type: "response",
            requestId: request.requestId,
            ok: false,
            code: "unavailable",
            message: "The runtime is preparing for an application update.",
          }
        : runtimeSafetyLock
        ? {
            type: "response",
            requestId: request.requestId,
            ok: false,
            code: "unavailable",
            message: runtimeSafetyError("Private Connect changes are unavailable in recovery safety mode."),
          }
        : databaseRecoveryImportActive
        ? {
            type: "response",
            requestId: request.requestId,
            ok: false,
            code: "unavailable",
            message: "Database recovery is in progress.",
          }
        : privateConnectGateway.commitPrompt(subject, request, preparationId),
    forgetPrivateConnectTranscripts: (scope) => {
      if (updatePreparation.isAdmissionClosed()) return;
      if (scope.kind === "all") privateConnectGateway.reset();
      else privateConnectGateway.forgetConversation(scope.conversationId);
    },
    exportRecoveryData: (path, signal) =>
      updatePreparation.runDatabaseRecovery(async () => {
        if (runtimeSafetyLock) {
          throw new Error(runtimeSafetyError("Database export is unavailable in recovery safety mode."));
        }
        await writeDatabaseRecoveryExportFile(
          path,
          store.exportRecoveryData(),
          { signal },
        );
      }),
    importRecoveryData: (path, targetDirectory, signal, operationId) =>
      updatePreparation.runDatabaseRecovery(async () => {
        if (runtimeSafetyLock) {
          throw new Error(runtimeSafetyError("Database import is unavailable in recovery safety mode."));
        }
        if (databaseRecoveryImportActive) {
          throw new Error("A database recovery import is already active.");
        }
        if (!operationId) {
          throw new Error("The database recovery import identity is required.");
        }
        databaseRecoveryImportActive = true;
        try {
          if (activeRuntimeCommands > 0) {
            await new Promise<void>((resolveDrain) => {
              runtimeCommandDrainWaiters.add(resolveDrain);
            });
          }
          await projectIdentityRefresh;
          await artifactReconciliation;
          const backgroundRunActive = currentSnapshot().runs.some(
            ({ status }) => status === "running" || status === "waiting",
          );
          if (
            turns.activeConversationIds().length > 0
            || backgroundRunActive
            || providerMaintenance.activeOperations().length > 0
            || activeProviderRefreshes > 0
          ) {
            throw new Error(
              "Database recovery cannot start while runtime work is active.",
            );
          }
          // With command admission closed and active turns ruled out, no new
          // terminal task can appear after this final store-writer drain.
          await turns.drainSettlementTasks(signal);
          const result = await runRecoveryImportWorker({
            databasePath,
            defaultWorkspacePath: options.defaultWorkspacePath,
            recoveryPath: path,
            targetDirectory,
            operationId,
            signal,
            ...(recoveryImportFault
              ? {
                  fault: {
                    phase: recoveryImportFault.phase,
                    markerPath: recoveryImportFault.markerPath,
                    stallMs: recoveryImportFault.stallMs,
                  },
                }
              : {}),
          });
          broadcastSnapshot();
          return result;
        } catch (error) {
          // Worker termination is confirmed before rejection. Reconcile its
          // durable filesystem journal only after SQLite has rolled back and
          // released the independent connection.
          store.reconcileRecoveryImport();
          broadcastSnapshot();
          throw error;
        } finally {
          databaseRecoveryImportActive = false;
        }
      }),
    close: async (cause = "runtime-shutdown") => {
      if (closed) return;
      closed = true;
      projectIdentities.dispose();
      snapshotBroadcasts.close();
      secureFileAuthorities.clear();
      await runRuntimeShutdownPhases({
        quiesceRuntimeWork: async ({ deadlineAt }) => {
          turnGitArtifacts.beginShutdown(deadlineAt);
          await gitScanCoordinator.cancelAndDrainWhile(async () => {
            await updatePreparation.drainTracked();
            await projectIdentities.drain();
          });
        },
        independentDrains: [
          () => initializedConversationAttachments.close(),
          ({ deadlineAt }) => terminals.disposeAll(deadlineAt),
          () => providerMaintenance.dispose(),
        ],
        stopIsolatedRuns: () => isolatedRuns.dispose(cause),
        disposeTurnsAndProviders: () => turns.dispose(cause),
        settleArtifacts: async () => {
          await artifactReconciliation;
          await turnGitArtifacts.settleShutdown();
        },
        terminateClients: () => {
          runtimeSync.terminateAll((client) => client.terminate());
        },
        closeServer: async () => {
          const results = await Promise.allSettled([
            webSocketBoundary.close(),
            new Promise<void>((resolveClose) =>
              server.close(() => resolveClose())),
          ]);
          const failed = results.find(
            (result): result is PromiseRejectedResult =>
              result.status === "rejected",
          );
          if (failed) throw failed.reason;
        },
        closeStore: () => store.backupAndClose(),
      });
    },
  };
}
