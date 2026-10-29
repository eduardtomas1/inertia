import { usageLimitsRuntime } from "./usage/runtime";
import { createIssueReportCommandHandler } from "./runtime/commands/issue-report-commands";
import { createCliConversationCommandHandler } from "./runtime/commands/cli-conversation-commands";
import { githubIssuePublisher } from "./git/github-issue-report";
import { storeMascotStatus } from "./runtime/mascot-status";
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
import { prepareGitExecutable } from "./git/runner";
import { TurnController } from "./runtime/turns/turn-controller";
import { dispatchSettledTurnOwners } from "./runtime/turns/turn-settled-orchestration";
import { createConversationTitleRuntime } from "./runtime/conversation-title-service";
import { DuoLaunchCoordinator } from "./runtime/duo/duo-launch-coordinator";
import { resolveAuthoritativeProjectPath } from "./project-path";
import { PROVIDER_IDS, ProviderManager } from "./providers";
import { ProviderMetadataCache, type ProviderMetadata } from "./provider/metadata";
import { createManualUsageRefresh, createRateLimitChangeSignal, createTurnUsageRefresh, startIdleRateLimitRefresh, type ProviderUsageRefreshDependencies } from "./runtime/provider-usage-refresh";
import { ProviderMaintenanceController } from "./provider/maintenance-controller";
import type { ProviderMaintenanceTarget } from "./provider/maintenance-capabilities";
import {
  ProviderInstallationLeaseCoordinator,
} from "./provider/installation-lease";
import { recoverProviderMaintenanceJournal } from
  "./provider/maintenance-recovery";
import { createProviderInfoRefresh, providerInstallationVerifier } from "./provider/provider-info-refresh";
import { ProviderTerminalResumeRegistry } from "./provider/terminal-resume";
import { providerCleanupIncident } from "./provider/run-cleanup-settlement";
import { TerminalManager } from "./terminal";
import { windowsCleanupFailures } from "./windows-cleanup-diagnostics";
import { runRuntimeShutdownPhases, RuntimeShutdownDeadlineError, settleAllOrThrow } from "./runtime-shutdown";
import { createTestShutdownTrace } from "./runtime/test-shutdown-trace";
import { requireRuntimeDirectory as ensureDirectory } from "./runtime-commands";
import { publicRuntimeError as publicError, RuntimeRequestError as RequestError, userCorrectableRuntimeError } from "./runtime-errors";
import { ScratchWorkspace } from "./runtime/scratch-workspace";
import { PostReadyWork, shellSnapshotDigest } from "./runtime/post-ready-work";
import { isWithinScratchRoot, SCRATCH_RECOVERY_TARGET_REFUSAL } from "./scratch-root";
import {
  ProjectIdentityRefresher,
  projectIdentityIsUsable,
} from "./project-identity-refresh";
import { TurnGitArtifactManager } from "./turn-git-artifacts";
import { CommandIncidents } from "./runtime/command-incidents";
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
import { startProjectAutoPull } from "./runtime/project-auto-pull";
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
import { createWatcherRuntime, type WatcherRuntime } from "./runtime/watcher/watcher-runtime";
import { createWatcherTurnPolicy } from "./runtime/watcher/watcher-turn-policy";
import { createIsolatedReviewCommandHandler } from "./runtime/commands/isolated-review-commands";
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
import type { TurnInteractionCommandDependencies } from "./runtime/commands/turn-interaction-commands";
import { createQueuedMessageRuntime } from "./runtime/queued-message-runtime";
import { createConversationCompactionCommandHandler } from "./runtime/commands/conversation-compaction-commands";
import { ConversationCompactionStates } from "./runtime/conversation-compaction-states";
import { createReadCommandHandlers } from "./runtime/commands/read-commands";
import { createTodoCommandHandler } from "./runtime/commands/todo-commands";
import { createCustomAgentCommandHandler } from "./runtime/commands/custom-agent-commands"; import { createSecretRequestCommandHandler } from "./runtime/commands/secret-request-commands";
import {
  createAgentWorkflowCommandHandler,
} from "./runtime/commands/agent-workflow-commands";
import { AgentWorkflowController } from "./runtime/agent-workflow-controller";
import { createAgentThreadRuntime, type AgentThreadRuntime } from "./runtime/agent-thread-runtime";
import {
  attachRuntimeWebSocketBoundary,
} from "./runtime/websocket-boundary";
import { TrustedAttachmentResolver, conversationAttachmentReadRoots } from "./runtime/attachments/trusted-attachment-resolver";
import { PrivateGeneratedAttachmentStore } from "./runtime/attachments/private-generated-attachments";
import { unavailableSecureFileBroker } from "./secure-files";
import { SecureFileAuthorityRegistry } from "./runtime/secure-file-authorities";
import { PrivateConnectRuntimeGateway } from "./private-connect/runtime-gateway";
import { privateConnectStoreReads } from "./private-connect/store-detail";
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
import { DatabaseRecoveryImportAdmission } from "./database-recovery-import-admission";
import { gitScanCoordinator } from "./git/scan-coordinator";
import { gitInspectionLifecycle } from "./git/inspection-lifecycle";
import { recordSystemSuspendInterval } from "./runtime/system-suspend-coordinator";
import {
  initializeRuntimePersistence,
  prepareRuntimeStartupRecovery,
  runtimeSafetyError,
} from "./runtime-startup-recovery";
import { providerRunOwnershipDiagnostics, runtimeLifecycleDiagnosticSnapshot } from "./lifecycle-diagnostics";
import { RuntimeStartupBlockerError } from
  "../shared/runtime-startup-diagnostics";
export type {
  RunningRuntime,
  RuntimeOptions,
} from "./runtime-types";
export {
  assembleReadOnlyReviewRequest,
} from "./runtime/commands/review-support";
export async function startRuntime(options: RuntimeOptions): Promise<RunningRuntime> {
  const mascotStatus = storeMascotStatus(options.onMascotStatus, () => store);
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
  await prepareGitExecutable();
  const generatedAttachments = await PrivateGeneratedAttachmentStore.create(
    dataDirectory,
    {
      preserveExisting: runtimeSafetyLock
        || manuallyRetiredGenerations.length > 0
        || authorizedModernGenerationIds.size > 0
        || startupRecovery.exitedUnconfirmedGenerations.length > 0,
    },
  );
  const databasePath = join(dataDirectory, "inertia.sqlite");
  let turns: TurnController;
  let agentThreads: AgentThreadRuntime | undefined;
  let duoLaunches: DuoLaunchCoordinator | null = null;
  let watchers: WatcherRuntime | undefined;
  let closed = false;
  let closing: Promise<void> | null = null;
  const runtimeLifetimeAbort = new AbortController();
  // These best-effort tasks can own Git or provider child processes. They
  // begin only after the worker has published runtime.ready so a slow scan
  // cannot consume the bounded startup/recovery window or taint a generation
  // that never became usable.
  const postReady = new PostReadyWork({
    isClosed: () => closed, isBlocked: () => runtimeSafetyLock, track: (operation) => trackRuntimeOperation(operation),
    startBackups: () => store.startBackups(),
    refreshProjectIdentities: () => projectIdentities.refreshAll(projectIdentityCandidates),
    afterProjectIdentityRefresh: () => testOnlyProjectIdentityRefresh,
    reconcileWorkspaces: () => Promise.all([
      new ScratchWorkspace(store, dataDirectory).reconcile().catch(() => undefined),
      duoLaunchCoordinator.resumeComparisons(),
      Promise.resolve(watchers?.resume()),
    ]),
    reconcileArtifacts: () => turnGitArtifacts.reconcile(),
    snapshotDigest: () => shellSnapshotDigest(currentSnapshot()),
    broadcastSnapshot: () => broadcastSnapshot(),
    startProviderDiscovery: () => {
      if (!enableProviders) return;
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
      startIdleRateLimitRefresh(providerUsage);
    },
  });
  const recoveryImportAdmission = new DatabaseRecoveryImportAdmission();
  let activeRuntimeCommands = 0;
  const updatePreparation = new RuntimeUpdatePreparationGate({
    isClosed: () => closed,
    activeRuntimeCommands: () => activeRuntimeCommands,
    databaseRecoveryActive: () => recoveryImportAdmission.isActive(),
    agentWorkActive: (ignoringTurns = false) => (!ignoringTurns && turns.activeConversationIds().length > 0)
      || isolatedRuns.activeCount() > 0
      || store.hasRecordedActiveWorkspaceRun(ignoringTurns),
    terminalActivity: () => terminals.hasUpdateBlockingActivity(),
    providerMaintenanceActive: () => providerMaintenance.hasBlockingAuthority(),
    providerRefreshActive: () => activeProviderRefreshes > 0,
    artifactReconciliationActive: () => postReady.artifactReconciliationActive,
    holdTerminalAdmission: () => terminals.holdForUpdatePreparation(),
    releaseTerminalAdmission: () => terminals.releaseUpdatePreparation(),
    drainAdditionalOperations: async () => {
      await projectIdentities.drain();
      await postReady.artifactReconciliation;
    },
  });
  const trackRuntimeOperation = <T>(operation: () => Promise<T>): Promise<T> =>
    updatePreparation.track(operation);
  const streamingTrace = createTestStreamingTrace(dataDirectory);
  const commandIncidents = CommandIncidents.fromSink(options.onIncident, options.runtimeGenerationId ?? null, userCorrectableRuntimeError);
  const send = commandIncidents.sender(streamingTrace);
  let onDatabaseBackupCreated = (): void => undefined;
  const testInitialBackupDelayMs = process.env.NODE_ENV === "test" ? Number(process.env.INERTIA_TEST_DATABASE_INITIAL_BACKUP_DELAY_MS ?? 0) : 0;
  const store = new RuntimeStore(
    databasePath,
    options.defaultWorkspacePath,
    {
      recoverInterruptedRuns: false,
      canStartDatabaseBackup: () =>
        !closed
        && !recoveryImportAdmission.isActive()
        && activeRuntimeCommands === 0
        && (turns?.activeConversationIds().length ?? 0) === 0,
      onDatabaseBackupCreated: () => onDatabaseBackupCreated(),
      ...(testInitialBackupDelayMs > 0 ? { databaseBackupInitialDelayMs: testInitialBackupDelayMs } : {}),
    },
  );
  const {
    conversationAttachments: initializedConversationAttachments,
    recovery,
    providerMaintenanceJournal,
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
  const secureFiles = options.secureFiles ?? unavailableSecureFileBroker;
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
  const projectIdentityCandidates = store.shellSnapshot().projects
    .filter(({ workspaceKind }) => workspaceKind !== "scratch")
    .map(({ id, path }) => ({ id, path }));
  const projectIdentityAuthority = {
    revalidate: async (projectId: string, projectPath: string) => {
      if (store.project(projectId).workspaceKind === "scratch") return true;
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
  const terminals = new TerminalManager({
    windowsTerminalAuthority: options.windowsTerminalAuthority,
    onOwnedProcessCleanupUnconfirmed:
      options.onOwnedProcessCleanupUnconfirmed,
  });
  const providerTerminalResumes = new ProviderTerminalResumeRegistry(store.conversationWork);
  const compactions = new ConversationCompactionStates();
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
    signal: runtimeLifetimeAbort.signal,
  });
  let recoveryBlockedProviders = new Set(providerMaintenanceJournal.pending().map(
    (record) => record.installationIdentity.providerId,
  ));
  const providers = ProviderManager.createProduction({
    providerRecoveryPending: (providerId) => recoveryBlockedProviders.has(providerId),
    metadataCache,
    installationLeases: providerInstallationLeases,
    lifetimeSignal: runtimeLifetimeAbort.signal,
    conversationProviderGate: (conversationId, providerId) => store.assertConversationProvider(conversationId, providerId),
    onRunCleanupUnconfirmed: (identity, reason) => commandIncidents.report(providerCleanupIncident(identity, reason)),
    onRunCleanupConfirmedLate: (identity) => turns.providerCleanupConfirmedLate(identity),
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
    verificationEnabled: options.enableProviders !== false,
  }).catch(() => {
    throw new RuntimeStartupBlockerError(
      "provider-installation-quarantined",
      "Provider installation recovery requires manual attention.",
    );
  });
  const enableProviders = !runtimeSafetyLock
    && (options.enableProviders ?? true);
  const agentWorkflows = new AgentWorkflowController(store, providers);
  const attachmentResolver = options.attachmentRoot && options.attachments
    ? new TrustedAttachmentResolver(
        resolve(options.attachmentRoot),
        options.attachments,
      )
    : null;
  const cachedProviderMetadata = Object.fromEntries(PROVIDER_IDS.map((providerId) => [providerId, providers.cachedMetadata(providerId)]));
  recoveryBlockedProviders = new Set(providerMaintenanceRecovery.map(
    (record) => record.installationIdentity.providerId,
  ));
  let providerInfo = initialProviderSnapshots(enableProviders, cachedProviderMetadata, recoveryBlockedProviders);
  let providerMaintenance: ProviderMaintenanceController;
  const runtimeSync = new RuntimeSyncHub<WebSocket>(send, undefined, (linkId) => store.watcherLinks.get(linkId));
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
    if (run.kind === "check" || run.kind === "service" || run.kind === "source-control") {
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
      ...(turns?.withProviderActivity(conversation) ?? conversation),
      pendingApproval: approvalConversationIds.has(conversation.id),
      pendingInput: inputConversationIds.has(conversation.id),
      compaction: compactions.state(conversation.id),
    }));
    mascotStatus.replace(conversations, snapshot.projects, snapshot.runs);
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
        ...providerRunOwnershipDiagnostics(store, providerRunOwnership),
        terminalOwnershipCount: terminals.ownedResourceCount(), interactionCount: pendingApprovals.size + pendingInputs.size,
        windowsCleanupFailures: windowsCleanupFailures(),
      }),
      sync,
    };
  };
  const detachedChatRuntimeSecurity = createDetachedChatRuntimeSecurity({ websocketPath, store, snapshot: currentSnapshot, pendingApprovals, pendingInputs });
  const broadcast = (event: RuntimeMutationEvent): void => {
    mascotStatus.observe(event);
    watchers?.observe(event);
    runtimeSync.broadcast(event);
  };
  const broadcastConversationShell = (conversationId: string): void => {
    const conversation = store.conversationShell(conversationId);
    if (!conversation) return;
    broadcast({
      type: "conversation.shell.updated",
      conversation: {
        ...(turns?.withProviderActivity(conversation) ?? conversation),
        pendingApproval: [...pendingApprovals.values()].some(
          (request) => request.conversationId === conversationId,
        ),
        pendingInput: [...pendingInputs.values()].some(
          (request) => request.conversationId === conversationId,
        ),
        compaction: compactions.state(conversationId),
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
  backendProfileController.attachChangeListener(broadcastSnapshot);
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
      lifetimeSignal: runtimeLifetimeAbort.signal,
    },
  );
  startProjectAutoPull({
    store, workspaceRuns, signal: runtimeLifetimeAbort.signal, track: trackRuntimeOperation,
    idle: () => !closed && !updatePreparation.isAdmissionClosed() && activeRuntimeCommands === 0
      && !recoveryImportAdmission.isActive() && turns.activeConversationIds().length === 0 && isolatedRuns.activeCount() === 0 && !terminals.hasUpdateBlockingActivity(),
    reportIncident: commandIncidents.report, cleanupFailed: options.onOwnedProcessCleanupUnconfirmed,
  });
  const rateLimitChanges = createRateLimitChangeSignal();
  const applyProviderMetadata = (providerId: ProviderInfo["id"], metadata: ProviderMetadata): void => {
    providerInfo = providerInfo.map((current) => current.id === providerId ? {
      ...current,
      models: metadata.models,
      rateLimits: metadata.rateLimits,
      metadataState: metadata.metadataState,
    } : current);
    rateLimitChanges.notify();
  };
  let activeProviderRefreshes = 0;
  const refreshProviderInfo = createProviderInfoRefresh({
    enabled: enableProviders,
    providers,
    defaultWorkspacePath: options.defaultWorkspacePath,
    lifetimeSignal: runtimeLifetimeAbort.signal,
    providerInfo: () => providerInfo,
    replaceProviderInfo: (value) => { providerInfo = value; rateLimitChanges.notify(); },
    reportIncident: commandIncidents.report,
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
    startupRecoveryOperationIds: new Set(providerMaintenanceRecovery.map(({ operationId }) => operationId)),
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
  if (!runtimeSafetyLock) await backendProfileController.initialize(recoveryBlockedProviders);
  const workspacePath = (projectId: string, conversationId?: string): string => {
    if (!conversationId && store.project(projectId).workspaceKind === "scratch") {
      throw new RequestError("Choose a chat to use its own workspace folder.");
    }
    if (!conversationId) return ensureDirectory(store.projectPath(projectId));
    const conversation = store.conversation(conversationId);
    if (conversation.projectId !== projectId) throw new RequestError("The thread does not belong to this project.");
    return ensureDirectory(store.conversationPath(conversationId));
  };
  const providerUsage: ProviderUsageRefreshDependencies<ProviderMetadata> = {
    enabled: enableProviders,
    signal: runtimeLifetimeAbort.signal,
    isClosed: () => closed,
    cachedState: (providerId) => providers.cachedMetadata(providerId),
    read: (providerId, fields) => providers.metadata(providerId, options.defaultWorkspacePath, { fields, force: true, signal: runtimeLifetimeAbort.signal }),
    apply: applyProviderMetadata,
    broadcastSnapshot,
    isExternalTurn: (turnId) => backendProfileController.isExternalSelection(store.agentTurn(turnId).modelSelection),
    canRun: (providerId) => providerInfo.some(({ id, canRun }) => id === providerId && canRun),
    activeProviderIds: () => new Set(turns.activeConversationIds().flatMap((conversationId) => {
      try { return [store.conversation(conversationId).providerId]; } catch { return []; }
    })),
    track: trackRuntimeOperation,
    clientPresent: () => runtimeSync.connectionCount > 0,
    subscribeClientConnected: (listener) => runtimeSync.onClientConnected(listener),
    subscribeRateLimitsChanged: rateLimitChanges.subscribe,
  };
  const conversationTitles = createConversationTitleRuntime({
    store, providers, backendProfileController, broadcastSnapshot, signal: runtimeLifetimeAbort.signal,
    track: (operation) => recoveryImportAdmission.admit(() => trackRuntimeOperation(operation)),
  });
  let queuedMessages: ReturnType<typeof createQueuedMessageRuntime> | undefined;
  const watcherPolicy = createWatcherTurnPolicy(store, (input) => agentThreads?.manager.contextOnlyBridgeFor(input));
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
      reportIncident: commandIncidents.report,
      harnessInstructionsForTurn: (input) => watcherPolicy.harnessInstructionsFor(input) ?? agentThreads?.manager.capabilityInstructions() ?? [],
      watcherInstructionsForTurn: (input) => watcherPolicy.watcherInstructionsFor(input),
      hostToolsForTurn: (input) => watcherPolicy.hostToolsForTurn(input) ?? agentThreads?.manager.bridgeFor(input),
      onReadOnlyViolation: (turn, violation) => watchers?.onReadOnlyViolation(turn, violation),
      onPlanHandoff: (turn, text) => watchers?.onPlanHandoff(turn, text),
      applyProviderMetadata: (event) => {
        applyProviderMetadata(event.providerId, providers.cachedMetadata(event.providerId));
      },
      onNativeGoalSynchronized: ({ conversationId, providerSessionId }) => {
        return agentWorkflows.acknowledgeNativeGoalSynchronization(
          conversationId,
          providerSessionId,
        );
      },
      createTurnCheckpoint: (turn, signal) => turnGitArtifacts.createTurnCheckpoint(turn, signal),
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
      attachmentReadRoots: conversationAttachmentReadRoots(store, initializedConversationAttachments),
      validateModelSelection: (selection) =>
        backendProfileController.validateSelection(selection),
      refreshProviderMetadata: createTurnUsageRefresh(providerUsage),
      onTurnSettled: (turn, settlement) => dispatchSettledTurnOwners(turn, [
        (settled) => queuedMessages?.onTurnSettled(settled),
        (settled) => conversationTitles.onTurnSettled(settled, settlement),
        (settled) => agentThreads?.manager.onSourceTurnSettled(settled),
        (settled) => duoLaunches?.onTurnSettled(settled),
        (settled) => watchers?.onTurnSettled(settled),
        (settled) => testOnlyOnTurnSettled?.(settled),
      ], () => store.createInitialBackup({ quietGraceMs: 1_000 })),
      testOnlyStreamingTrace: streamingTrace, secretOutput: () => agentThreads?.secrets.output,
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
    conversationAttachments: initializedConversationAttachments,
    agentBrowser: options.agentBrowser, watcherPolicy, backendCredentials: options.backendCredentials, lifetime: runtimeLifetimeAbort.signal,
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
  const turnInteractionDependencies: TurnInteractionCommandDependencies = {
    store, conversationAttachments: initializedConversationAttachments,
    backendProfileController, turns, isolatedRuns, workspaceRuns,
    pendingApprovals, pendingInputs, dataDirectory, enableProviders,
    attachmentResolver, generatedAttachments,
    prepareDocumentAttachments: options.prepareDocumentAttachments,
    workflows: agentWorkflows, providerTerminalResumes,
    providerInfo: () => providerInfo,
    verifyProviderInstallation: providerInstallationVerifier(providers, refreshProviderInfo),
    broadcast, broadcastSnapshot, send,
  };
  queuedMessages = createQueuedMessageRuntime(turnInteractionDependencies, {
    signal: runtimeLifetimeAbort.signal, track: (operation) => recoveryImportAdmission.admit(() => trackRuntimeOperation(operation)),
    onWatcherNoteUndelivered: (note, reason) => watchers?.delivery.noteUndelivered(note, reason),
    compacting: (conversationId) => compactions.isCompacting(conversationId),
  });
  compactions.onSettled((conversationId) => queuedMessages?.onCompactionSettled(conversationId));
  queuedMessages.start();
  watchers = createWatcherRuntime({ store, turns, providers, backendProfileController, providerInfo: () => providerInfo, policy: watcherPolicy, signal: runtimeLifetimeAbort.signal,
    interaction: turnInteractionDependencies, queuedMessages, broadcast, broadcastSnapshot: flushSnapshot, broadcastConversationShell, send,
    turnDiff: (turnId) => turnGitArtifacts.settledTurnDiff(turnId) });
  const usageRuntime = usageLimitsRuntime(store, providers, backendProfileController, () => providerInfo, options.defaultWorkspacePath, runtimeLifetimeAbort.signal, enableProviders, options.backendCredentials, send, {
    dependencies: turnInteractionDependencies, track: (operation) => recoveryImportAdmission.admit(() => trackRuntimeOperation(operation)), providerMaintenance, updatePreparation,
  });
  const executeCommand = createRuntimeCommandExecutor({
    handlers: [
      createCliConversationCommandHandler({ store, providers, signal: runtimeLifetimeAbort.signal, broadcastSnapshot: flushSnapshot, send, secretValues: () => agentThreads?.secrets.output.values() ?? [] }),
      queuedMessages.handler,
      ...usageRuntime.handlers,
      createIssueReportCommandHandler({ store, evidence: options.issueEvidence, snapshot: currentSnapshot, providerInfo: () => providerInfo, publisher: githubIssuePublisher(dataDirectory, runtimeLifetimeAbort.signal), send }),
      createDuoCommandHandler({ coordinator: duoLaunchCoordinator, visibleLaunchIds: detachedChatRuntimeSecurity.visibleDuoLaunchIds, broadcastSnapshot: flushSnapshot, send }),
      watchers.handler,
      createTodoCommandHandler({ ...turnInteractionDependencies, creation: agentThreads.creation, broadcastSnapshot: flushSnapshot }),
      createCustomAgentCommandHandler({ store }), createSecretRequestCommandHandler({ service: () => agentThreads?.secrets ?? null, send }),
      createAgentWorkflowCommandHandler({
        workflows: agentWorkflows, providerTerminalResumes,
        conversationWork: store.conversationWork,
        broadcast,
        send,
      }),
      createProviderCommandHandler({
        providers, providerMaintenance, terminals, defaultWorkspacePath: options.defaultWorkspacePath, currentSnapshot,
        refreshProviderInfo, refreshProviderUsage: createManualUsageRefresh(providerUsage), send,
      }),
      ...createReadCommandHandlers({ store, send, databasePath, lifetimeSignal: runtimeLifetimeAbort.signal, reveal: (target) => runtimeSync.focusDetachedMessage(target), canStopWorkspaceRun }),
      createConversationCommandHandler({
        store, conversationAttachments: initializedConversationAttachments,
        providers,
        backendProfileController,
        workspaceRuns,
        providerTerminalResumes,
        duoLaunches: duoLaunchCoordinator, watchers,
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
        reportIncident: commandIncidents.report,
      }),
      queuedMessages.turnInteractionHandler,
      createConversationCompactionCommandHandler({ store, providers, backendProfileController, turns, isolatedRuns, providerTerminalResumes, enableProviders, lifetimeSignal: runtimeLifetimeAbort.signal, compactions, instructions: turns, interaction: turnInteractionDependencies, settings: () => store.shellSnapshot().settings, refreshProviderAccount: (providerId) => refreshProviderInfo(providerId), providerInfo: () => providerInfo, broadcast, broadcastConversationShell, send }),
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
        backendProfileController,
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
        store, turns, conversationAttachments: initializedConversationAttachments,
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
        dataDirectory,
        workspaceRuns,
        turns,
        providers,
        providerTerminalResumes,
        duoLaunches: duoLaunchCoordinator, watchers,
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
        reportIncident: commandIncidents.report,
        send,
      }),
    ],
    send,
    broadcastSnapshot: flushSnapshot,
    publicError,
    onFailure: commandIncidents.noteFailure,
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
    if (recoveryImportAdmission.isActive()) {
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
        await executeCommand(socket, command, authority);
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
    dispatchCommand: (socket, command, authority) => commandIncidents.run(command, () => dispatchCommand(socket, command, authority)),
    consumeDetachedCapability: (url) => detachedChatRuntimeSecurity.consumeCapability(url),
    beforeFreshSnapshot: () => turns.flushActiveStreamsForHydration(),
    currentSnapshot,
    approvals: () => pendingApprovals.values(),
    inputs: () => pendingInputs.values(),
    plans: () => agentPlans.values(),
    onConnect: () => postReady.clientConnected(),
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

  const privateConnectGateway = new PrivateConnectRuntimeGateway({
    shell: currentSnapshot,
    ...privateConnectStoreReads(store),
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
      privateConnectPromptSafetyForHarness(conversation.modelSelection.harnessId, { watcher: watcherPolicy.privateConnectWatcher(conversation) }),
    watcherParent: (conversationId) => watchers?.watcherParent(conversationId) ?? null,
    queuePrompt: (conversationId, content, deviceId) => queuePrivateConnectPrompt({
      store,
      authority: providerTerminalResumes,
      turns,
      isolatedRuns,
      compacting: (compactingConversationId) => compactions.isCompacting(compactingConversationId),
      onQueued: (queuedConversationId) => {
        broadcast({
          type: "conversation.detail.invalidated",
          conversationId: queuedConversationId,
        });
        broadcastSnapshot();
      },
    }, conversationId, content, deviceId),
    respondToInput: createPrivateConnectInputResponder(pendingInputs, turns),
    stopRun: (conversationId, runId) => {
      const run = store.findWorkspaceRun(runId);
      if (!run || run.conversationId !== conversationId) return { stopped: false, alreadyStopped: false };
      if (run.status !== "running" && run.status !== "waiting") return { stopped: false, alreadyStopped: true };
      const stopped = isolatedRuns.stopConversation(conversationId) || turns.cancel(conversationId);
      return { stopped, alreadyStopped: false };
    },
    inputs: () => pendingInputs.values(),
  });

  currentSnapshot();
  return {
    runPackageSmokeImage: (inputPath, resultPath, signal) =>
      runPackagedImageRetentionSmoke(
        inputPath,
        resultPath,
        initializedConversationAttachments,
        signal,
      ),
    startPostReadyWork: () => postReady.start(),
    startPostReadyWorkAfterFirstClient: () => postReady.startAfterFirstClient(),
    websocketUrl,
    focusMascotChat: (conversationId, request) => mascotStatus.focus(conversationId, request),
    databaseRecovery: store.databaseRecoveryReport(),
    recordSystemSuspendInterval: (interval) => recordSystemSuspendInterval(store, interval, broadcast, broadcastSnapshot, turns, refreshProviderInfo.rediscoverAfterSystemResume),
    prepareForUpdate: (operationId) => postReady.beforeUpdatePreparation(() => updatePreparation.prepare(operationId)),
    releaseUpdatePreparation: (operationId) =>
      updatePreparation.release(operationId),
    readHtmlRender: (renderId) => store.htmlRenders.read(renderId), deliverAgentSecret: (delivery) => agentThreads!.secrets.deliver(delivery),
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
      : recoveryImportAdmission.isActive()
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
      : recoveryImportAdmission.isActive()
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
        : recoveryImportAdmission.isActive()
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
        if (!operationId) {
          throw new Error("The database recovery import identity is required.");
        }
        if (isWithinScratchRoot(dataDirectory, targetDirectory)) {
          throw new Error(SCRATCH_RECOVERY_TARGET_REFUSAL);
        }
        recoveryImportAdmission.begin();
        try {
          if (activeRuntimeCommands > 0) {
            await new Promise<void>((resolveDrain) => {
              runtimeCommandDrainWaiters.add(resolveDrain);
            });
          }
          await recoveryImportAdmission.drain();
          await postReady.identityRefresh;
          await postReady.artifactReconciliation;
          if (
            turns.activeConversationIds().length > 0
            || store.hasRecordedActiveWorkspaceRun()
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
          await new ScratchWorkspace(store, dataDirectory).reconcile().catch(() => undefined);
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
          recoveryImportAdmission.end();
        }
      }),
    close: (cause = "runtime-shutdown") => {
      if (closing) return closing;
      closed = true;
      // Publish the shared result before shutdown callbacks run. Admission is
      // already closed, and every caller must observe the same cleanup proof.
      closing = Promise.resolve().then(async () => {
        const shutdownTrace = createTestShutdownTrace(dataDirectory);
        runtimeLifetimeAbort.abort(new Error("The runtime is shutting down."));
        projectIdentities.dispose();
        snapshotBroadcasts.close();
        mascotStatus.close();
        watchers?.dispose();
        secureFileAuthorities.clear();
        try {
          await runRuntimeShutdownPhases({
            quiesceRuntimeWork: ({ deadlineAt }) => shutdownTrace.observe("commands", async () => {
              turnGitArtifacts.beginShutdown(deadlineAt);
              providers.beginShutdown(deadlineAt);
              await gitInspectionLifecycle.cancelAndDrainWhile(async () => {
                await gitScanCoordinator.cancelAndDrainWhile(async () => {
                  await updatePreparation.drainTracked();
                  await projectIdentities.drain();
                });
              });
            }),
            independentDrains: [
              () => shutdownTrace.observe("attachments", () => initializedConversationAttachments.close()),
              ({ deadlineAt }) => shutdownTrace.observe("terminals", () => terminals.disposeAll(deadlineAt)),
              () => shutdownTrace.observe("maintenance", () => providerMaintenance.dispose()),
            ],
            stopIsolatedRuns: () => shutdownTrace.observe("isolated-runs", () => isolatedRuns.dispose(cause)),
            disposeTurnsAndProviders: () => shutdownTrace.observe("turns-providers", () => turns.dispose(cause)),
            settleArtifacts: async () => {
              await shutdownTrace.observe("artifact-reconciliation", () => postReady.artifactReconciliation);
              await shutdownTrace.observe("artifact-settlement", () => turnGitArtifacts.settleShutdown());
            },
            terminateClients: () => shutdownTrace.observe("clients", () => runtimeSync.terminateAll((client) => client.terminate())),
            closeServer: () => settleAllOrThrow([
              shutdownTrace.observe("websocket", () => webSocketBoundary.close()),
              shutdownTrace.observe("http-server", () => new Promise<void>((resolveClose) => server.close(() => resolveClose()))),
            ]),
            closeStore: () => shutdownTrace.observe("store", () => store.backupAndClose()),
          });
        } catch (error) {
          shutdownTrace.failure(error instanceof RuntimeShutdownDeadlineError ? error.phase : null);
          throw error;
        }
      });
      return closing;
    },
  };
}
