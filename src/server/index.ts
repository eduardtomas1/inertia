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
import { PROVIDER_IDS, ProviderManager } from "./providers";
import { ProviderMetadataCache, type ProviderMetadata } from "./provider/metadata";
import { ProviderMaintenanceController } from "./provider/maintenance-controller";
import type { ProviderMaintenanceTarget } from "./provider/maintenance-capabilities";
import {
  ProviderInstallationLeaseCoordinator,
} from "./provider/installation-lease";
import { ProviderMaintenanceJournal } from
  "./provider/maintenance-journal";
import { recoverProviderMaintenanceJournal } from
  "./provider/maintenance-recovery";
import { createProviderInfoRefresh } from "./provider/provider-info-refresh";
import { ProviderTerminalResumeRegistry } from "./provider/terminal-resume";
import { TerminalManager } from "./terminal";
import { windowsCleanupFailures } from "./windows-cleanup-diagnostics";
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
import { initialProviderSnapshots } from "./runtime-snapshots";
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
import { createPrivateConnectInputResponder } from "./private-connect/input-response-admission";
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
import { gitInspectionLifecycle } from "./git/inspection-lifecycle";
import { recordSystemSuspendInterval } from "./runtime/system-suspend-coordinator";
import {
  initializeRuntimePersistence,
  prepareRuntimeStartupRecovery,
  runtimeSafetyError,
} from "./runtime-startup-recovery";
import { runtimeLifecycleDiagnosticSnapshot } from "./lifecycle-diagnostics";
import { RuntimeStartupBlockerError } from
  "../shared/runtime-startup-diagnostics";
export type {
  RunningRuntime,
  RuntimeBackendCredentialBroker,
  RuntimeOptions,
} from "./runtime-types";
export {
  assembleReadOnlyReviewRequest,
} from "./runtime/commands/review-support";

export async function startRuntime(options: RuntimeOptions): Promise<RunningRuntime> {
  const runtimeStartedAt = new Date().toISOString();
  const startupRecovery = prepareRuntimeStartupRecovery(options);
  const {
    dataDirectory,
    manuallyRetiredGenerations,
    authorizedModernGenerationIds,
    runtimeSafetyLock,
  } = startupRecovery;
  if (runtimeSafetyLock) {
    throw new RuntimeStartupBlockerError(
      "prior-runtime-cleanup-unconfirmed",
      runtimeSafetyError("Runtime startup is blocked."),
    );
  }
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
  const runtimeLifetimeAbort = new AbortController();
  let postReadyWorkStarted = false;
  let postReadyWork: Promise<void> = Promise.resolve();
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
    providerMaintenanceActive: () => providerMaintenance.hasBlockingAuthority(),
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
  let projectIdentityRefresh: Promise<void> = Promise.resolve();
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
  const providerInstallationLeases = new ProviderInstallationLeaseCoordinator();
  const providerMaintenanceJournal = new ProviderMaintenanceJournal(
    dataDirectory,
    {
      runtimeGenerationId: options.runtimeGenerationId,
      systemBootId: options.systemBootId,
    },
  );
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
  const backendProfileController = BackendProfileController.open({
    store,
    credentials: options.backendCredentials,
    builtInClaudeProfiles: options.kimiClaudeProfiles ?? [],
  });
  const providers = ProviderManager.createProduction({
    metadataCache,
    installationLeases: providerInstallationLeases,
    lifetimeSignal: runtimeLifetimeAbort.signal,
    commands: options.codexBinaryPath
      ? { codex: options.codexBinaryPath }
      : savedSettings.codexBinaryPath
        ? { codex: savedSettings.codexBinaryPath }
        : undefined,
    ...backendProfileController.providerManagerOptions(),
  }, options.agentHarnessRegistry);
  backendProfileController.attachProviderManager(providers);
  const maintenanceCleanupAuthorities = !runtimeSafetyLock
    && options.enableProviders !== false
    ? new Set([
        ...startupRecovery.confirmedGenerations,
        ...startupRecovery.manuallyRetiredGenerations,
        ...startupRecovery.authorizedModernGenerationIds,
      ])
    : new Set<string>();
  const providerMaintenanceRecovery = await recoverProviderMaintenanceJournal({
    journal: providerMaintenanceJournal,
    installationLeases: providerInstallationLeases,
    runtime: providers,
    cwd: options.defaultWorkspacePath,
    confirmedRuntimeGenerationIds: maintenanceCleanupAuthorities,
    currentSystemBootId: options.systemBootId,
    priorBootCleanupConfirmed: !runtimeSafetyLock
      && options.enableProviders !== false
      && startupRecovery.priorBootLeasesCleared,
  }).catch(() => {
    throw new RuntimeStartupBlockerError(
      "provider-installation-quarantined",
      "Provider installation recovery requires manual attention.",
    );
  });
  const enableProviders = !runtimeSafetyLock
    && providerMaintenanceRecovery.length === 0
    && (options.enableProviders ?? true);
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
    const maintenanceOperations = providerMaintenance.activeOperations();
    const providerMaintenanceStates = providerMaintenance.diagnosticStates();
    const providerRunOwnership = store.providerRunOwnership.all();
    const conversations = snapshot.conversations.map((conversation) => ({
      ...conversation,
      pendingApproval: approvalConversationIds.has(conversation.id),
      pendingInput: inputConversationIds.has(conversation.id),
    }));
    const runs = snapshot.runs.map((run) => ({
      ...run,
      canStop: canStopWorkspaceRun(run),
    }));
    const activeConversationIds = turns?.activeConversationIds()
      ?? providerRunOwnership.map(({ conversationId }) => conversationId);
    return {
      ...snapshot,
      backendProfiles: backendProfileController.profiles(providerInfo),
      backendDefaults: backendProfileController.defaults(),
      maintenanceOperations,
      conversations,
      runs,
      lifecycleDiagnostics: runtimeLifecycleDiagnosticSnapshot({
        runtimeGenerationId: options.runtimeGenerationId, systemBootId: options.systemBootId,
        runtimeStartedAt, runtimeSafetyLock,
        confirmedCleanupReceiptConsumed:
          startupRecovery.confirmedGenerations.length > 0,
        providerInfo, conversations, runs, providerMaintenanceStates,
        providerMaintenanceRecoveryCount: providerMaintenanceRecovery.length,
        selectedConversationId: snapshot.activeConversationId,
        activeConversationIds,
        runningProviderConversationIds: new Set(providers.activeConversationIds()),
        providerRunOwnershipConversationIds: providerRunOwnership.map(({ conversationId }) => conversationId),
        terminalOwnershipCount: terminals.ownedResourceCount(), interactionCount: pendingApprovals.size + pendingInputs.size,
        windowsCleanupFailures: windowsCleanupFailures(),
      }),
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
  const refreshProviderInfo = createProviderInfoRefresh({
    enabled: enableProviders,
    providers,
    defaultWorkspacePath: options.defaultWorkspacePath,
    lifetimeSignal: runtimeLifetimeAbort.signal,
    providerInfo: () => providerInfo,
    replaceProviderInfo: (value) => { providerInfo = value; },
    broadcastSnapshot,
    isClosed: () => closed,
    track: trackRuntimeOperation,
    beforeRefresh: testOnlyProviderRefresh,
    onActivityChange: (delta) => { activeProviderRefreshes += delta; },
  });
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
    installationLeases: providerInstallationLeases,
    maintenanceJournal: providerMaintenanceJournal,
    installationIdentity: (target) =>
      providers.providerInstallationIdentityForMaintenance(
        target.providerId,
        target.executable,
        target.installedVersion,
      ),
    target: maintenanceTarget,
    capabilityAvailable: ({ providerId, executable }, capabilities) => providers.providerMaintenanceCapabilityAvailable(providerId, executable, capabilities.update !== null),
    refreshTarget: async (providerId, verificationAuthority) => {
      if (!verificationAuthority) throw new Error("Provider maintenance verification requires exact installation authority.");
      await providers.verifyInstallationConformance(providerId, options.defaultWorkspacePath, verificationAuthority);
      await refreshProviderInfo(
        providerId,
        true,
        true,
        verificationAuthority,
      );
      return maintenanceTarget(providerId);
    },
    invalidateInstallationEvidence: (providerId) =>
      providers.invalidateInstallationEvidence(providerId),
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
  backendProfileController.attachProviderMutationGuard((providerId) => providerMaintenance.hasBlockingAuthority(providerId));
  if (!runtimeSafetyLock && providerMaintenanceRecovery.length === 0) await backendProfileController.initialize();
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
          { fields, force: true, signal: runtimeLifetimeAbort.signal },
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
    { workspaceRuns, runtimeClosed: () => closed },
  );
  duoLaunches = duoLaunchCoordinator;

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
        providerMaintenanceBlocked: (providerId) =>
          providerMaintenance.hasBlockingAuthority(providerId),
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

  const startPostReadyWork = (): Promise<void> => {
    if (postReadyWorkStarted) return postReadyWork;
    if (closed || runtimeSafetyLock) return Promise.resolve();
    postReadyWorkStarted = true;

    // These best-effort tasks can own Git or provider child processes. They
    // begin only after the worker has published runtime.ready so a slow scan
    // cannot consume the bounded startup/recovery window or taint a generation
    // that never became usable.
    try {
      store.startBackups();
    } catch {
      // Backup scheduling is maintenance; startup remains authoritative.
    }
    projectIdentityRefresh = trackRuntimeOperation(() => projectIdentities
      .refreshAll(projectIdentityCandidates)
      .catch(() => undefined)
      .then(() => {
        if (!closed) broadcastSnapshot();
      })
      .then(() => testOnlyProjectIdentityRefresh))
      .catch(() => undefined);
    postReadyWork = trackRuntimeOperation(() =>
      duoLaunchCoordinator.resumeComparisons()
        .then(() => {
          if (!closed) broadcastSnapshot();
        }))
      .catch(() => undefined);
    artifactReconciliationActive = true;
    artifactReconciliation = trackRuntimeOperation(() =>
      turnGitArtifacts.reconcile()
        .then((changed) => {
          if (changed && !closed) broadcastSnapshot();
        }))
      .catch(() => undefined)
      .finally(() => {
        artifactReconciliationActive = false;
      });

    if (enableProviders) {
      void refreshProviderInfo(undefined, true).then(async () => {
        // Remote version advisories are best-effort UI data and own no
        // shutdown resources.
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
    return postReadyWork;
  };

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
    respondToInput: createPrivateConnectInputResponder(pendingInputs, turns),
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
    startPostReadyWork,
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
      runtimeLifetimeAbort.abort(new Error("The runtime is shutting down."));
      projectIdentities.dispose();
      snapshotBroadcasts.close();
      secureFileAuthorities.clear();
      await runRuntimeShutdownPhases({
        quiesceRuntimeWork: async ({ deadlineAt }) => {
          turnGitArtifacts.beginShutdown(deadlineAt);
          await gitInspectionLifecycle.cancelAndDrainWhile(async () => {
            await gitScanCoordinator.cancelAndDrainWhile(async () => {
              await updatePreparation.drainTracked();
              await projectIdentities.drain();
            });
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
