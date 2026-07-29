import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
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
import type { OpenProjectPathRequest } from "../shared/desktop";
import type { BackendCredentialStatus } from "../shared/backend-credentials";
import { RuntimeStore } from "./database";
import { TurnController } from "./runtime/turns/turn-controller";
import { recoverInterruptedTurns } from "./runtime/turns/turn-recovery";
import { resolveAuthoritativeProjectPath } from "./project-path";
import { PROVIDER_IDS, ProviderManager, type ProviderDetection } from "./providers";
import { ProviderMetadataCache, type ProviderMetadata } from "./provider/metadata";
import { ProviderMaintenanceController } from "./provider/maintenance-controller";
import type { ProviderMaintenanceTarget } from "./provider/maintenance-capabilities";
import { TerminalManager } from "./terminal";
import { requireRuntimeDirectory as ensureDirectory } from "./runtime-commands";
import { publicRuntimeError as publicError, RuntimeRequestError as RequestError } from "./runtime-errors";
import { inspectProjectIdentity } from "./project-identity";
import { TurnGitArtifactManager } from "./turn-git-artifacts";
import {
  sendRuntimeEvent as send,
} from "./runtime-protocol";
import {
  initialProviderSnapshots,
  providerSnapshot,
} from "./runtime-snapshots";
import {
  DEFAULT_REVIEW_SUMMARY_TIMEOUT_MS,
} from "./review-summary";
import {
  IsolatedRunController,
} from "./runtime/reviews/isolated-run-controller";
import {
  BackendProfileController,
} from "./runtime/backends/backend-profile-controller";
import type { AgentHarnessRegistry } from "./provider/agent-harness-registry";
import type { ClaudeCompatibleBackendProfile } from "../shared/claude-backend-profiles";
import { RuntimeSyncHub } from "./runtime/runtime-sync-hub";
import { WorkspaceRunController } from "./runtime/workspace-run-controller";
import {
  createRuntimeCommandExecutor,
} from "./runtime/commands/command-router";
import {
  createConversationCommandHandler,
} from "./runtime/commands/conversation-commands";
import {
  createDiffReviewCommandHandler,
} from "./runtime/commands/diff-review-commands";
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
import {
  createSourceControlCommandHandler,
} from "./runtime/commands/source-control-commands";
import {
  createTurnInteractionCommandHandler,
} from "./runtime/commands/turn-interaction-commands";
import {
  createAgentWorkflowCommandHandler,
} from "./runtime/commands/agent-workflow-commands";
import { AgentWorkflowController } from "./runtime/agent-workflow-controller";
import {
  attachRuntimeWebSocketBoundary,
} from "./runtime/websocket-boundary";
import {
  TrustedAttachmentResolver,
  type RuntimeAttachmentBroker,
} from "./runtime/attachments/trusted-attachment-resolver";
import {
  SecureFileError,
  type RuntimeSecureFileBroker,
} from "./secure-files";
import { SecureFileAuthorityRegistry } from "./runtime/secure-file-authorities";

export {
  assembleReadOnlyReviewRequest,
} from "./runtime/commands/review-support";

export interface RuntimeOptions {
  dataDirectory: string;
  defaultWorkspacePath: string;
  enableProviders?: boolean;
  /** Trusted host override used before persisted settings are available. */
  codexBinaryPath?: string;
  reviewSummaryTimeoutMs?: number;
  /** Full profiles remain in the privileged runtime and never enter snapshots. */
  kimiClaudeProfiles?: readonly ClaudeCompatibleBackendProfile[];
  backendCredentials?: RuntimeBackendCredentialBroker;
  /** Trusted main-process import root and capability broker. */
  attachmentRoot?: string;
  attachments?: RuntimeAttachmentBroker;
  /** Test and embedding seam; the desktop runtime uses the default registry. */
  agentHarnessRegistry?: AgentHarnessRegistry;
  /** Main-owned root-relative file broker for untrusted workspace paths. */
  secureFiles?: RuntimeSecureFileBroker;
}

export interface RuntimeBackendCredentialBroker {
  resolve(secretReference: string, signal?: AbortSignal): Promise<string | null>;
  has(secretReference: string, signal?: AbortSignal): Promise<boolean>;
  status(secretReference: string, signal?: AbortSignal): Promise<BackendCredentialStatus>;
  clear(secretReference: string, signal?: AbortSignal): Promise<boolean>;
  forget(secretReference: string, signal?: AbortSignal): Promise<boolean>;
}

export interface RunningRuntime {
  websocketUrl: string;
  resolveProjectPath: (request: OpenProjectPathRequest) => Promise<string>;
  close: (cause?: "runtime-shutdown" | "runtime-crash") => Promise<void>;
}

export async function startRuntime(options: RuntimeOptions): Promise<RunningRuntime> {
  const dataDirectory = resolve(options.dataDirectory);
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const store = new RuntimeStore(
    join(dataDirectory, "inertia.sqlite"),
    options.defaultWorkspacePath,
    { recoverInterruptedRuns: false },
  );
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
  const recovery = recoverInterruptedTurns(store);
  if (options.attachments && recovery.recoveredAttachmentIds.length > 0) {
    void Promise.allSettled(recovery.recoveredAttachmentIds.map(
      (attachmentId) => options.attachments!.cleanup(attachmentId),
    ));
  }
  await Promise.all(store.shellSnapshot().projects.map(async (project) => {
    try {
      const identity = await inspectProjectIdentity(project.path);
      store.updateProject(project.id, identity);
    } catch {
      // Missing or temporarily unavailable folders remain visible and isolated by their stored path.
    }
  }));
  const turnGitArtifacts = new TurnGitArtifactManager(store, dataDirectory);
  const enableProviders = options.enableProviders ?? true;
  const terminals = new TerminalManager();
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
  let turns: TurnController;
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
  let closed = false;
  let artifactReconciliation: Promise<void> | null = null;

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
    const approvalConversationIds = new Set(
      [...pendingApprovals.values()].map(({ conversationId }) => conversationId),
    );
    const inputConversationIds = new Set(
      [...pendingInputs.values()].map(({ conversationId }) => conversationId),
    );
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
  const broadcast = (event: RuntimeMutationEvent): void => {
    runtimeSync.broadcast(event);
  };
  const broadcastSnapshot = (): void => {
    runtimeSync.broadcastSnapshot(currentSnapshot);
  };
  workspaceRuns = new WorkspaceRunController(
    store,
    terminals,
    broadcastSnapshot,
    () => closed,
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
  const refreshProviderInfo = async (
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
      providerInfo: () => providerInfo,
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
    },
  );

  const dispatchCommand = createRuntimeCommandExecutor({
    handlers: [
      createAgentWorkflowCommandHandler({
        workflows: agentWorkflows,
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
      createConversationCommandHandler({
        store,
        providers,
        backendProfileController,
        workspaceRuns,
        runtimeSync,
        deletedConversationIds,
        dataDirectory,
        rememberDeletedConversation,
        broadcastSnapshot,
        publicError,
        send,
      }),
      createTurnInteractionCommandHandler({
        store,
        backendProfileController,
        turns,
        isolatedRuns,
        workspaceRuns,
        pendingApprovals,
        pendingInputs,
        dataDirectory,
        enableProviders,
        attachmentResolver,
        workflows: agentWorkflows,
        providerInfo: () => providerInfo,
        broadcastSnapshot,
        send,
      }),
      createSourceControlCommandHandler({
        store,
        workspaceRuns,
        turnGitArtifacts,
        secureFiles,
        secureFileAuthorities,
        dataDirectory,
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
        store,
        workspaceRuns,
        terminals,
        secureFiles,
        secureFileAuthorities,
        workspacePath,
        rememberDeletedConversation,
        broadcastSnapshot,
        send,
      }),
    ],
    send,
    broadcastSnapshot,
    publicError,
  });

  const webSocketBoundary = attachRuntimeWebSocketBoundary({
    server,
    websocketPath,
    runtimeSync,
    terminals,
    isolatedRuns,
    dispatchCommand,
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

  // Reconcile durable pending artifacts only after the runtime can serve the
  // already-terminal turn snapshot. Restart recovery must not hold the app
  // startup screen behind Git work.
  artifactReconciliation = turnGitArtifacts.reconcile()
    .then((changed) => {
      if (changed && !closed) broadcastSnapshot();
    })
    .catch(() => undefined);

  if (enableProviders) void refreshProviderInfo(undefined, true).then(() => {
    void providerMaintenance.refresh(PROVIDER_IDS, false).catch(() => undefined);
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

  return {
    websocketUrl: `ws://127.0.0.1:${address.port}${websocketPath}`,
    resolveProjectPath: async (request) => (await resolveAuthoritativeProjectPath(store, request)).absolute,
    close: async (cause = "runtime-shutdown") => {
      if (closed) return;
      closed = true;
      secureFileAuthorities.clear();
      terminals.disposeAll();
      await providerMaintenance.dispose();
      await isolatedRuns.dispose(cause);
      await turns.dispose(cause);
      await artifactReconciliation;
      runtimeSync.terminateAll((client) => client.terminate());
      await Promise.all([
        webSocketBoundary.close(),
        new Promise<void>((resolveClose) => server.close(() => resolveClose())),
      ]);
      store.close();
    },
  };
}
