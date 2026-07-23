import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { isAbsolute, join, resolve } from "node:path";

import WebSocket, { WebSocketServer } from "ws";

import {
  PROTOCOL_VERSION,
  type AgentActivity,
  type AgentApprovalRequest,
  type AgentInputRequest,
  type AgentPlan,
  type AppSnapshot,
  type ClientCommand,
  type CheckpointSummary,
  type GitStatusSnapshot,
  type Conversation,
  type ProviderInfo,
  type ServerEvent,
} from "../shared/contracts";
import {
  buildDiffContext,
  diffFileFingerprint,
  diffHunkFingerprint,
  DiffContextError,
  parseUnifiedDiff,
  selectedLineFingerprint,
} from "../shared/diff-review";
import { RuntimeStore } from "./database";
import { CheckpointError, createCheckpoint, deleteCheckpoints, restoreCheckpoint } from "./checkpoints";
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
import { PROVIDER_IDS, ProviderManager, type ProviderActivityEvent, type ProviderDetection, type ProviderRunInput } from "./providers";
import { ProviderMetadataCache, type ProviderMetadata } from "./provider/metadata";
import { TerminalManager } from "./terminal";
import {
  WorkspaceError,
  discoverPackageScripts,
  identifyPreviewScripts,
  listWorkspaceEntries,
  readWorkspaceTextFile,
  searchWorkspaceEntries,
} from "./workspace";
import { projectActionCommand as actionCommand, requireRuntimeDirectory as ensureDirectory } from "./runtime-commands";
import { publicRuntimeError as publicError, RuntimeRequestError as RequestError } from "./runtime-errors";
import { inspectProjectIdentity } from "./project-identity";
import {
  isAllowedRuntimeOrigin as allowedOrigin,
  parseRuntimeCommand as parseCommand,
  rejectRuntimeUpgrade as rejectUpgrade,
  sendRuntimeEvent as send,
} from "./runtime-protocol";
import {
  agentActivityKind as activityKind,
  agentActivityStatus as activityStatus,
  changedFiles,
  emptyGitStatusSnapshot as emptyGitStatus,
  gitStatusSnapshot as statusSnapshot,
  initialProviderSnapshots,
  providerSnapshot,
} from "./runtime-snapshots";
import {
  ActiveReviewSummaryRegistry,
  buildReviewSummaryPrompt,
  DEFAULT_REVIEW_SUMMARY_TIMEOUT_MS,
  parseReviewSummaryResult,
  requireCurrentReviewSummaryFingerprint,
  withReviewSummaryTimeout,
} from "./review-summary";

const MAX_PAYLOAD_BYTES = 256 * 1024;
const MAX_CLIENTS = 16;
const MAX_IN_FLIGHT_COMMANDS = 32;

type ReviewSelectionPayload = Extract<ClientCommand, { type: "review.selection.ask" | "review.selection.revise" }>["payload"];

export function readOnlyReviewRunInput(
  conversation: Pick<Conversation, "providerId" | "model" | "reasoningEffort" | "interactionMode" | "accessMode" | "providerSessionId">,
  conversationId: string,
  cwd: string,
  prompt: string,
): ProviderRunInput {
  return {
    providerId: conversation.providerId,
    conversationId,
    cwd,
    prompt,
    model: conversation.model || undefined,
    reasoningEffort: conversation.reasoningEffort || undefined,
    interactionMode: "plan",
    access: "supervised",
  };
}

function providerLabel(providerId: ProviderInfo["id"]): string {
  return providerId === "codex" ? "Codex" : providerId === "claude" ? "Claude" : providerId === "cursor" ? "Cursor" : "OpenCode";
}

function projectActionKind(name: string, command: string, preview: boolean): "check" | "service" {
  const value = `${name} ${command}`.toLowerCase();
  return preview || /(?:^|[:\s-])(dev|serve|server|start|watch|preview)(?:$|[:\s-])/u.test(value) ? "service" : "check";
}

function servicePort(output: string): number | null {
  const plain = output.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/gu, "");
  const match = /(?:https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])|\blocalhost)[:/](\d{2,5})/iu.exec(plain);
  const port = Number(match?.[1]);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : null;
}

export interface RuntimeOptions {
  dataDirectory: string;
  defaultWorkspacePath: string;
  enableProviders?: boolean;
  reviewSummaryTimeoutMs?: number;
}

export interface RunningRuntime {
  websocketUrl: string;
  close: () => Promise<void>;
}

export async function startRuntime(options: RuntimeOptions): Promise<RunningRuntime> {
  const dataDirectory = resolve(options.dataDirectory);
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const store = new RuntimeStore(join(dataDirectory, "inertia.sqlite"), options.defaultWorkspacePath);
  await Promise.all(store.snapshot().projects.map(async (project) => {
    try {
      const identity = await inspectProjectIdentity(project.path);
      store.updateProject(project.id, identity);
    } catch {
      // Missing or temporarily unavailable folders remain visible and isolated by their stored path.
    }
  }));
  const enableProviders = options.enableProviders ?? true;
  const terminals = new TerminalManager();
  const metadataCache = new ProviderMetadataCache({
    persistence: {
      load: () => store.loadProviderMetadata(),
      save: (metadata) => store.saveProviderMetadata(metadata),
    },
  });
  const savedSettings = store.snapshot().settings;
  const providers = new ProviderManager({
    metadataCache,
    commands: savedSettings.codexBinaryPath ? { codex: savedSettings.codexBinaryPath } : undefined,
  });
  const cachedProviderMetadata = Object.fromEntries(PROVIDER_IDS.map((providerId) => [providerId, providers.cachedMetadata(providerId)]));
  let providerInfo = initialProviderSnapshots(enableProviders, cachedProviderMetadata);
  const clients = new Set<WebSocket>();
  const pendingApprovals = new Map<string, AgentApprovalRequest>();
  const pendingInputs = new Map<string, AgentInputRequest>();
  const agentPlans = new Map<string, AgentPlan>(store.snapshot().plans.map((plan) => [plan.conversationId, plan]));
  const activeSelectionReviews = new Map<string, {
    temporaryConversationId: string;
    runId: string;
    cancelled: boolean;
  }>();
  const activeReviewSummaries = new ActiveReviewSummaryRegistry<WebSocket>();
  const managedActionRuns = new Map<string, { terminalId: string }>();
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
    if (run.kind === "check" || run.kind === "service") return managedActionRuns.has(run.id);
    if (run.kind !== "agent" || !run.conversationId) return false;
    return providers.isRunning(run.conversationId)
      || activeReviewSummaries.has(run.conversationId)
      || activeSelectionReviews.get(run.conversationId)?.runId === run.id;
  };
  const currentSnapshot = (): AppSnapshot => {
    const snapshot = store.snapshot(providerInfo);
    return {
      ...snapshot,
      runs: snapshot.runs.map((run) => ({ ...run, canStop: canStopWorkspaceRun(run) })),
    };
  };
  const broadcast = (event: ServerEvent): void => {
    for (const client of clients) send(client, event);
  };
  const broadcastSnapshot = (): void => broadcast({ type: "snapshot.updated", snapshot: currentSnapshot() });
  const sourceControlDetail = (conversationId?: string): string => {
    if (!conversationId) return "Started from the workspace";
    const conversation = store.conversation(conversationId);
    return `${providerLabel(conversation.providerId)} · ${conversation.title}`;
  };
  const trackedSourceControl = async <T>(
    label: string,
    projectId: string,
    conversationId: string | undefined,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const activity = store.createWorkspaceRun({
      kind: "source-control",
      projectId,
      conversationId: conversationId ?? null,
      label,
      detail: sourceControlDetail(conversationId),
      status: "running",
      port: null,
    });
    broadcastSnapshot();
    try {
      const result = await operation();
      store.updateWorkspaceRun(activity.id, { status: "succeeded" });
      broadcastSnapshot();
      return result;
    } catch (error) {
      store.updateWorkspaceRun(activity.id, { status: "failed", detail: publicError(error) });
      broadcastSnapshot();
      throw error;
    }
  };
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
    prompt: string;
    patch: string;
    filePath: string;
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
        purpose,
        instruction: selection.comment,
      });
    } catch (error) {
      if (error instanceof DiffContextError) throw new RequestError(error.message);
      throw error;
    }
    return {
      prompt: context.text,
      patch: diff.text,
      filePath: file.path,
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
    const turnIndex = store.snapshot().checkpoints.filter((checkpoint) => checkpoint.conversationId === conversationId).length + 1;
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

  const startAgent = (
    conversationId: string,
    prompt: string,
    attachmentPaths: string[],
    onSettled?: (status: "completed" | "failed" | "cancelled") => Promise<void> | void,
  ): void => {
    const conversation = store.conversation(conversationId);
    const runId = randomUUID();
    const runStartedAt = Date.now();
    store.createWorkspaceRun({
      id: runId,
      kind: "agent",
      projectId: conversation.projectId,
      conversationId,
      label: conversation.model ? `${providerLabel(conversation.providerId)} · ${conversation.model}` : providerLabel(conversation.providerId),
      detail: conversation.title,
      status: "running",
      port: null,
    });
    agentPlans.delete(conversationId);
    store.clearAgentPlan(conversationId);
    store.updateConversation(conversationId, { status: "running" });
    broadcast({ type: "agent.started", conversationId, runId });
    broadcastSnapshot();

    let assistantText = "";
    let assistantMessageId: string | null = null;
    let assistantFlushTimer: NodeJS.Timeout | undefined;
    const flushAssistantMessage = (): void => {
      if (assistantFlushTimer) {
        clearTimeout(assistantFlushTimer);
        assistantFlushTimer = undefined;
      }
      if (!assistantText) return;
      if (assistantMessageId) store.updateMessageContent(assistantMessageId, assistantText);
      else assistantMessageId = store.createMessage(conversationId, assistantText, "assistant").id;
    };
    const appendAssistantText = (text: string): void => {
      assistantText = `${assistantText}${text}`.slice(0, 4 * 1024 * 1024);
      if (!assistantMessageId) flushAssistantMessage();
      else if (!assistantFlushTimer) {
        assistantFlushTimer = setTimeout(flushAssistantMessage, 120);
        assistantFlushTimer.unref();
      }
    };
    let reasoningText = "";
    let reasoningId: string | null = null;
    let reasoningFlushTimer: NodeJS.Timeout | undefined;
    const flushReasoning = (): void => {
      if (reasoningFlushTimer) {
        clearTimeout(reasoningFlushTimer);
        reasoningFlushTimer = undefined;
      }
      if (!reasoningText) return;
      if (!reasoningId) reasoningId = store.createReasoning(conversationId, runId).id;
      store.updateReasoning(reasoningId, { content: reasoningText });
    };
    const appendReasoning = (text: string): void => {
      reasoningText = `${reasoningText}${text}`.slice(0, 512 * 1024);
      if (!reasoningId) flushReasoning();
      else if (!reasoningFlushTimer) {
        reasoningFlushTimer = setTimeout(flushReasoning, 120);
        reasoningFlushTimer.unref();
      }
      broadcast({ type: "agent.reasoning", conversationId, runId, text });
    };
    const settleReasoning = (status: "completed" | "failed"): void => {
      flushReasoning();
      if (reasoningId) store.updateReasoning(reasoningId, { content: reasoningText, status });
    };
    const runningActivities = new Map<ProviderActivityEvent["kind"], AgentActivity[]>();
    const providerCommandRuns = new Map<string, string>();
    const syncProviderCommandRun = (
      activity: AgentActivity,
      phase?: ProviderActivityEvent["phase"],
    ): void => {
      if (activity.kind !== "command" || phase === "info") return;
      const status = activity.status === "running"
        ? "running"
        : activity.status === "failed"
          ? "failed"
          : "succeeded";
      const label = activity.title === "Command" ? "Agent command" : activity.title;
      const existingId = providerCommandRuns.get(activity.id);
      if (existingId) {
        store.updateWorkspaceRun(existingId, { label, status });
        if (status !== "running") providerCommandRuns.delete(activity.id);
        return;
      }
      const workspaceRun = store.createWorkspaceRun({
        kind: projectActionKind(activity.title, activity.title, false),
        projectId: conversation.projectId,
        conversationId,
        label,
        detail: `${providerLabel(conversation.providerId)} · ${conversation.title}`,
        status: "running",
        port: null,
      });
      if (status === "running") providerCommandRuns.set(activity.id, workspaceRun.id);
      else store.updateWorkspaceRun(workspaceRun.id, { status });
    };
    const recordProviderActivity = (event: ProviderActivityEvent): AgentActivity => {
      const status = activityStatus(event);
      const candidates = runningActivities.get(event.kind) ?? [];

      if (event.phase !== "started" && event.phase !== "info") {
        let matchIndex = candidates.findIndex((activity) => activity.title === event.label);
        if (matchIndex < 0 && (candidates.length === 1 || event.label === "Tool")) matchIndex = 0;
        if (matchIndex >= 0) {
          const [match] = candidates.splice(matchIndex, 1);
          if (candidates.length === 0) runningActivities.delete(event.kind);
          else runningActivities.set(event.kind, candidates);
          const activity = store.updateActivity(match.id, { title: event.label, status });
          syncProviderCommandRun(activity, event.phase);
          return activity;
        }
      }

      const activity = store.addActivity({
        conversationId,
        runId,
        kind: activityKind(event),
        title: event.label,
        detail: null,
        status,
      });
      syncProviderCommandRun(activity, event.phase);
      if (event.phase === "started") {
        candidates.push(activity);
        runningActivities.set(event.kind, candidates);
      }
      return activity;
    };
    const settleRunningActivities = (status: AgentActivity["status"]): void => {
      for (const activities of runningActivities.values()) {
        for (const pending of activities) {
          const activity = store.updateActivity(pending.id, { status });
          syncProviderCommandRun(activity);
          broadcast({ type: "agent.activity", activity });
        }
      }
      runningActivities.clear();
    };

    let run: ReturnType<ProviderManager["run"]>;
    try {
      run = providers.run(
        {
          providerId: conversation.providerId,
          conversationId,
          cwd: store.conversationPath(conversationId),
          prompt,
          model: conversation.model || undefined,
          reasoningEffort: conversation.reasoningEffort || undefined,
          interactionMode: conversation.interactionMode,
          access: conversation.accessMode,
          sessionId: conversation.providerSessionId || undefined,
          imagePaths: attachmentPaths,
        },
        {
          onText: (event) => {
            appendAssistantText(event.text);
            broadcast({ type: "agent.text", conversationId, runId, text: event.text });
          },
          onReasoning: (event) => appendReasoning(event.text),
          onUsage: (event) => {
            const usage = store.upsertUsage({ conversationId, ...event.usage });
            broadcast({ type: "agent.usage", usage });
          },
          onSession: (event) => {
            store.updateConversation(conversationId, { providerSessionId: event.sessionId });
          },
          onActivity: (event) => {
            const activity = recordProviderActivity(event);
            broadcast({ type: "agent.activity", activity });
            broadcastSnapshot();
          },
          onApproval: (event) => {
            const request: AgentApprovalRequest = {
              id: event.request.requestId,
              providerId: event.providerId,
              conversationId,
              runId,
              kind: event.request.kind,
              title: event.request.title,
              detail: event.request.detail ?? null,
              command: event.request.command ?? null,
              cwd: event.request.cwd ?? null,
              reason: event.request.reason ?? null,
              networkScope: event.request.networkScope ?? null,
              permissionRoots: event.request.permissionRoots,
              availableDecisions: event.request.availableDecisions,
            };
            pendingApprovals.set(request.id, request);
            store.updateConversation(conversationId, { status: "needs-input", attentionKind: "approval" });
            store.updateWorkspaceRun(runId, { status: "waiting", detail: request.title });
            broadcast({ type: "agent.approval.requested", request });
            broadcastSnapshot();
          },
          onApprovalResolved: (event) => {
            pendingApprovals.delete(event.requestId);
            broadcast({ type: "agent.approval.resolved", conversationId, requestId: event.requestId, decision: event.decision });
            if (providers.isRunning(conversationId) && ![...pendingApprovals.values(), ...pendingInputs.values()].some((request) => request.conversationId === conversationId)) {
              store.updateConversation(conversationId, { status: "running", attentionKind: null });
              store.updateWorkspaceRun(runId, { status: "running", detail: conversation.title });
              broadcastSnapshot();
            }
          },
          onInput: (event) => {
            const request: AgentInputRequest = {
              id: event.request.requestId,
              providerId: event.providerId,
              conversationId,
              runId,
              questions: event.request.questions,
              autoResolutionMs: event.request.autoResolutionMs,
            };
            pendingInputs.set(request.id, request);
            store.updateConversation(conversationId, { status: "needs-input", attentionKind: "input" });
            store.updateWorkspaceRun(runId, { status: "waiting", detail: request.questions[0]?.question ?? "Waiting for an answer" });
            broadcast({ type: "agent.input.requested", request });
            broadcastSnapshot();
          },
          onInputResolved: (event) => {
            pendingInputs.delete(event.requestId);
            broadcast({ type: "agent.input.resolved", conversationId, requestId: event.requestId });
            if (providers.isRunning(conversationId) && ![...pendingApprovals.values(), ...pendingInputs.values()].some((request) => request.conversationId === conversationId)) {
              store.updateConversation(conversationId, { status: "running", attentionKind: null });
              store.updateWorkspaceRun(runId, { status: "running", detail: conversation.title });
              broadcastSnapshot();
            }
          },
          onPlan: (event) => {
            const plan: AgentPlan = { conversationId, runId, explanation: event.explanation, steps: event.steps };
            agentPlans.set(conversationId, plan);
            store.upsertAgentPlan(plan);
            broadcast({ type: "agent.plan.updated", plan });
          },
          onMetadata: (event) => {
            applyProviderMetadata(event.providerId, providers.cachedMetadata(event.providerId));
            broadcastSnapshot();
          },
        },
      );
    } catch (error) {
      flushAssistantMessage();
      settleReasoning("failed");
      settleRunningActivities("failed");
      const message = publicError(error);
      store.updateConversation(conversationId, { status: "failed" });
      store.updateWorkspaceRun(runId, { status: "failed", detail: message });
      const activity = store.addActivity({ conversationId, runId, kind: "error", title: message, detail: null, status: "failed" });
      broadcast({ type: "agent.activity", activity });
      broadcast({ type: "agent.failed", conversationId, runId, message });
      broadcastSnapshot();
      void Promise.resolve(onSettled?.("failed")).catch(() => undefined);
      return;
    }

    void run.then(async (result) => {
      if (result.sessionId) store.updateConversation(conversationId, { providerSessionId: result.sessionId });
      if (result.text && result.text !== assistantText) assistantText = result.text;
      flushAssistantMessage();
      settleReasoning(result.status === "failed" ? "failed" : "completed");
      settleRunningActivities(result.status === "failed" ? "failed" : "completed");
      if (result.status === "completed") {
        store.updateConversation(conversationId, { status: "completed" });
        store.updateWorkspaceRun(runId, { status: "succeeded", detail: conversation.title });
        broadcast({ type: "agent.completed", conversationId, runId });
      } else if (result.status === "cancelled") {
        store.updateConversation(conversationId, { status: "idle" });
        store.updateWorkspaceRun(runId, { status: "cancelled", detail: conversation.title });
        broadcast({ type: "agent.completed", conversationId, runId });
      } else {
        const message = result.error ?? "The provider could not complete the request.";
        store.updateConversation(conversationId, { status: "failed" });
        store.updateWorkspaceRun(runId, { status: "failed", detail: message });
        const activity = store.addActivity({ conversationId, runId, kind: "error", title: message, detail: null, status: "failed" });
        broadcast({ type: "agent.activity", activity });
        broadcast({ type: "agent.failed", conversationId, runId, message });
      }
      broadcastSnapshot();
      await Promise.resolve(onSettled?.(result.status === "completed" ? "completed" : result.status === "cancelled" ? "cancelled" : "failed")).catch(() => undefined);
      broadcastSnapshot();
      if (result.status === "completed") {
        const current = providers.cachedMetadata(conversation.providerId);
        const fields: Array<"models" | "rateLimits"> = [];
        if (current.metadataState.models.freshness !== "fresh" && conversation.providerId !== "cursor") fields.push("models");
        const rateLimitsUpdatedAt = current.metadataState.rateLimits.updatedAt
          ? Date.parse(current.metadataState.rateLimits.updatedAt)
          : Number.NaN;
        if ((conversation.providerId === "codex" || conversation.providerId === "claude") && !(rateLimitsUpdatedAt >= runStartedAt)) {
          fields.push("rateLimits");
        }
        if (fields.length > 0) {
          void providers.metadata(
            conversation.providerId,
            options.defaultWorkspacePath,
            { fields, force: true },
          ).then((metadata) => {
            applyProviderMetadata(conversation.providerId, metadata);
            if (!closed) broadcastSnapshot();
          }).catch(() => undefined);
        }
      }
    }).catch(async (error: unknown) => {
      flushAssistantMessage();
      settleReasoning("failed");
      settleRunningActivities("failed");
      const message = publicError(error);
      store.updateConversation(conversationId, { status: "failed" });
      store.updateWorkspaceRun(runId, { status: "failed", detail: message });
      broadcast({ type: "agent.failed", conversationId, runId, message });
      broadcastSnapshot();
      await Promise.resolve(onSettled?.("failed")).catch(() => undefined);
      broadcastSnapshot();
    });
  };

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
          store.removeProject(command.payload.projectId);
          break;
        case "project.update": {
          const { projectId, ...update } = command.payload;
          store.updateProject(projectId, update);
          break;
        }
        case "conversation.create": {
          const conversation = store.createConversation(command.payload.projectId, command.payload.title, command.payload);
          if (command.payload.useWorktree) {
            try {
              const repositoryPath = store.projectPath(command.payload.projectId);
              const status = await getRepositoryStatus(repositoryPath);
              if (!status.branch) throw new RequestError("Check out a branch before creating an isolated worktree.");
              const branch = `inertia/${conversation.id.slice(0, 8)}`;
              const target = join(dataDirectory, "worktrees", conversation.id);
              mkdirSync(resolve(target, ".."), { recursive: true, mode: 0o700 });
              await trackedSourceControl("Create worktree", command.payload.projectId, conversation.id, () =>
                createWorktree(repositoryPath, target, { branch, createBranch: true, startPoint: status.branch! }));
              store.updateConversation(conversation.id, { worktreePath: target, branch });
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
        case "conversation.update": {
          const { conversationId, ...update } = command.payload;
          if (update.providerId !== undefined) {
            const current = store.conversation(conversationId);
            if (
              update.providerId !== current.providerId
              && (current.providerSessionId !== null || store.hasConversationMessages(conversationId))
            ) {
              throw new RequestError("Start a new chat to use a different agent. Existing chats keep their original agent context.");
            }
          }
          const changesRunConfiguration = (
            update.providerId !== undefined
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
            try {
              await removeWorktree(store.projectPath(conversation.projectId), conversation.worktreePath, false);
            } catch (error) {
              if (!(error instanceof GitError && error.code === "not-found")) throw error;
            }
          }
          await deleteCheckpoints(store.projectPath(conversation.projectId), conversation.id).catch(() => undefined);
          store.deleteConversation(command.payload.conversationId);
          break;
        }
        case "message.send": {
          const conversation = store.conversation(command.payload.conversationId);
          if (providers.isRunning(conversation.id) || activeSelectionReviews.has(conversation.id) || activeReviewSummaries.has(conversation.id)) {
            throw new RequestError("Wait for the current run or read-only review to finish first.");
          }
          if (enableProviders) {
            const selectedProvider = providerInfo.find(({ id }) => id === conversation.providerId);
            if (!selectedProvider?.canRun) {
              throw new RequestError(selectedProvider?.statusMessage ?? "This agent is not ready. Open Settings to finish setup.");
            }
            const selectedModel = conversation.model
              ? selectedProvider.models.find(({ id }) => id === conversation.model)
              : selectedProvider.models.find(({ isDefault }) => isDefault) ?? selectedProvider.models[0];
            if (conversation.model && selectedProvider.models.length > 0 && !selectedModel) {
              throw new RequestError("That model is no longer offered by this provider. Choose another model before sending.");
            }
            if (
              conversation.reasoningEffort
              && selectedModel?.reasoningOptions.length
              && !selectedModel.reasoningOptions.some(({ value }) => value === conversation.reasoningEffort)
            ) {
              throw new RequestError("That reasoning level is not supported by the selected model.");
            }
          }
          if (enableProviders) {
            try {
              const path = store.conversationPath(conversation.id);
              const status = await getRepositoryStatus(path);
              const captured = await createCheckpoint(path, join(dataDirectory, "checkpoint-indexes"), conversation.id);
              const turnIndex = store.snapshot().checkpoints.filter(({ conversationId }) => conversationId === conversation.id).length + 1;
              store.addCheckpoint({ conversationId: conversation.id, ref: captured.ref, label: `Before turn ${turnIndex}`, turnIndex, filesChanged: status.files.length, insertions: status.insertions, deletions: status.deletions });
            } catch (error) {
              if (!(error instanceof CheckpointError && error.message === "not-repository") && !(error instanceof GitError && error.code === "not-repository")) {
                // A checkpoint is protective but must not prevent an otherwise valid provider run.
              }
            }
          }
          store.createMessage(conversation.id, command.payload.content, "user", command.payload.attachments);
          if (conversation.title === "New chat" || conversation.title === "New thread") {
            store.updateConversation(conversation.id, { title: command.payload.content.slice(0, 64) });
          }
          send(socket, { type: "request.ok", requestId: command.requestId });
          broadcastSnapshot();
          if (enableProviders) {
            startAgent(conversation.id, command.payload.content, command.payload.attachments.map((attachment) => attachment.path));
          }
          return;
        }
        case "agent.stop":
          if (
            !activeReviewSummaries.stop(command.payload.conversationId, "cancelled")
            && !providers.cancel(command.payload.conversationId)
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
            const managed = managedActionRuns.get(activity.id);
            if (!managed || !terminals.closeManaged(managed.terminalId)) {
              throw new RequestError("That process is no longer owned by the local runtime.");
            }
            break;
          }
          if (activity.kind !== "agent" || !activity.conversationId) {
            throw new RequestError("This activity cannot be stopped safely.");
          }
          const selection = activeSelectionReviews.get(activity.conversationId);
          if (selection?.runId === activity.id) {
            selection.cancelled = true;
            if (!providers.cancel(selection.temporaryConversationId)) {
              throw new RequestError("That read-only review has already finished.");
            }
            break;
          }
          if (
            !activeReviewSummaries.stop(activity.conversationId, "cancelled")
            && !providers.cancel(activity.conversationId)
          ) {
            throw new RequestError("That agent run is no longer active.");
          }
          break;
        }
        case "activity.dismiss":
          store.dismissWorkspaceRun(command.payload.runId);
          break;
        case "agent.approval.respond": {
          const pending = pendingApprovals.get(command.payload.requestId);
          if (!pending || pending.conversationId !== command.payload.conversationId) throw new RequestError("That approval request is no longer pending.");
          if (!pending.availableDecisions.includes(command.payload.decision)) {
            throw new RequestError("That response is not available for this approval request.");
          }
          if (!providers.respondToApproval(command.payload.conversationId, command.payload.requestId, command.payload.decision)) {
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
          if (!providers.respondToInput(command.payload.conversationId, command.payload.requestId, command.payload.answers)) {
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
        case "git.selection.revert": {
          if (command.payload.conversationId && store.hasActiveWorkspaceRunForConversation(command.payload.conversationId)) {
            throw new RequestError("Stop the active run or review before reverting selected changes.");
          }
          const path = workspacePath(command.payload.projectId, command.payload.conversationId);
          const reversed = await trackedSourceControl(
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
          const diff = await trackedSourceControl(
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
          if (providers.isRunning(conversation.id) || activeSelectionReviews.has(conversation.id) || activeReviewSummaries.has(conversation.id)) {
            throw new RequestError("Wait for the current agent or review turn to finish first.");
          }
          const provider = providerInfo.find(({ id }) => id === conversation.providerId);
          if (!provider?.canRun) throw new RequestError(provider?.statusMessage ?? "The selected review agent is unavailable.");
          const context = await selectedReviewContext(command.payload, "ask");
          const temporaryConversationId = `${conversation.id}:read-only-review:${randomUUID()}`;
          const reviewDirectory = await mkdtemp(join(dataDirectory, "read-only-review-"));
          await chmod(reviewDirectory, 0o500);
          const reviewRun = store.createWorkspaceRun({
            kind: "agent",
            projectId: conversation.projectId,
            conversationId: conversation.id,
            label: `${providerLabel(conversation.providerId)} · read-only question`,
            detail: `${context.filePath} · ${context.selectedLineCount} selected lines`,
            status: "running",
            port: null,
          });
          activeSelectionReviews.set(conversation.id, {
            temporaryConversationId,
            runId: reviewRun.id,
            cancelled: false,
          });
          store.createMessage(conversation.id, context.prompt, "user");
          broadcastSnapshot();
          let streamed = "";
          let unsupportedInteraction = false;
          try {
            const result = await providers.run(readOnlyReviewRunInput(
              conversation,
              temporaryConversationId,
              reviewDirectory,
              context.prompt,
            ), {
              onText: (event) => { streamed = `${streamed}${event.text}`.slice(0, 4 * 1024 * 1024); },
              onApproval: () => {
                unsupportedInteraction = true;
                providers.cancel(temporaryConversationId);
              },
              onInput: () => {
                unsupportedInteraction = true;
                providers.cancel(temporaryConversationId);
              },
            });
            if (unsupportedInteraction) throw new RequestError("The review agent requested an unsupported interaction, so the read-only question was stopped.");
            if (result.status !== "completed") throw new RequestError(result.error ?? "The review agent could not answer this question.");
            const answer = (result.text || streamed).trim();
            if (!answer) throw new RequestError("The review agent returned an empty answer.");
            store.createMessage(conversation.id, answer.slice(0, 4 * 1024 * 1024), "assistant");
            store.updateWorkspaceRun(reviewRun.id, { status: "succeeded", detail: `${context.filePath} reviewed without a resumable session` });
            send(socket, { type: "request.ok", requestId: command.requestId });
            broadcastSnapshot();
          } catch (error) {
            const cancelled = activeSelectionReviews.get(conversation.id)?.cancelled ?? false;
            store.updateWorkspaceRun(reviewRun.id, {
              status: cancelled ? "cancelled" : "failed",
              detail: cancelled ? "Stopped" : publicError(error),
            });
            broadcastSnapshot();
            if (cancelled) {
              send(socket, { type: "request.ok", requestId: command.requestId });
              return;
            }
            throw error;
          } finally {
            activeSelectionReviews.delete(conversation.id);
            await chmod(reviewDirectory, 0o700).catch(() => undefined);
            await rm(reviewDirectory, { recursive: true, force: true }).catch(() => undefined);
          }
          return;
        }
        case "review.selection.revise": {
          if (!enableProviders) throw new RequestError("Revision requests are unavailable in this runtime.");
          const conversation = store.conversation(command.payload.conversationId);
          if (providers.isRunning(conversation.id) || activeSelectionReviews.has(conversation.id) || activeReviewSummaries.has(conversation.id)) {
            throw new RequestError("Wait for the current agent or review turn to finish first.");
          }
          const provider = providerInfo.find(({ id }) => id === conversation.providerId);
          if (!provider?.canRun) throw new RequestError(provider?.statusMessage ?? "The selected agent is unavailable.");
          const context = await selectedReviewContext(command.payload, "revision");
          const before = parseUnifiedDiff(context.patch);
          const beforeFiles = Object.fromEntries(before.files.map((file) => [file.path, diffFileFingerprint(file)]));
          const checkpoint = await captureRequiredCheckpoint(conversation.id, `Before revision · ${context.filePath}`);
          store.createMessage(conversation.id, context.prompt, "user");
          startAgent(conversation.id, context.prompt, [], async (status) => {
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
            );
          });
          send(socket, { type: "request.ok", requestId: command.requestId });
          broadcastSnapshot();
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
          if (providers.isRunning(conversation.id) || activeSelectionReviews.has(conversation.id)) {
            throw new RequestError("Wait for the current agent or read-only review to finish before summarizing its changes.");
          }
          const provider = providerInfo.find(({ id }) => id === conversation.providerId);
          if (!provider?.canRun) throw new RequestError(provider?.statusMessage ?? "The selected review agent is unavailable.");
          const temporaryConversationId = `${conversation.id}:diff-summary:${randomUUID()}`;
          activeReviewSummaries.reserve(conversation.id, temporaryConversationId, socket);
          let reviewDirectory: string | null = null;
          let reviewRunId: string | null = null;
          let providerRun: ReturnType<ProviderManager["run"]> | null = null;
          try {
            const diff = await getUnifiedDiff(store.conversationPath(conversation.id), { ignoreWhitespace: command.payload.ignoreWhitespace });
            if (diff.truncated) throw new RequestError("The diff preview is truncated. Reduce or commit part of the change set before generating a complete summary.");
            const structured = parseUnifiedDiff(diff.text);
            if (structured.fingerprint !== command.payload.fingerprint) throw new RequestError("The changes moved before the review started. Refresh and try again.");
            if (structured.files.length === 0) throw new RequestError("There are no changes to summarize.");
            const prompt = buildReviewSummaryPrompt(diff.text, structured.files);

            if (activeReviewSummaries.stopReason(conversation.id, temporaryConversationId)) {
              throw new RequestError("The change summary was cancelled before it started. No summary was saved.");
            }
            reviewDirectory = await mkdtemp(join(dataDirectory, "read-only-summary-"));
            await chmod(reviewDirectory, 0o500);
            const reviewRun = store.createWorkspaceRun({
              kind: "agent",
              projectId: conversation.projectId,
              conversationId: conversation.id,
              label: `${providerLabel(conversation.providerId)} · read-only diff summary${conversation.model ? ` · ${conversation.model}` : ""}`,
              detail: `${structured.files.length} ${structured.files.length === 1 ? "file" : "files"} · isolated session`,
              status: "running",
              port: null,
            });
            reviewRunId = reviewRun.id;
            broadcastSnapshot();

            let streamed = "";
            let streamedTruncated = false;
            providerRun = providers.run(readOnlyReviewRunInput(
              conversation,
              temporaryConversationId,
              reviewDirectory,
              prompt,
            ), {
              onText: (event) => {
                const next = `${streamed}${event.text}`;
                if (next.length > 512_000) streamedTruncated = true;
                streamed = next.slice(0, 512_000);
              },
              onApproval: () => {
                activeReviewSummaries.stop(conversation.id, "unsupported-interaction");
              },
              onInput: () => {
                activeReviewSummaries.stop(conversation.id, "unsupported-interaction");
              },
            });
            activeReviewSummaries.attachCancel(conversation.id, temporaryConversationId, () => {
              providers.cancel(temporaryConversationId);
            });
            const result = await withReviewSummaryTimeout(
              providerRun,
              options.reviewSummaryTimeoutMs ?? DEFAULT_REVIEW_SUMMARY_TIMEOUT_MS,
              () => activeReviewSummaries.stop(conversation.id, "timeout"),
            );
            const stopReason = activeReviewSummaries.stopReason(conversation.id, temporaryConversationId);
            if (stopReason === "unsupported-interaction") {
              throw new RequestError("The review agent requested an unsupported interaction, so the summary was stopped. No summary was saved.");
            }
            if (stopReason === "disconnected") {
              throw new RequestError("The summary owner disconnected, so the isolated review was stopped. No summary was saved.");
            }
            if (stopReason === "cancelled") {
              throw new RequestError("The change summary was cancelled. No summary was saved.");
            }
            if (stopReason === "timeout") {
              throw new RequestError("The agent summary timed out and was stopped. No summary was saved.");
            }
            if (result.status !== "completed") throw new RequestError(result.error ?? "The review agent could not summarize these changes.");
            if (result.textTruncated || streamedTruncated) {
              throw new RequestError("The review agent returned a truncated result. No summary was saved.");
            }
            const summary = parseReviewSummaryResult(
              conversation.id,
              conversation.providerId,
              structured.fingerprint,
              structured.files,
              result.text || streamed,
            );

            const current = await getUnifiedDiff(store.conversationPath(conversation.id), { ignoreWhitespace: command.payload.ignoreWhitespace });
            requireCurrentReviewSummaryFingerprint(structured.fingerprint, current.text, current.truncated);
            store.upsertReviewSummary(summary);
            store.updateWorkspaceRun(reviewRun.id, {
              status: "succeeded",
              detail: `${structured.files.length} ${structured.files.length === 1 ? "file" : "files"} summarized · isolated session`,
            });
            send(socket, { type: "request.result", requestId: command.requestId, result: { kind: "review.summary", summary } });
            broadcastSnapshot();
          } catch (error) {
            const stopReason = activeReviewSummaries.stopReason(conversation.id, temporaryConversationId);
            if (reviewRunId) {
              store.updateWorkspaceRun(reviewRunId, {
                status: stopReason === "cancelled" || stopReason === "disconnected" ? "cancelled" : "failed",
                detail: publicError(error),
              });
              broadcastSnapshot();
            }
            if (stopReason === "cancelled") {
              send(socket, { type: "request.ok", requestId: command.requestId });
              return;
            }
            throw error;
          } finally {
            if (providers.isRunning(temporaryConversationId)) providers.cancel(temporaryConversationId);
            activeReviewSummaries.finish(conversation.id, temporaryConversationId);
            if (reviewDirectory) {
              await chmod(reviewDirectory, 0o700).catch(() => undefined);
              await rm(reviewDirectory, { recursive: true, force: true }).catch(() => undefined);
            }
          }
          return;
        }
        case "review.summary.cancel": {
          const conversation = store.conversation(command.payload.conversationId);
          if (!activeReviewSummaries.stop(conversation.id, "cancelled")) {
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
          const result = await trackedSourceControl("Create branch", command.payload.projectId, undefined, () =>
            createBranch(workspacePath(command.payload.projectId), command.payload.name));
          send(socket, { type: "request.result", requestId: command.requestId, result: { kind: "git.action", message: `Created ${result.status.branch ?? command.payload.name}.` } });
          return;
        }
        case "git.branch.switch": {
          const result = await trackedSourceControl("Switch branch", command.payload.projectId, undefined, () =>
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
          await trackedSourceControl("Create worktree", command.payload.projectId, command.payload.conversationId, () =>
            createWorktree(store.projectPath(command.payload.projectId), target, { branch: command.payload.branch, createBranch: true, startPoint: command.payload.baseBranch }));
          store.updateConversation(conversation.id, { worktreePath: target, branch: command.payload.branch });
          send(socket, { type: "request.result", requestId: command.requestId, result: { kind: "worktree.created", path: target, branch: command.payload.branch } });
          broadcastSnapshot();
          return;
        }
        case "git.pull":
          await trackedSourceControl("Pull changes", command.payload.projectId, command.payload.conversationId, () =>
            pullRepository(workspacePath(command.payload.projectId, command.payload.conversationId)));
          send(socket, { type: "request.result", requestId: command.requestId, result: { kind: "git.action", message: "Pulled the latest changes." } });
          return;
        case "git.commit": {
          const path = workspacePath(command.payload.projectId, command.payload.conversationId);
          const result = await trackedSourceControl("Commit changes", command.payload.projectId, command.payload.conversationId, () =>
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
          await trackedSourceControl("Push branch", command.payload.projectId, command.payload.conversationId, () =>
            pushCurrentBranch(workspacePath(command.payload.projectId, command.payload.conversationId)));
          send(socket, { type: "request.result", requestId: command.requestId, result: { kind: "git.action", message: "Pushed the current branch." } });
          return;
        case "git.pr.open": {
          const url = await trackedSourceControl("Prepare pull request", command.payload.projectId, command.payload.conversationId, () =>
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
          let scripts: Awaited<ReturnType<typeof discoverPackageScripts>>;
          try {
            scripts = await discoverPackageScripts(workspacePath(command.payload.projectId, command.payload.conversationId));
          } catch (error) {
            if (error instanceof WorkspaceError && error.code === "not-found") {
              send(socket, { type: "request.result", requestId: command.requestId, result: { kind: "project.actions", actions: [] } });
              return;
            }
            throw error;
          }
          const previews = new Set(identifyPreviewScripts(scripts.scripts).map((script) => script.name));
          send(socket, { type: "request.result", requestId: command.requestId, result: { kind: "project.actions", actions: scripts.scripts.slice(0, 50).map((script) => ({ id: script.name, label: script.name, command: script.command, preview: previews.has(script.name) })) } });
          return;
        }
        case "project.action.run": {
          const cwd = workspacePath(command.payload.projectId, command.payload.conversationId);
          const scripts = await discoverPackageScripts(cwd);
          const action = scripts.scripts.find((script) => script.name === command.payload.actionId);
          if (!action) throw new RequestError("That project action is no longer available.");
          const preview = identifyPreviewScripts(scripts.scripts).some((script) => script.name === action.name);
          const kind = projectActionKind(action.name, action.command, preview);
          const conversation = command.payload.conversationId ? store.conversation(command.payload.conversationId) : null;
          const activity = store.createWorkspaceRun({
            kind,
            projectId: command.payload.projectId,
            conversationId: command.payload.conversationId ?? null,
            actionId: action.name,
            label: action.name,
            detail: kind === "service"
              ? conversation ? `${providerLabel(conversation.providerId)} · ${conversation.title}` : action.command
              : action.command,
            status: "running",
            port: null,
          });
          let detectedPort: number | null = null;
          let serviceOutput = "";
          const terminalId = terminals.create(
            socket,
            cwd,
            command.payload.cols,
            command.payload.rows,
            (exitCode) => {
              managedActionRuns.delete(activity.id);
              try {
                store.updateWorkspaceRun(activity.id, {
                  status: exitCode === 0 ? "succeeded" : exitCode === 130 ? "cancelled" : "failed",
                  detail: exitCode === 0 ? activity.detail : exitCode === 130 ? "Stopped" : `Exited with code ${exitCode}`,
                });
              } catch {
                return; // The project may have been removed while its terminal was still open.
              }
              if (!closed) broadcastSnapshot();
            },
            (output) => {
              if (kind !== "service" || detectedPort !== null) return;
              serviceOutput = `${serviceOutput}${output}`.slice(-4_096);
              const port = servicePort(serviceOutput);
              if (!port) return;
              detectedPort = port;
              try { store.updateWorkspaceRun(activity.id, { port }); }
              catch { return; }
              if (!closed) broadcastSnapshot();
            },
          );
          managedActionRuns.set(activity.id, { terminalId });
          try {
            terminals.input(socket, terminalId, `${actionCommand(scripts.packageManager, action.name)}\r`);
          } catch (error) {
            terminals.close(socket, terminalId);
            store.updateWorkspaceRun(activity.id, { status: "failed", detail: publicError(error) });
            throw error;
          }
          send(socket, { type: "terminal.created", requestId: command.requestId, terminalId });
          broadcastSnapshot();
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
    if (request.url !== websocketPath) return rejectUpgrade(socket, 404);
    if (!allowedOrigin(request.headers.origin)) return rejectUpgrade(socket, 403);
    if (clients.size >= MAX_CLIENTS) return rejectUpgrade(socket, 503);
    webSockets.handleUpgrade(request, socket, head, (webSocket) => webSockets.emit("connection", webSocket, request));
  });

  webSockets.on("connection", (socket) => {
    let inFlightCommands = 0;
    clients.add(socket);
    send(socket, { type: "server.welcome", protocolVersion: PROTOCOL_VERSION, snapshot: currentSnapshot() });
    for (const request of pendingApprovals.values()) send(socket, { type: "agent.approval.requested", request });
    for (const request of pendingInputs.values()) send(socket, { type: "agent.input.requested", request });
    for (const plan of agentPlans.values()) send(socket, { type: "agent.plan.updated", plan });
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
      clients.delete(socket);
      terminals.disposeOwner(socket);
      activeReviewSummaries.stopOwned(socket, "disconnected");
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
    close: async () => {
      if (closed) return;
      closed = true;
      terminals.disposeAll();
      for (const client of clients) activeReviewSummaries.stopOwned(client, "disconnected");
      await providers.disposeAll();
      for (const client of clients) client.terminate();
      clients.clear();
      await Promise.all([
        new Promise<void>((resolveClose) => webSockets.close(() => resolveClose())),
        new Promise<void>((resolveClose) => server.close(() => resolveClose())),
      ]);
      store.close();
    },
  };
}
