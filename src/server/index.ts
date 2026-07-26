import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { isAbsolute, join, resolve } from "node:path";

import WebSocket, { WebSocketServer } from "ws";

import {
  type AgentApprovalRequest,
  type AgentInputRequest,
  type AgentPlan,
  type AppSnapshot,
  type ClientCommand,
  type CheckpointSummary,
  type GitStatusSnapshot,
  type Conversation,
  type ProviderInfo,
  type RuntimeMutationEvent,
  type RuntimeSyncCursor,
  type TurnRequestContext,
} from "../shared/contracts";
import type { OpenProjectPathRequest } from "../shared/desktop";
import type { BackendCredentialStatus } from "../shared/backend-credentials";
import {
  buildDiffContext,
  diffFileFingerprint,
  diffHunkFingerprint,
  DiffContextError,
  parseUnifiedDiff,
  selectedLineFingerprint,
} from "../shared/diff-review";
import { RuntimeStore } from "./database";
import { parseRuntimeResumeRequest } from "./runtime-sequencing";
import { TurnController } from "./runtime/turns/turn-controller";
import { recoverInterruptedTurns } from "./runtime/turns/turn-recovery";
import { CheckpointError, createCheckpoint, deleteCheckpoints, restoreCheckpoint } from "./checkpoints";
import { resolveAuthoritativeProjectPath } from "./project-path";
import {
  GitError,
  commitChanges,
  createBranch,
  createWorktree,
  getRepositoryStatus,
  getPullRequestCreateUrl,
  getUnifiedDiff,
  inspectDiffSelection,
  listBranches,
  pullRepository,
  pushCurrentBranch,
  revertDiffSelection,
  undoDiffSelection,
  removeWorktree,
  switchBranch,
} from "./git";
import { PROVIDER_IDS, ProviderManager, type ProviderDetection } from "./providers";
import { ProviderMetadataCache, type ProviderMetadata } from "./provider/metadata";
import { TerminalManager } from "./terminal";
import {
  listWorkspaceEntries,
  readWorkspaceTextFile,
  searchWorkspaceEntries,
} from "./workspace";
import { requireRuntimeDirectory as ensureDirectory } from "./runtime-commands";
import { publicRuntimeError as publicError, RuntimeRequestError as RequestError } from "./runtime-errors";
import { inspectProjectIdentity } from "./project-identity";
import {
  TurnGitArtifactError,
  TurnGitArtifactManager,
} from "./turn-git-artifacts";
import {
  isAllowedRuntimeOrigin as allowedOrigin,
  parseRuntimeCommand as parseCommand,
  rejectRuntimeUpgrade as rejectUpgrade,
  sendRuntimeEvent as send,
} from "./runtime-protocol";
import {
  changedFiles,
  emptyGitStatusSnapshot as emptyGitStatus,
  gitStatusSnapshot as statusSnapshot,
  initialProviderSnapshots,
  providerSnapshot,
} from "./runtime-snapshots";
import {
  buildReviewSummaryPrompt,
  DEFAULT_REVIEW_SUMMARY_TIMEOUT_MS,
  parseReviewSummaryResult,
  requireCurrentReviewSummaryFingerprint,
} from "./review-summary";
import {
  IsolatedRunController,
  IsolatedRunError,
  assembleReadOnlyReviewRequest as assembleIsolatedReadOnlyReviewRequest,
  isolatedRunSelection,
} from "./runtime/reviews/isolated-run-controller";
import {
  BackendProfileController,
} from "./runtime/backends/backend-profile-controller";
import type { AgentHarnessRegistry } from "./provider/agent-harness-registry";
import type { ClaudeCompatibleBackendProfile } from "../shared/claude-backend-profiles";
import {
  nativeModelSelection,
  type ModelSelection,
} from "../shared/model-routing";
import { resolveContinuationDecision } from "../shared/continuation-policy";
import { RuntimeSyncHub } from "./runtime/runtime-sync-hub";
import { WorkspaceRunController } from "./runtime/workspace-run-controller";

const MAX_PAYLOAD_BYTES = 256 * 1024;
const MAX_CLIENTS = 16;
const MAX_IN_FLIGHT_COMMANDS = 32;
const DEFAULT_DIFF_QUESTION = "Explain what this selected code does, why it changed, and any risks I should know about.";
const DEFAULT_DIFF_REVISION = "Review this selection and improve it while preserving the surrounding behavior.";

type ReviewSelectionPayload = Extract<ClientCommand, { type: "review.selection.ask" | "review.selection.revise" }>["payload"];
type ConversationUpdatePayload = Extract<ClientCommand, { type: "conversation.update" }>["payload"];

function requestedConversationModelSelection(
  current: Conversation,
  update: ConversationUpdatePayload,
): ModelSelection {
  if (update.modelSelection) return update.modelSelection;
  if (
    update.providerId === undefined
    && update.model === undefined
    && update.reasoningEffort === undefined
  ) return current.modelSelection;

  const providerId = update.providerId ?? current.providerId;
  const providerChanged = providerId !== current.providerId;
  return nativeModelSelection({
    providerId,
    modelId: update.model ?? (
      providerChanged ? "provider-default" : current.modelSelection.modelId
    ),
    alias: update.model ?? (
      providerChanged ? null : current.modelSelection.alias
    ),
    reasoningEffort: update.reasoningEffort ?? (
      providerChanged ? null : current.modelSelection.reasoningEffort
    ),
  });
}

export function assembleReadOnlyReviewRequest(
  cwd: string,
  visibleContent: string,
  context: TurnRequestContext,
) {
  return assembleIsolatedReadOnlyReviewRequest(cwd, visibleContent, context);
}

function providerLabel(providerId: ProviderInfo["id"]): string {
  return providerId === "codex" ? "Codex" : providerId === "claude" ? "Claude" : providerId === "cursor" ? "Cursor" : "OpenCode";
}

export interface RuntimeOptions {
  dataDirectory: string;
  defaultWorkspacePath: string;
  enableProviders?: boolean;
  reviewSummaryTimeoutMs?: number;
  /** Full profiles remain in the privileged runtime and never enter snapshots. */
  kimiClaudeProfiles?: readonly ClaudeCompatibleBackendProfile[];
  backendCredentials?: RuntimeBackendCredentialBroker;
  /** Test and embedding seam; the desktop runtime uses the default registry. */
  agentHarnessRegistry?: AgentHarnessRegistry;
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
  recoverInterruptedTurns(store);
  await Promise.all(store.shellSnapshot().projects.map(async (project) => {
    try {
      const identity = await inspectProjectIdentity(project.path);
      store.updateProject(project.id, identity);
    } catch {
      // Missing or temporarily unavailable folders remain visible and isolated by their stored path.
    }
  }));
  const turnGitArtifacts = new TurnGitArtifactManager(store, dataDirectory);
  await turnGitArtifacts.reconcile().catch(() => undefined);
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
    commands: savedSettings.codexBinaryPath ? { codex: savedSettings.codexBinaryPath } : undefined,
    ...backendProfileController.providerManagerOptions(),
  }, options.agentHarnessRegistry);
  backendProfileController.attachProviderManager(providers);
  const cachedProviderMetadata = Object.fromEntries(PROVIDER_IDS.map((providerId) => [providerId, providers.cachedMetadata(providerId)]));
  let turns: TurnController;
  let providerInfo = initialProviderSnapshots(enableProviders, cachedProviderMetadata);
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
  const webSockets = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES, perMessageDeflate: false });
  let closed = false;

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
      providerInfo = providerInfo.map((current) => current.id === providerId ? detected : current);
      if (!closed) broadcastSnapshot();
      if (!detection.canRun) return;
      const next = await enrichedSnapshot(detection);
      providerInfo = providerInfo.map((current) => current.id === providerId ? next : current);
    } else {
      providerInfo = await Promise.all((await providers.detectAll({
        cwd: options.defaultWorkspacePath,
        timeoutMs: 4_000,
        refreshEnvironment,
      })).map(enrichedSnapshot));
    }
    if (!closed) broadcastSnapshot();
  };
  const workspacePath = (projectId: string, conversationId?: string): string => {
    if (!conversationId) return ensureDirectory(store.projectPath(projectId));
    const conversation = store.conversation(conversationId);
    if (conversation.projectId !== projectId) throw new RequestError("The thread does not belong to this project.");
    return ensureDirectory(store.conversationPath(conversationId));
  };

  const reconcileReviews = (conversationId: string, patch: string): void => {
    const structured = parseUnifiedDiff(patch);
    const files: Record<string, string> = {};
    const hunks: Record<string, string> = {};
    for (const file of structured.files) {
      files[file.path] = diffFileFingerprint(file);
      for (const hunk of file.hunks) hunks[`${file.path}\0${hunk.id}`] = diffHunkFingerprint(file, hunk);
    }
    const notes: Record<string, string | null> = {};
    for (const note of store.reviewNotesFor(conversationId)) {
      const file = structured.files.find((candidate) => candidate.path === note.path);
      const hunk = file?.hunks.find((candidate) => candidate.id === note.hunkId);
      if (note.lineIds.length > 0) {
        notes[note.id] = file && hunk && note.lineIds.every((id) => hunk.lines.some((line) => line.id === id))
          ? selectedLineFingerprint(file, hunk, note.lineIds)
          : null;
      } else if (hunk && file) {
        notes[note.id] = diffHunkFingerprint(file, hunk);
      } else {
        notes[note.id] = file ? diffFileFingerprint(file) : null;
      }
    }
    store.reconcileReviewTargets(conversationId, { files, hunks, notes });
  };

  const selectedReviewContext = async (
    selection: ReviewSelectionPayload,
    purpose: "ask" | "revision",
  ): Promise<{
    visibleContent: string;
    requestContext: TurnRequestContext;
    patch: string;
    fingerprint: string;
    filePath: string;
    hunkId: string;
    hunkHeader: string;
    selectedLineCount: number;
  }> => {
    const conversation = store.conversation(selection.conversationId);
    if (conversation.projectId !== selection.projectId) throw new RequestError("The thread does not belong to this project.");
    const diff = await getUnifiedDiff(store.conversationPath(conversation.id), { ignoreWhitespace: selection.ignoreWhitespace });
    if (diff.truncated) throw new RequestError("The current diff is truncated. Reduce the change set before reviewing a selection.");
    const structured = parseUnifiedDiff(diff.text);
    if (structured.fingerprint !== selection.fingerprint) throw new RequestError("The diff changed before this review action started. Refresh and select the lines again.");
    const file = structured.files.find((candidate) => candidate.path === selection.filePath);
    const hunk = file?.hunks.find((candidate) => candidate.id === selection.hunkId);
    if (!file || !hunk) throw new RequestError("The selected file or hunk is no longer present.");
    let context;
    try {
      context = buildDiffContext(file, hunk, selection.lineIds, {
        purpose: "prompt",
      });
    } catch (error) {
      if (error instanceof DiffContextError) throw new RequestError(error.message);
      throw error;
    }
    return {
      visibleContent: selection.comment?.trim()
        || (purpose === "ask" ? DEFAULT_DIFF_QUESTION : DEFAULT_DIFF_REVISION),
      requestContext: {
        diffSelections: [{
          path: file.path,
          hunkHeader: hunk.header,
          content: context.text,
          selectedLineCount: context.selectedLineCount,
          truncated: context.truncated,
        }],
      },
      patch: diff.text,
      fingerprint: structured.fingerprint,
      filePath: file.path,
      hunkId: hunk.id,
      hunkHeader: hunk.header,
      selectedLineCount: context.selectedLineCount,
    };
  };

  const captureRequiredCheckpoint = async (conversationId: string, label: string): Promise<CheckpointSummary> => {
    const path = store.conversationPath(conversationId);
    const status = await getRepositoryStatus(path);
    let captured: Awaited<ReturnType<typeof createCheckpoint>>;
    try {
      captured = await createCheckpoint(path, join(dataDirectory, "checkpoint-indexes"), conversationId);
    } catch (error) {
      throw new RequestError(`A recovery checkpoint could not be created, so the revision was not started. ${publicError(error)}`);
    }
    const turnIndex = store.checkpointCount(conversationId) + 1;
    return store.addCheckpoint({
      conversationId,
      ref: captured.ref,
      label,
      turnIndex,
      filesChanged: status.files.length,
      insertions: status.insertions,
      deletions: status.deletions,
    });
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
      captureGitBefore: async (input) => {
        await turnGitArtifacts.captureBefore(input);
        broadcastSnapshot();
      },
      captureGitArtifacts: async (input) => {
        await turnGitArtifacts.captureAfter(input);
        broadcastSnapshot();
      },
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

  const execute = async (socket: WebSocket, command: ClientCommand): Promise<void> => {
    try {
      switch (command.type) {
        case "app.refresh":
          send(socket, { type: "request.ok", requestId: command.requestId });
          send(socket, { type: "snapshot.updated", snapshot: currentSnapshot() });
          return;
        case "provider.refresh":
          await refreshProviderInfo(command.payload.providerId, true, true);
          send(socket, { type: "request.ok", requestId: command.requestId });
          return;
        case "provider.auth.start": {
          const launch = await providers.authLaunch(command.payload.providerId);
          const terminalId = terminals.createProcess(
            socket,
            options.defaultWorkspacePath,
            launch.executable,
            launch.args,
            launch.env,
            command.payload.cols,
            command.payload.rows,
            () => { void refreshProviderInfo(command.payload.providerId, true, true).catch(() => undefined); },
          );
          send(socket, { type: "terminal.created", requestId: command.requestId, terminalId });
          return;
        }
        case "project.create": {
          const path = ensureDirectory(command.payload.path);
          const identity = await inspectProjectIdentity(path);
          store.createProject(command.payload.name, path, identity);
          break;
        }
        case "project.select":
          store.selectProject(command.payload.projectId);
          break;
        case "project.remove":
          if (store.hasActiveWorkspaceRunForProject(command.payload.projectId)) {
            throw new RequestError("Stop active work for this project before removing it.");
          }
          for (const conversation of store.shellSnapshot().conversations) {
            if (conversation.projectId === command.payload.projectId) {
              rememberDeletedConversation(conversation.id);
            }
          }
          store.removeProject(command.payload.projectId);
          break;
        case "project.update": {
          const { projectId, ...update } = command.payload;
          store.updateProject(projectId, update);
          break;
        }
        case "conversation.create": {
          if (command.payload.modelSelection) {
            const selection = backendProfileController.validateSelection(command.payload.modelSelection);
            providers.resolveModelRoute(selection);
          }
          const repositoryPath = store.projectPath(command.payload.projectId);
          if (command.payload.useWorktree && command.payload.worktreePath) {
            throw new RequestError("Choose either an existing worktree or a new isolated worktree.");
          }

          if (command.payload.worktreePath) {
            const requestedPath = resolve(command.payload.worktreePath);
            const reusableContext = store.shellSnapshot().conversations.find((candidate) => (
              candidate.projectId === command.payload.projectId
              && candidate.worktreePath !== null
              && resolve(candidate.worktreePath) === requestedPath
            ));
            if (!reusableContext || requestedPath === resolve(repositoryPath)) {
              throw new RequestError("That worktree is not attached to a chat in this project.");
            }
            const status = await getRepositoryStatus(requestedPath);
            if (command.payload.branch && command.payload.branch !== status.branch) {
              throw new RequestError(`That worktree is currently on ${status.branch ?? "a detached checkout"}, not ${command.payload.branch}.`);
            }
            store.createConversation(command.payload.projectId, command.payload.title, {
              ...command.payload,
              branch: status.branch,
              worktreePath: status.root,
            });
            break;
          }

          let projectStatus: Awaited<ReturnType<typeof getRepositoryStatus>> | null = null;
          try {
            projectStatus = await getRepositoryStatus(repositoryPath);
          } catch (error) {
            if (!(error instanceof GitError && error.code === "not-repository")) throw error;
          }
          if (command.payload.branch && command.payload.branch !== projectStatus?.branch) {
            throw new RequestError(`The project checkout is currently on ${projectStatus?.branch ?? "a detached checkout"}, not ${command.payload.branch}.`);
          }

          const conversation = store.createConversation(command.payload.projectId, command.payload.title, {
            ...command.payload,
            branch: projectStatus?.branch ?? null,
            worktreePath: null,
          });
          if (command.payload.useWorktree) {
            try {
              if (!projectStatus?.branch) throw new RequestError("Check out a branch before creating an isolated worktree.");
              const branch = `inertia/${conversation.id.slice(0, 8)}`;
              const target = join(dataDirectory, "worktrees", conversation.id);
              mkdirSync(resolve(target, ".."), { recursive: true, mode: 0o700 });
              await workspaceRuns.trackSourceControl("Create worktree", command.payload.projectId, conversation.id, () =>
                createWorktree(repositoryPath, target, { branch, createBranch: true, startPoint: projectStatus.branch! }));
              const createdStatus = await getRepositoryStatus(target);
              store.updateConversation(conversation.id, { worktreePath: createdStatus.root, branch: createdStatus.branch ?? branch });
            } catch (error) {
              store.deleteConversation(conversation.id);
              throw error;
            }
          }
          break;
        }
        case "conversation.select":
          store.selectConversation(command.payload.conversationId);
          break;
        case "conversation.detail.load": {
          const conversationId = command.payload.conversationId;
          runtimeSync.setConversationSubscription(socket, conversationId);
          const sync = runtimeSync.cursor();
          if (deletedConversationIds.has(conversationId)) {
            send(socket, {
              type: "request.result",
              requestId: command.requestId,
              result: { kind: "conversation.detail", conversationId, state: "deleted", sync },
            });
            return;
          }
          try {
            const detail = store.conversationDetail(conversationId);
            send(socket, {
              type: "request.result",
              requestId: command.requestId,
              result: detail
                ? { kind: "conversation.detail", conversationId, state: "ready", detail, sync }
                : { kind: "conversation.detail", conversationId, state: "missing", sync },
            });
          } catch (error) {
            send(socket, {
              type: "request.result",
              requestId: command.requestId,
              result: {
                kind: "conversation.detail",
                conversationId,
                state: "failed",
                message: publicError(error),
                sync,
              },
            });
          }
          return;
        }
        case "conversation.update": {
          const { conversationId, ...update } = command.payload;
          const current = store.conversation(conversationId);
          if (
            backendProfileController.isExternalSelection(current.modelSelection)
            && update.modelSelection === undefined
            && (update.model !== undefined || update.reasoningEffort !== undefined)
          ) {
            throw new RequestError("Kimi model and effort changes require a verified Kimi model selection.");
          }
          const changesSelection = (
            update.providerId !== undefined
            || update.modelSelection !== undefined
            || update.model !== undefined
          );
          if (changesSelection) {
            const selection = backendProfileController.validateSelection(
              requestedConversationModelSelection(current, command.payload),
            );
            const route = providers.resolveModelRoute(selection);
            const latestTurn = store.latestAgentTurnForConversation(conversationId);
            const decision = resolveContinuationDecision({
              previousIdentity: latestTurn?.continuationIdentity
                ?? current.continuationIdentity
                ?? null,
              nextIdentity: route.continuationIdentity,
              previousModelId: latestTurn?.modelSelection.modelId
                ?? (current.continuationIdentity
                  ? current.modelSelection.modelId
                  : null),
              nextModelId: selection.modelId,
              hasProviderSession: current.providerSessionId !== null,
              hasTurns: latestTurn !== null,
              allowsModelSwitchWithinSession:
                route.compatibility.allowsModelSwitchWithinSession,
            });
            if (decision.action === "new-conversation-required") {
              throw new RequestError(decision.reason);
            }
          }
          const changesRunConfiguration = (
            update.providerId !== undefined
            || update.modelSelection !== undefined
            || update.model !== undefined
            || update.reasoningEffort !== undefined
            || update.interactionMode !== undefined
            || update.accessMode !== undefined
          );
          if (changesRunConfiguration && store.hasActiveWorkspaceRunForConversation(conversationId)) {
            throw new RequestError("Stop the active run or review before changing its agent configuration.");
          }
          store.updateConversation(conversationId, update);
          break;
        }
        case "conversation.archive":
          if (store.hasActiveWorkspaceRunForConversation(command.payload.conversationId)) {
            throw new RequestError("Stop the active run or review before archiving this thread.");
          }
          store.archiveConversation(command.payload.conversationId, true);
          break;
        case "conversation.unarchive":
          store.archiveConversation(command.payload.conversationId, false);
          break;
        case "conversation.settle":
          if (store.hasActiveWorkspaceRunForConversation(command.payload.conversationId)) {
            throw new RequestError("Stop the active run or review before settling this thread.");
          }
          store.settleConversation(command.payload.conversationId, true);
          break;
        case "conversation.unsettle":
          store.settleConversation(command.payload.conversationId, false);
          break;
        case "conversation.delete": {
          const conversation = store.conversation(command.payload.conversationId);
          if (store.hasActiveWorkspaceRunForConversation(conversation.id)) {
            throw new RequestError("Stop the active run or review before deleting this thread.");
          }
          if (conversation.worktreePath) {
            const sharedCheckout = store.shellSnapshot().conversations.some((candidate) => (
              candidate.id !== conversation.id
              && candidate.projectId === conversation.projectId
              && candidate.worktreePath !== null
              && resolve(candidate.worktreePath) === resolve(conversation.worktreePath!)
            ));
            if (!sharedCheckout) {
              try {
                await removeWorktree(store.projectPath(conversation.projectId), conversation.worktreePath, false);
              } catch (error) {
                if (!(error instanceof GitError && error.code === "not-found")) throw error;
              }
            }
          }
          await deleteCheckpoints(store.projectPath(conversation.projectId), conversation.id).catch(() => undefined);
          store.deleteConversation(command.payload.conversationId);
          rememberDeletedConversation(command.payload.conversationId);
          break;
        }
        case "message.send": {
          const conversation = store.conversation(command.payload.conversationId);
          if (turns.isActive(conversation.id) || isolatedRuns.has(conversation.id)) {
            throw new RequestError("Wait for the current run or read-only review to finish first.");
          }
          if (enableProviders) {
            const selectedProvider = providerInfo.find(({ id }) => id === conversation.providerId);
            backendProfileController.validateSelection(conversation.modelSelection);
            const backendReadiness = await backendProfileController.readiness(
              conversation.modelSelection,
              selectedProvider,
            );
            if (backendReadiness && !backendReadiness.ready) {
              throw new RequestError(backendReadiness.message ?? "The selected model backend is unavailable.");
            }
            if (!backendReadiness && !selectedProvider?.canRun) {
              throw new RequestError(selectedProvider?.statusMessage ?? "This agent is not ready. Open Settings to finish setup.");
            }
            const selectedModel = !backendReadiness
              ? conversation.model
                ? selectedProvider?.models.find(({ id }) => id === conversation.model)
                : selectedProvider?.models.find(({ isDefault }) => isDefault)
                  ?? selectedProvider?.models[0]
              : undefined;
            if (!backendReadiness && conversation.model && (selectedProvider?.models.length ?? 0) > 0 && !selectedModel) {
              throw new RequestError("That model is no longer offered by this provider. Choose another model before sending.");
            }
            if (
              !backendReadiness
              &&
              conversation.reasoningEffort
              && selectedModel?.reasoningOptions.length
              && !selectedModel.reasoningOptions.some(({ value }) => value === conversation.reasoningEffort)
            ) {
              throw new RequestError("That reasoning level is not supported by the selected model.");
            }
          }
          let checkpointId: string | null = null;
          if (enableProviders) {
            try {
              const path = store.conversationPath(conversation.id);
              const status = await getRepositoryStatus(path);
              const captured = await createCheckpoint(path, join(dataDirectory, "checkpoint-indexes"), conversation.id);
              const turnIndex = store.checkpointCount(conversation.id) + 1;
              checkpointId = store.addCheckpoint({ conversationId: conversation.id, ref: captured.ref, label: `Before turn ${turnIndex}`, turnIndex, filesChanged: status.files.length, insertions: status.insertions, deletions: status.deletions }).id;
            } catch (error) {
              if (!(error instanceof CheckpointError && error.message === "not-repository") && !(error instanceof GitError && error.code === "not-repository")) {
                // A checkpoint is protective but must not prevent an otherwise valid provider run.
              }
            }
          }
          const queued = enableProviders
            ? turns.queue({
                conversationId: conversation.id,
                content: command.payload.content,
                attachments: command.payload.attachments,
                context: command.payload.context,
                checkpointId,
              })
            : null;
          if (!enableProviders) {
            store.createMessage(
              conversation.id,
              command.payload.content,
              "user",
              command.payload.attachments,
            );
          }
          if (conversation.title === "New chat" || conversation.title === "New thread") {
            store.updateConversation(conversation.id, { title: command.payload.content.slice(0, 64) });
          }
          send(socket, { type: "request.ok", requestId: command.requestId });
          broadcastSnapshot();
          if (queued) turns.start(queued.turn.id);
          return;
        }
        case "agent.stop":
          if (
            !isolatedRuns.stopConversation(command.payload.conversationId)
            && !turns.cancel(command.payload.conversationId)
          ) {
            throw new RequestError("This thread does not have an active run.");
          }
          break;
        case "activity.stop": {
          const activity = store.workspaceRun(command.payload.runId);
          if (activity.status !== "running" && activity.status !== "waiting") {
            throw new RequestError("That activity has already finished.");
          }
          if (activity.kind === "check" || activity.kind === "service") {
            if (!workspaceRuns.stopManagedAction(activity.id)) {
              throw new RequestError("That process is no longer owned by the local runtime.");
            }
            break;
          }
          if (activity.kind !== "agent" || !activity.conversationId) {
            throw new RequestError("This activity cannot be stopped safely.");
          }
          if (isolatedRuns.ownsWorkspaceRun(activity.id)) {
            if (!isolatedRuns.stopWorkspaceRun(activity.id)) {
              throw new RequestError("That isolated review has already finished.");
            }
            break;
          }
          if (
            !isolatedRuns.stopConversation(activity.conversationId)
            && !turns.cancel(activity.conversationId)
          ) {
            throw new RequestError("That agent run is no longer active.");
          }
          break;
        }
        case "activity.dismiss":
          store.dismissWorkspaceRun(command.payload.runId);
          break;
        case "activity.mark-seen":
          store.markWorkspaceRunSeen(command.payload.runId);
          break;
        case "activity.acknowledge":
          store.acknowledgeWorkspaceRun(command.payload.runId);
          break;
        case "agent.approval.respond": {
          const pending = pendingApprovals.get(command.payload.requestId);
          if (!pending || pending.conversationId !== command.payload.conversationId) throw new RequestError("That approval request is no longer pending.");
          if (!pending.availableDecisions.includes(command.payload.decision)) {
            throw new RequestError("That response is not available for this approval request.");
          }
          if (!turns.respondToApproval(
            command.payload.conversationId,
            command.payload.requestId,
            command.payload.decision,
          )) {
            throw new RequestError("That approval request is no longer pending.");
          }
          break;
        }
        case "agent.input.respond": {
          const pending = pendingInputs.get(command.payload.requestId);
          if (!pending || pending.conversationId !== command.payload.conversationId) throw new RequestError("That question is no longer pending.");
          const expected = new Map(pending.questions.map((question) => [question.id, question]));
          const invalidAnswer = Object.entries(command.payload.answers).some(([id, values]) => {
            const question = expected.get(id);
            if (!question || values.length === 0 || (!question.allowMultiple && values.length !== 1)) return true;
            const optionIds = new Set(question.options.map((option) => option.id));
            return values.some((value) => !optionIds.has(value) && !question.isOther && question.options.length > 0);
          });
          if (invalidAnswer || [...expected.keys()].some((id) => !command.payload.answers[id]?.length)) {
            throw new RequestError("Answer every question before continuing.");
          }
          if (!turns.respondToInput(
            command.payload.conversationId,
            command.payload.requestId,
            command.payload.answers,
          )) {
            throw new RequestError("That question is no longer pending.");
          }
          break;
        }
        case "settings.update": {
          if (command.payload.codexBinaryPath !== undefined) {
            const manualPath = command.payload.codexBinaryPath.trim();
            if (manualPath) {
              if (!isAbsolute(manualPath)) throw new RequestError("Choose an absolute Codex executable path.");
              const detection = await providers.validateCommand("codex", manualPath, {
                cwd: options.defaultWorkspacePath,
                timeoutMs: 4_000,
                refreshEnvironment: true,
              });
              if (detection.installState !== "installed" || !detection.version) {
                throw new RequestError("The selected file is not a working Codex executable.");
              }
            }
            providers.setCommand("codex", manualPath || undefined);
          }
          store.updateSettings(command.payload);
          if (command.payload.codexBinaryPath !== undefined) {
            await refreshProviderInfo("codex", true, true);
          }
          break;
        }
        case "backend.profile.get": {
          send(socket, {
            type: "request.result",
            requestId: command.requestId,
            result: {
              kind: "backend.profile",
              profile: backendProfileController.detail(command.payload.profileId),
            },
          });
          return;
        }
        case "backend.profile.create": {
          const profile = await backendProfileController.createProfile(command.payload);
          broadcastSnapshot();
          send(socket, {
            type: "request.result",
            requestId: command.requestId,
            result: { kind: "backend.profile", profile },
          });
          return;
        }
        case "backend.profile.update": {
          const profile = await backendProfileController.updateProfile(
            command.payload.profileId,
            command.payload.update,
          );
          broadcastSnapshot();
          send(socket, {
            type: "request.result",
            requestId: command.requestId,
            result: { kind: "backend.profile", profile },
          });
          return;
        }
        case "backend.profile.credential-revision": {
          const profile = await backendProfileController.reconcileCredentialRevision(
            command.payload.profileId,
            command.payload.credentialGeneration,
          );
          broadcastSnapshot();
          send(socket, {
            type: "request.result",
            requestId: command.requestId,
            result: { kind: "backend.profile", profile },
          });
          return;
        }
        case "backend.profile.probe": {
          const profile = await backendProfileController.probe(
            command.payload.profileId,
            command.payload.modelId,
          );
          broadcastSnapshot();
          send(socket, {
            type: "request.result",
            requestId: command.requestId,
            result: { kind: "backend.profile.probe", profile },
          });
          return;
        }
        case "backend.profile.delete":
          await backendProfileController.deleteProfile(command.payload.profileId);
          break;
        case "backend.default.set": {
          const value = backendProfileController.setDefault(
            command.payload.projectId,
            command.payload.selection,
          );
          broadcastSnapshot();
          send(socket, {
            type: "request.result",
            requestId: command.requestId,
            result: { kind: "backend.default", value },
          });
          return;
        }
        case "backend.default.clear":
          backendProfileController.clearDefault(command.payload.projectId);
          break;
        case "git.refresh": {
          const path = workspacePath(command.payload.projectId, command.payload.conversationId);
          let status: GitStatusSnapshot;
          try { status = statusSnapshot(await getRepositoryStatus(path)); }
          catch (error) {
            if (!(error instanceof GitError && error.code === "not-repository")) throw error;
            status = emptyGitStatus();
          }
          send(socket, { type: "request.result", requestId: command.requestId, result: { kind: "git.status", status } });
          return;
        }
        case "git.diff": {
          const path = workspacePath(command.payload.projectId, command.payload.conversationId);
          const [diff, status] = await Promise.all([
            getUnifiedDiff(path, { ...(command.payload.path ? { paths: [command.payload.path] } : {}), ignoreWhitespace: command.payload.ignoreWhitespace }),
            getRepositoryStatus(path),
          ]);
          if (command.payload.conversationId && !command.payload.path && !diff.truncated) {
            reconcileReviews(command.payload.conversationId, diff.text);
          }
          send(socket, { type: "request.result", requestId: command.requestId, result: { kind: "git.diff", diff: { patch: diff.text, truncated: diff.truncated, files: changedFiles(status) } } });
          if (command.payload.conversationId && !command.payload.path && !diff.truncated) broadcastSnapshot();
          return;
        }
        case "git.turn.diff": {
          const conversation = store.conversation(command.payload.conversationId);
          if (conversation.projectId !== command.payload.projectId) {
            throw new RequestError("The thread does not belong to this project.");
          }
          const turn = store.agentTurn(command.payload.turnId);
          if (turn.conversationId !== conversation.id) {
            throw new RequestError("The Git artifact does not belong to this thread.");
          }
          try {
            const diff = await turnGitArtifacts.turnDiff(
              turn.id,
              command.payload.path,
            );
            send(socket, {
              type: "request.result",
              requestId: command.requestId,
              result: { kind: "git.turn.diff", diff },
            });
          } catch (error) {
            if (error instanceof TurnGitArtifactError) throw new RequestError(error.message);
            throw error;
          }
          return;
        }
        case "git.turn.compare": {
          const conversation = store.conversation(command.payload.conversationId);
          if (conversation.projectId !== command.payload.projectId) {
            throw new RequestError("The thread does not belong to this project.");
          }
          const earlier = store.agentTurn(command.payload.earlierTurnId);
          const later = store.agentTurn(command.payload.laterTurnId);
          if (
            earlier.conversationId !== conversation.id
            || later.conversationId !== conversation.id
          ) throw new RequestError("Both Git artifacts must belong to this thread.");
          try {
            const diff = await turnGitArtifacts.compare(
              earlier.id,
              later.id,
              command.payload.path,
            );
            send(socket, {
              type: "request.result",
              requestId: command.requestId,
              result: { kind: "git.turn.diff", diff },
            });
          } catch (error) {
            if (error instanceof TurnGitArtifactError) throw new RequestError(error.message);
            throw error;
          }
          return;
        }
        case "git.selection.revert": {
          if (command.payload.conversationId && store.hasActiveWorkspaceRunForConversation(command.payload.conversationId)) {
            throw new RequestError("Stop the active run or review before reverting selected changes.");
          }
          const path = workspacePath(command.payload.projectId, command.payload.conversationId);
          const reversed = await workspaceRuns.trackSourceControl(
            `Revert ${command.payload.lineIds.length} selected ${command.payload.lineIds.length === 1 ? "line" : "lines"} · ${command.payload.filePath}`,
            command.payload.projectId,
            command.payload.conversationId,
            () => revertDiffSelection(path, {
              fingerprint: command.payload.fingerprint,
              filePath: command.payload.filePath,
              hunkId: command.payload.hunkId,
              lineIds: command.payload.lineIds,
              expected: command.payload.expected,
              ignoreWhitespace: command.payload.ignoreWhitespace,
            }),
          );
          if (command.payload.comment && command.payload.conversationId) {
            store.createMessage(
              command.payload.conversationId,
              `Reverted selected changes in ${command.payload.filePath}. Note: ${command.payload.comment}`,
              "system",
            );
          }
          const status = await getRepositoryStatus(path);
          send(socket, {
            type: "request.result",
            requestId: command.requestId,
            result: {
              kind: "git.reversal",
              diff: { patch: reversed.diff.text, truncated: reversed.diff.truncated, files: changedFiles(status) },
              operation: reversed.operation,
            },
          });
          broadcastSnapshot();
          return;
        }
        case "git.selection.inspect": {
          const path = workspacePath(command.payload.projectId, command.payload.conversationId);
          const plan = await inspectDiffSelection(path, {
            fingerprint: command.payload.fingerprint,
            filePath: command.payload.filePath,
            hunkId: command.payload.hunkId,
            lineIds: command.payload.lineIds,
            ignoreWhitespace: command.payload.ignoreWhitespace,
          });
          send(socket, { type: "request.result", requestId: command.requestId, result: { kind: "git.reversal.plan", plan } });
          return;
        }
        case "git.selection.undo": {
          if (command.payload.conversationId && store.hasActiveWorkspaceRunForConversation(command.payload.conversationId)) {
            throw new RequestError("Stop the active run or review before restoring the selective-revert backup.");
          }
          const path = workspacePath(command.payload.projectId, command.payload.conversationId);
          const diff = await workspaceRuns.trackSourceControl(
            "Undo selective reversal",
            command.payload.projectId,
            command.payload.conversationId,
            () => undoDiffSelection(path, command.payload.operationId),
          );
          const status = await getRepositoryStatus(path);
          send(socket, {
            type: "request.result",
            requestId: command.requestId,
            result: { kind: "git.diff", diff: { patch: diff.text, truncated: diff.truncated, files: changedFiles(status) } },
          });
          broadcastSnapshot();
          return;
        }
        case "review.selection.ask": {
          if (!enableProviders) throw new RequestError("Read-only review questions are unavailable in this runtime.");
          const conversation = store.conversation(command.payload.conversationId);
          if (turns.isActive(conversation.id) || isolatedRuns.has(conversation.id)) {
            throw new RequestError("Wait for the current agent or review turn to finish first.");
          }
          const provider = providerInfo.find(({ id }) => id === conversation.providerId);
          if (!provider?.canRun) throw new RequestError(provider?.statusMessage ?? "The selected review agent is unavailable.");
          const context = await selectedReviewContext(command.payload, "ask");
          const assembled = assembleReadOnlyReviewRequest(
            store.conversationPath(conversation.id),
            context.visibleContent,
            context.requestContext,
          );
          try {
            const completion = await isolatedRuns.run({
              kind: "selection-ask",
              projectId: conversation.projectId,
              conversationId: conversation.id,
              owner: socket,
              selection: isolatedRunSelection(conversation),
              request: {
                visibleContent: assembled.visibleContent,
                executionPrompt: assembled.executionPrompt,
              },
              label: `${providerLabel(conversation.providerId)} · read-only question`,
              detail: `${context.filePath} · ${context.selectedLineCount} selected lines`,
              successDetail: `${context.filePath} reviewed without a resumable session`,
              toolPolicy: "read-only",
              interactionPolicy: "fail-closed",
              outputLimitChars: 512_000,
              onResult: (output, { assertActive }) => {
                const answer = output.text.trim();
                if (!answer) throw new RequestError("The review agent returned an empty answer.");
                assertActive();
                return {
                  conversationId: conversation.id,
                  fingerprint: context.fingerprint,
                  filePath: context.filePath,
                  hunkId: context.hunkId,
                  selectedLineCount: context.selectedLineCount,
                  question: assembled.visibleContent,
                  answer: answer.slice(0, 512_000),
                  providerId: conversation.providerId,
                  modelSelection: output.modelSelection,
                  generatedAt: new Date().toISOString(),
                };
              },
            });
            send(socket, {
              type: "request.result",
              requestId: command.requestId,
              result: {
                kind: "review.selection.answer",
                answer: completion.value,
              },
            });
          } catch (error) {
            if (error instanceof IsolatedRunError && error.reason === "cancelled") {
              send(socket, { type: "request.ok", requestId: command.requestId });
              return;
            }
            if (error instanceof IsolatedRunError) throw new RequestError(error.message);
            throw error;
          }
          return;
        }
        case "review.selection.revise": {
          if (!enableProviders) throw new RequestError("Revision requests are unavailable in this runtime.");
          const conversation = store.conversation(command.payload.conversationId);
          if (turns.isActive(conversation.id) || isolatedRuns.has(conversation.id)) {
            throw new RequestError("Wait for the current agent or review turn to finish first.");
          }
          const provider = providerInfo.find(({ id }) => id === conversation.providerId);
          if (!provider?.canRun) throw new RequestError(provider?.statusMessage ?? "The selected agent is unavailable.");
          const context = await selectedReviewContext(command.payload, "revision");
          const before = parseUnifiedDiff(context.patch);
          const beforeFiles = Object.fromEntries(before.files.map((file) => [file.path, diffFileFingerprint(file)]));
          const checkpoint = await captureRequiredCheckpoint(conversation.id, `Before revision · ${context.filePath}`);
          const queued = turns.queue({
            conversationId: conversation.id,
            content: context.visibleContent,
            context: context.requestContext,
            internalInstructions: [{
              label: "selected-diff-revision-scope",
              text: "Treat the selected lines as the requested focus, not a perfect technical write fence. Avoid unrelated files and hunks, and report any necessary spillover. A recovery checkpoint was created before this turn.",
            }],
            checkpointId: checkpoint.id,
            onSettled: async (status, turnId) => {
              let audit = "The refreshed diff could not be audited automatically. Use the recovery checkpoint if the result is not acceptable.";
              try {
                const current = await getUnifiedDiff(store.conversationPath(conversation.id), { ignoreWhitespace: command.payload.ignoreWhitespace });
                if (!current.truncated) {
                  reconcileReviews(conversation.id, current.text);
                  const afterFiles = Object.fromEntries(parseUnifiedDiff(current.text).files.map((file) => [file.path, diffFileFingerprint(file)]));
                  const outsidePaths = [...new Set([...Object.keys(beforeFiles), ...Object.keys(afterFiles)])]
                    .filter((path) => path !== context.filePath && beforeFiles[path] !== afterFiles[path])
                    .sort();
                  audit = outsidePaths.length > 0
                    ? `Potential unrelated changes were detected outside the selected file: ${outsidePaths.join(", ")}. Review them before committing.`
                    : "No changes outside the selected file were detected automatically. Review other hunks in the selected file because line boundaries are guidance, not a technical write fence.";
                }
              } catch {
                // The persistent checkpoint is still the recovery path.
              }
              const outcome = status === "completed" ? "completed" : status === "cancelled" ? "was cancelled" : "failed";
              store.createMessage(
                conversation.id,
                `Revision ${outcome}. Scope: ${context.filePath} · ${context.hunkHeader} · ${context.selectedLineCount} selected lines. ${audit} Recovery checkpoint: ${checkpoint.label}.`,
                "system",
                [],
                turnId,
              );
            },
          });
          send(socket, { type: "request.ok", requestId: command.requestId });
          broadcastSnapshot();
          turns.start(queued.turn.id);
          return;
        }
        case "review.state.set": {
          const conversation = store.conversation(command.payload.conversationId);
          const current = await getUnifiedDiff(store.conversationPath(conversation.id), { ignoreWhitespace: command.payload.ignoreWhitespace });
          if (current.truncated) throw new RequestError("The complete diff is required before changing review state.");
          const structured = parseUnifiedDiff(current.text);
          const file = structured.files.find((candidate) => candidate.path === command.payload.path);
          const hunk = file?.hunks.find((candidate) => candidate.id === command.payload.hunkId);
          const actualFingerprint = command.payload.scope === "file"
            ? file && diffFileFingerprint(file)
            : file && hunk && diffHunkFingerprint(file, hunk);
          if (!actualFingerprint || actualFingerprint !== command.payload.targetFingerprint) {
            throw new RequestError("This review target changed. Refresh the diff before marking it reviewed.");
          }
          const { ignoreWhitespace: _ignoreWhitespace, ...state } = command.payload;
          store.setReviewState(state);
          break;
        }
        case "review.note.create": {
          const conversation = store.conversation(command.payload.conversationId);
          const current = await getUnifiedDiff(store.conversationPath(conversation.id), { ignoreWhitespace: command.payload.ignoreWhitespace });
          if (current.truncated) throw new RequestError("The complete diff is required before saving a targeted note.");
          const structured = parseUnifiedDiff(current.text);
          const file = structured.files.find((candidate) => candidate.path === command.payload.path);
          const hunk = file?.hunks.find((candidate) => candidate.id === command.payload.hunkId);
          let actualFingerprint: string | null = null;
          if (command.payload.lineIds.length > 0) {
            if (!file || !hunk || !command.payload.lineIds.every((id) => hunk.lines.some((line) => line.id === id))) {
              throw new RequestError("The selected note range changed. Refresh the diff.");
            }
            actualFingerprint = selectedLineFingerprint(file, hunk, command.payload.lineIds);
          } else if (file && hunk) {
            actualFingerprint = diffHunkFingerprint(file, hunk);
          } else if (file && command.payload.hunkId === null) {
            actualFingerprint = diffFileFingerprint(file);
          }
          if (!actualFingerprint || actualFingerprint !== command.payload.targetFingerprint) {
            throw new RequestError("This note target changed. Refresh the diff before saving it.");
          }
          const { ignoreWhitespace: _ignoreWhitespace, ...note } = command.payload;
          store.createReviewNote(note);
          break;
        }
        case "review.note.update":
          store.updateReviewNote(command.payload.conversationId, command.payload.noteId, command.payload.body);
          break;
        case "review.note.delete":
          store.deleteReviewNote(command.payload.conversationId, command.payload.noteId);
          break;
        case "review.summary.generate": {
          if (!enableProviders) throw new RequestError("Agent summaries are unavailable in this runtime.");
          const conversation = store.conversation(command.payload.conversationId);
          if (conversation.projectId !== command.payload.projectId) throw new RequestError("The thread does not belong to this project.");
          if (turns.isActive(conversation.id)) {
            throw new RequestError("Wait for the current agent or read-only review to finish before summarizing its changes.");
          }
          if (isolatedRuns.has(conversation.id)) {
            throw new RequestError("An isolated review is already running for this thread.");
          }
          const provider = providerInfo.find(({ id }) => id === conversation.providerId);
          if (!provider?.canRun) throw new RequestError(provider?.statusMessage ?? "The selected review agent is unavailable.");
          try {
            const diff = await getUnifiedDiff(store.conversationPath(conversation.id), { ignoreWhitespace: command.payload.ignoreWhitespace });
            if (diff.truncated) throw new RequestError("The diff preview is truncated. Reduce or commit part of the change set before generating a complete summary.");
            const structured = parseUnifiedDiff(diff.text);
            if (structured.fingerprint !== command.payload.fingerprint) throw new RequestError("The changes moved before the review started. Refresh and try again.");
            if (structured.files.length === 0) throw new RequestError("There are no changes to summarize.");
            const prompt = buildReviewSummaryPrompt(diff.text, structured.files);
            const selectedReviewModel = conversation.model
              ? provider.models.find(({ id }) => id === conversation.model)?.id ?? conversation.model
              : (provider.models.find(({ isDefault }) => isDefault) ?? provider.models[0])?.id ?? null;
            const completion = await isolatedRuns.run({
              kind: "diff-summary",
              projectId: conversation.projectId,
              conversationId: conversation.id,
              owner: socket,
              selection: isolatedRunSelection(conversation, selectedReviewModel),
              request: {
                visibleContent: null,
                executionPrompt: prompt,
              },
              label: `${providerLabel(conversation.providerId)} · read-only diff summary${conversation.model ? ` · ${conversation.model}` : ""}`,
              detail: `${structured.files.length} ${structured.files.length === 1 ? "file" : "files"} · isolated session`,
              successDetail: `${structured.files.length} ${structured.files.length === 1 ? "file" : "files"} summarized · isolated session`,
              toolPolicy: "none",
              interactionPolicy: "fail-closed",
              timeoutMs: options.reviewSummaryTimeoutMs ?? DEFAULT_REVIEW_SUMMARY_TIMEOUT_MS,
              outputLimitChars: 512_000,
              onResult: async (output, { assertActive }) => {
                const summary = parseReviewSummaryResult(
                  conversation.id,
                  {
                    providerId: conversation.providerId,
                    harnessId: output.harnessId,
                    backendProfileId: output.backendProfileId,
                    model: output.model,
                  },
                  structured.fingerprint,
                  structured.files,
                  output.text,
                );
                const current = await getUnifiedDiff(
                  store.conversationPath(conversation.id),
                  { ignoreWhitespace: command.payload.ignoreWhitespace },
                );
                requireCurrentReviewSummaryFingerprint(
                  structured.fingerprint,
                  current.text,
                  current.truncated,
                );
                assertActive();
                store.upsertReviewSummary(summary);
                return summary;
              },
            });
            send(socket, {
              type: "request.result",
              requestId: command.requestId,
              result: { kind: "review.summary", summary: completion.value },
            });
          } catch (error) {
            if (error instanceof IsolatedRunError && error.reason === "cancelled") {
              send(socket, { type: "request.ok", requestId: command.requestId });
              return;
            }
            if (error instanceof IsolatedRunError) throw new RequestError(error.message);
            throw error;
          }
          return;
        }
        case "review.summary.cancel": {
          const conversation = store.conversation(command.payload.conversationId);
          if (!isolatedRuns.stopConversation(conversation.id, "diff-summary")) {
            throw new RequestError("This thread does not have an active change summary.");
          }
          send(socket, { type: "request.ok", requestId: command.requestId });
          return;
        }
        case "git.branches": {
          const path = workspacePath(command.payload.projectId);
          const branches = await listBranches(path);
          send(socket, { type: "request.result", requestId: command.requestId, result: { kind: "git.branches", branches: [...branches.local, ...branches.remote].map((branch) => ({ name: branch.name, current: branch.current, remote: branch.kind === "remote", worktreePath: null })) } });
          return;
        }
        case "git.branch.create": {
          const result = await workspaceRuns.trackSourceControl("Create branch", command.payload.projectId, undefined, () =>
            createBranch(workspacePath(command.payload.projectId), command.payload.name));
          send(socket, { type: "request.result", requestId: command.requestId, result: { kind: "git.action", message: `Created ${result.status.branch ?? command.payload.name}.` } });
          return;
        }
        case "git.branch.switch": {
          const result = await workspaceRuns.trackSourceControl("Switch branch", command.payload.projectId, undefined, () =>
            switchBranch(workspacePath(command.payload.projectId), command.payload.name));
          send(socket, { type: "request.result", requestId: command.requestId, result: { kind: "git.action", message: `Switched to ${result.status.branch ?? command.payload.name}.` } });
          return;
        }
        case "git.worktree.create": {
          const conversation = store.conversation(command.payload.conversationId);
          if (conversation.projectId !== command.payload.projectId) throw new RequestError("The thread does not belong to this project.");
          if (conversation.worktreePath) throw new RequestError("This thread already has a worktree.");
          const target = join(dataDirectory, "worktrees", conversation.id);
          mkdirSync(resolve(target, ".."), { recursive: true, mode: 0o700 });
          await workspaceRuns.trackSourceControl("Create worktree", command.payload.projectId, command.payload.conversationId, () =>
            createWorktree(store.projectPath(command.payload.projectId), target, { branch: command.payload.branch, createBranch: true, startPoint: command.payload.baseBranch }));
          store.updateConversation(conversation.id, { worktreePath: target, branch: command.payload.branch });
          send(socket, { type: "request.result", requestId: command.requestId, result: { kind: "worktree.created", path: target, branch: command.payload.branch } });
          broadcastSnapshot();
          return;
        }
        case "git.pull":
          await workspaceRuns.trackSourceControl("Pull changes", command.payload.projectId, command.payload.conversationId, () =>
            pullRepository(workspacePath(command.payload.projectId, command.payload.conversationId)));
          send(socket, { type: "request.result", requestId: command.requestId, result: { kind: "git.action", message: "Pulled the latest changes." } });
          return;
        case "git.commit": {
          const path = workspacePath(command.payload.projectId, command.payload.conversationId);
          const result = await workspaceRuns.trackSourceControl("Commit changes", command.payload.projectId, command.payload.conversationId, () =>
            commitChanges(path, command.payload.message, command.payload.paths));
          if (command.payload.conversationId) {
            const current = await getUnifiedDiff(path);
            if (!current.truncated) reconcileReviews(command.payload.conversationId, current.text);
          }
          send(socket, { type: "request.result", requestId: command.requestId, result: { kind: "git.action", message: `Committed ${result.commit.slice(0, 7)}.` } });
          broadcastSnapshot();
          return;
        }
        case "git.push":
          await workspaceRuns.trackSourceControl("Push branch", command.payload.projectId, command.payload.conversationId, () =>
            pushCurrentBranch(workspacePath(command.payload.projectId, command.payload.conversationId)));
          send(socket, { type: "request.result", requestId: command.requestId, result: { kind: "git.action", message: "Pushed the current branch." } });
          return;
        case "git.pr.open": {
          const url = await workspaceRuns.trackSourceControl("Prepare pull request", command.payload.projectId, command.payload.conversationId, () =>
            getPullRequestCreateUrl(workspacePath(command.payload.projectId, command.payload.conversationId)));
          send(socket, { type: "request.result", requestId: command.requestId, result: { kind: "external.url", url, label: "Open pull request" } });
          return;
        }
        case "workspace.entries": {
          const path = workspacePath(command.payload.projectId, command.payload.conversationId);
          const result = command.payload.query
            ? await searchWorkspaceEntries(path, command.payload.query)
            : await listWorkspaceEntries(path);
          const entries = result.entries
            .filter((entry) => entry.kind === "file" || entry.kind === "directory")
            .map((entry) => ({ path: entry.path, kind: entry.kind as "file" | "directory" }));
          send(socket, { type: "request.result", requestId: command.requestId, result: { kind: "workspace.entries", entries, truncated: result.truncated } });
          return;
        }
        case "workspace.file.read": {
          const file = await readWorkspaceTextFile(workspacePath(command.payload.projectId, command.payload.conversationId), command.payload.path);
          const extension = file.path.split(".").pop()?.toLowerCase() ?? "text";
          send(socket, { type: "request.result", requestId: command.requestId, result: { kind: "workspace.file", file: { path: file.path, content: file.content, truncated: false, language: extension } } });
          return;
        }
        case "project.actions": {
          const actions = await workspaceRuns.listActions(
            workspacePath(command.payload.projectId, command.payload.conversationId),
          );
          send(socket, {
            type: "request.result",
            requestId: command.requestId,
            result: { kind: "project.actions", actions },
          });
          return;
        }
        case "project.action.run": {
          const cwd = workspacePath(command.payload.projectId, command.payload.conversationId);
          await workspaceRuns.startAction({
            owner: socket,
            cwd,
            projectId: command.payload.projectId,
            conversationId: command.payload.conversationId,
            actionId: command.payload.actionId,
            cols: command.payload.cols,
            rows: command.payload.rows,
            onStarted: (createdTerminalId) => {
              send(socket, {
                type: "terminal.created",
                requestId: command.requestId,
                terminalId: createdTerminalId,
              });
            },
          });
          return;
        }
        case "checkpoint.revert": {
          const checkpoint = store.checkpoint(command.payload.checkpointId);
          if (checkpoint.conversationId !== command.payload.conversationId) throw new RequestError("The checkpoint does not belong to this thread.");
          if (store.hasActiveWorkspaceRunForConversation(command.payload.conversationId)) {
            throw new RequestError("Stop the active run or review before restoring a checkpoint.");
          }
          await restoreCheckpoint(store.conversationPath(checkpoint.conversationId), checkpoint.ref, checkpoint.conversationId);
          send(socket, { type: "request.ok", requestId: command.requestId });
          broadcastSnapshot();
          return;
        }
        case "terminal.create": {
          const cwd = workspacePath(command.payload.projectId, command.payload.conversationId);
          const terminalId = terminals.create(socket, cwd, command.payload.cols, command.payload.rows);
          send(socket, { type: "terminal.created", requestId: command.requestId, terminalId });
          return;
        }
        case "terminal.input":
          terminals.input(socket, command.payload.terminalId, command.payload.data);
          send(socket, { type: "request.ok", requestId: command.requestId });
          return;
        case "terminal.resize":
          terminals.resize(socket, command.payload.terminalId, command.payload.cols, command.payload.rows);
          send(socket, { type: "request.ok", requestId: command.requestId });
          return;
        case "terminal.close":
          terminals.close(socket, command.payload.terminalId);
          send(socket, { type: "request.ok", requestId: command.requestId });
          return;
      }
      // Publish the completed mutation before resolving its request. This keeps
      // follow-up UI actions from targeting the previously active project or
      // conversation while React is still waiting for the authoritative state.
      broadcastSnapshot();
      send(socket, { type: "request.ok", requestId: command.requestId });
    } catch (error) {
      send(socket, { type: "request.error", requestId: command.requestId, message: publicError(error) });
    }
  };

  server.on("upgrade", (request, socket, head) => {
    if (parseRuntimeResumeRequest(request.url, websocketPath).kind === "invalid") {
      return rejectUpgrade(socket, 404);
    }
    if (!allowedOrigin(request.headers.origin)) return rejectUpgrade(socket, 403);
    if (runtimeSync.connectionCount >= MAX_CLIENTS) return rejectUpgrade(socket, 503);
    webSockets.handleUpgrade(request, socket, head, (webSocket) => webSockets.emit("connection", webSocket, request));
  });

  webSockets.on("connection", (socket, request) => {
    let inFlightCommands = 0;
    const resumeRequest = parseRuntimeResumeRequest(request.url, websocketPath);
    runtimeSync.connect(socket, resumeRequest, {
      snapshot: currentSnapshot,
      approvals: pendingApprovals.values(),
      inputs: pendingInputs.values(),
      plans: agentPlans.values(),
    });
    socket.on("message", (data, isBinary) => {
      const parsed = parseCommand(data, isBinary);
      if (parsed.error) send(socket, parsed.error);
      else if (parsed.command) {
        if (inFlightCommands >= MAX_IN_FLIGHT_COMMANDS) {
          send(socket, { type: "request.error", requestId: parsed.command.requestId, message: "Too many requests are already running." });
          return;
        }
        inFlightCommands += 1;
        void execute(socket, parsed.command).finally(() => { inFlightCommands -= 1; });
      }
    });
    socket.on("close", () => {
      runtimeSync.disconnect(socket);
      terminals.disposeOwner(socket);
      isolatedRuns.stopOwned(socket);
    });
    socket.on("error", () => { /* Connection failures are isolated and cleaned up by close. */ });
  });

  server.on("error", () => { /* Listen errors are surfaced below; later socket errors are isolated. */ });
  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error): void => rejectListen(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => { server.off("error", onError); resolveListen(); });
  }).catch((error: unknown) => { store.close(); throw error; });

  const address = server.address();
  if (!address || typeof address === "string") { store.close(); throw new Error("Runtime did not receive a local port."); }

  if (enableProviders) void refreshProviderInfo(undefined, true).catch(() => {
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
      terminals.disposeAll();
      await isolatedRuns.dispose(cause);
      await turns.dispose(cause);
      runtimeSync.terminateAll((client) => client.terminate());
      await Promise.all([
        new Promise<void>((resolveClose) => webSockets.close(() => resolveClose())),
        new Promise<void>((resolveClose) => server.close(() => resolveClose())),
      ]);
      store.close();
    },
  };
}
