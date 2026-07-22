import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";

import WebSocket, { WebSocketServer, type RawData } from "ws";

import {
  PROTOCOL_VERSION,
  clientCommandSchema,
  type AgentActivity,
  type AgentApprovalRequest,
  type AgentInputRequest,
  type AgentPlan,
  type AppSnapshot,
  type ChangedFile,
  type ClientCommand,
  type GitStatusSnapshot,
  type ProviderInfo,
  type ServerEvent,
} from "../shared/contracts";
import { RecordNotFoundError, RuntimeStore } from "./database";
import { CheckpointError, createCheckpoint, deleteCheckpoints, restoreCheckpoint } from "./checkpoints";
import {
  GitError,
  commitChanges,
  createBranch,
  createWorktree,
  getRepositoryStatus,
  getPullRequestCreateUrl,
  getUnifiedDiff,
  listBranches,
  pullRepository,
  pushCurrentBranch,
  removeWorktree,
  switchBranch,
  type GitRepositoryStatus,
} from "./git";
import { PROVIDERS, ProviderManager, ProviderRuntimeError, type ProviderActivityEvent, type ProviderDetection } from "./providers";
import { TerminalError, TerminalManager } from "./terminal";
import {
  WorkspaceError,
  discoverPackageScripts,
  identifyPreviewScripts,
  listWorkspaceEntries,
  readWorkspaceTextFile,
  searchWorkspaceEntries,
} from "./workspace";

const MAX_PAYLOAD_BYTES = 256 * 1024;
const MAX_CLIENTS = 16;
const MAX_IN_FLIGHT_COMMANDS = 32;

export interface RuntimeOptions {
  dataDirectory: string;
  defaultWorkspacePath: string;
  enableProviders?: boolean;
}

export interface RunningRuntime {
  websocketUrl: string;
  close: () => Promise<void>;
}

function allowedOrigin(origin: string | undefined): boolean {
  if (origin === "inertia://bundle") return true;
  if (origin === undefined || origin === "null" || origin === "file://") return false;
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  } catch {
    return false;
  }
}

function rejectUpgrade(socket: import("node:stream").Duplex, status: 403 | 404 | 503): void {
  const label = status === 403 ? "Forbidden" : status === 404 ? "Not Found" : "Service Unavailable";
  socket.end(`HTTP/1.1 ${status} ${label}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function requestIdFrom(value: unknown): string {
  return typeof value === "object" && value !== null && "requestId" in value && typeof value.requestId === "string"
    ? value.requestId
    : randomUUID();
}

function send(socket: WebSocket, event: ServerEvent): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
}

function parseCommand(data: RawData, isBinary: boolean): { command?: ClientCommand; error?: ServerEvent } {
  if (isBinary) return { error: { type: "request.error", requestId: randomUUID(), message: "Binary commands are not supported." } };
  const text = Buffer.isBuffer(data)
    ? data.toString("utf8")
    : data instanceof ArrayBuffer
      ? Buffer.from(data).toString("utf8")
      : Buffer.concat(data).toString("utf8");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { error: { type: "request.error", requestId: randomUUID(), message: "Command must be valid JSON." } };
  }
  const result = clientCommandSchema.safeParse(value);
  return result.success
    ? { command: result.data }
    : { error: { type: "request.error", requestId: requestIdFrom(value), message: "Invalid command." } };
}

function ensureDirectory(path: string): string {
  const absolutePath = resolve(path);
  try {
    if (!statSync(absolutePath).isDirectory()) throw new Error();
  } catch {
    throw new RequestError("Project path must be an existing directory.");
  }
  return absolutePath;
}

function publicError(error: unknown): string {
  if (
    error instanceof RequestError ||
    error instanceof RecordNotFoundError ||
    error instanceof TerminalError ||
    error instanceof GitError ||
    error instanceof WorkspaceError ||
    error instanceof CheckpointError ||
    error instanceof ProviderRuntimeError
  ) return error.message;
  return "The request could not be completed.";
}

function providerDefaults(executionEnabled = true): ProviderInfo[] {
  return PROVIDERS.map((provider) => ({
    id: provider.id,
    label: provider.name,
    command: provider.command,
    available: false,
    version: null,
    installState: "checking",
    authState: "checking",
    canRun: !executionEnabled,
    statusMessage: "Checking installation and connection",
    models: [],
    rateLimits: [],
    supportsReasoning: provider.id === "codex",
    supportsUsage: provider.id === "codex",
  }));
}

function providerSnapshot(
  detection: ProviderDetection,
  metadata: Pick<ProviderInfo, "models" | "rateLimits"> = { models: [], rateLimits: [] },
): ProviderInfo {
  return {
    id: detection.provider.id,
    label: detection.provider.name,
    command: detection.provider.command,
    available: detection.available,
    version: detection.version ?? null,
    installState: detection.installState,
    authState: detection.authState,
    canRun: detection.canRun,
    statusMessage: detection.statusMessage ?? null,
    models: metadata.models,
    rateLimits: metadata.rateLimits,
    supportsReasoning: detection.provider.id === "codex",
    supportsUsage: detection.provider.id === "codex",
  };
}

function changedFiles(status: GitRepositoryStatus): ChangedFile[] {
  return status.files.map((file) => ({
    path: file.path,
    status: file.status,
    insertions: file.insertions,
    deletions: file.deletions,
    untracked: file.status === "untracked",
  }));
}

function statusSnapshot(status: GitRepositoryStatus): GitStatusSnapshot {
  return {
    isRepository: true,
    branch: status.branch,
    upstream: status.upstream,
    ahead: status.ahead,
    behind: status.behind,
    hasRemote: status.upstream !== null,
    files: changedFiles(status),
    insertions: status.insertions,
    deletions: status.deletions,
  };
}

function emptyGitStatus(): GitStatusSnapshot {
  return { isRepository: false, branch: null, upstream: null, ahead: 0, behind: 0, hasRemote: false, files: [], insertions: 0, deletions: 0 };
}

function activityKind(event: ProviderActivityEvent): AgentActivity["kind"] {
  if (event.kind === "command") return "command";
  if (event.kind === "reasoning") return "reasoning";
  if (event.kind === "tool") return "tool";
  return "status";
}

function activityStatus(event: ProviderActivityEvent): AgentActivity["status"] {
  if (event.phase === "failed") return "failed";
  if (event.phase === "completed" || event.phase === "info") return "completed";
  return "running";
}

function actionCommand(manager: string, actionId: string): string {
  if (!/^[A-Za-z0-9:_-]+$/u.test(actionId)) throw new RequestError("This package script name cannot be run safely from the terminal.");
  if (manager === "yarn") return `yarn ${actionId}`;
  if (manager === "pnpm") return `pnpm run ${actionId}`;
  if (manager === "bun") return `bun run ${actionId}`;
  return `npm run ${actionId}`;
}

export async function startRuntime(options: RuntimeOptions): Promise<RunningRuntime> {
  const dataDirectory = resolve(options.dataDirectory);
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const store = new RuntimeStore(join(dataDirectory, "inertia.sqlite"), options.defaultWorkspacePath);
  const enableProviders = options.enableProviders ?? true;
  const terminals = new TerminalManager();
  const providers = new ProviderManager();
  let providerInfo = providerDefaults(enableProviders);
  const clients = new Set<WebSocket>();
  const pendingApprovals = new Map<string, AgentApprovalRequest>();
  const pendingInputs = new Map<string, AgentInputRequest>();
  const agentPlans = new Map<string, AgentPlan>(store.snapshot().plans.map((plan) => [plan.conversationId, plan]));
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

  const currentSnapshot = (): AppSnapshot => store.snapshot(providerInfo);
  const broadcast = (event: ServerEvent): void => {
    for (const client of clients) send(client, event);
  };
  const broadcastSnapshot = (): void => broadcast({ type: "snapshot.updated", snapshot: currentSnapshot() });
  const refreshProviderInfo = async (providerId?: ProviderInfo["id"], refreshEnvironment = false): Promise<void> => {
    if (!enableProviders) return;
    const enrichedSnapshot = async (detection: ProviderDetection): Promise<ProviderInfo> => {
      if (!detection.canRun) return providerSnapshot(detection);
      const metadata = await providers.metadata(detection.provider.id, options.defaultWorkspacePath).catch(() => ({ models: [], rateLimits: [] }));
      return providerSnapshot(detection, metadata);
    };
    if (providerId) {
      const detection = await providers.detect(providerId, { timeoutMs: 4_000, refreshEnvironment });
      const next = await enrichedSnapshot(detection);
      providerInfo = providerInfo.map((current) => current.id === providerId ? next : current);
    } else {
      providerInfo = await Promise.all((await providers.detectAll({ timeoutMs: 4_000, refreshEnvironment })).map(enrichedSnapshot));
    }
    if (!closed) broadcastSnapshot();
  };
  const workspacePath = (projectId: string, conversationId?: string): string => {
    if (!conversationId) return ensureDirectory(store.projectPath(projectId));
    const conversation = store.conversation(conversationId);
    if (conversation.projectId !== projectId) throw new RequestError("The thread does not belong to this project.");
    return ensureDirectory(store.conversationPath(conversationId));
  };

  const startAgent = (conversationId: string, prompt: string, attachmentPaths: string[]): void => {
    const conversation = store.conversation(conversationId);
    const runId = randomUUID();
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
          return store.updateActivity(match.id, { title: event.label, status });
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
          },
          onApproval: (event) => {
            const request: AgentApprovalRequest = {
              id: event.request.requestId,
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
            store.updateConversation(conversationId, { status: "needs-input" });
            broadcast({ type: "agent.approval.requested", request });
            broadcastSnapshot();
          },
          onApprovalResolved: (event) => {
            pendingApprovals.delete(event.requestId);
            broadcast({ type: "agent.approval.resolved", conversationId, requestId: event.requestId, decision: event.decision });
            if (providers.isRunning(conversationId) && ![...pendingApprovals.values(), ...pendingInputs.values()].some((request) => request.conversationId === conversationId)) {
              store.updateConversation(conversationId, { status: "running" });
              broadcastSnapshot();
            }
          },
          onInput: (event) => {
            const request: AgentInputRequest = {
              id: event.request.requestId,
              conversationId,
              runId,
              questions: event.request.questions,
              autoResolutionMs: event.request.autoResolutionMs,
            };
            pendingInputs.set(request.id, request);
            store.updateConversation(conversationId, { status: "needs-input" });
            broadcast({ type: "agent.input.requested", request });
            broadcastSnapshot();
          },
          onInputResolved: (event) => {
            pendingInputs.delete(event.requestId);
            broadcast({ type: "agent.input.resolved", conversationId, requestId: event.requestId });
            if (providers.isRunning(conversationId) && ![...pendingApprovals.values(), ...pendingInputs.values()].some((request) => request.conversationId === conversationId)) {
              store.updateConversation(conversationId, { status: "running" });
              broadcastSnapshot();
            }
          },
          onPlan: (event) => {
            const plan: AgentPlan = { conversationId, runId, explanation: event.explanation, steps: event.steps };
            agentPlans.set(conversationId, plan);
            store.upsertAgentPlan(plan);
            broadcast({ type: "agent.plan.updated", plan });
          },
        },
      );
    } catch (error) {
      flushAssistantMessage();
      settleReasoning("failed");
      settleRunningActivities("failed");
      const message = publicError(error);
      store.updateConversation(conversationId, { status: "failed" });
      const activity = store.addActivity({ conversationId, runId, kind: "error", title: message, detail: null, status: "failed" });
      broadcast({ type: "agent.activity", activity });
      broadcast({ type: "agent.failed", conversationId, runId, message });
      broadcastSnapshot();
      return;
    }

    void run.then((result) => {
      if (result.sessionId) store.updateConversation(conversationId, { providerSessionId: result.sessionId });
      if (result.text && result.text !== assistantText) assistantText = result.text;
      flushAssistantMessage();
      settleReasoning(result.status === "failed" ? "failed" : "completed");
      settleRunningActivities(result.status === "failed" ? "failed" : "completed");
      if (result.status === "completed") {
        store.updateConversation(conversationId, { status: "completed" });
        broadcast({ type: "agent.completed", conversationId, runId });
      } else if (result.status === "cancelled") {
        store.updateConversation(conversationId, { status: "idle" });
        broadcast({ type: "agent.completed", conversationId, runId });
      } else {
        const message = result.error ?? "The provider could not complete the request.";
        store.updateConversation(conversationId, { status: "failed" });
        const activity = store.addActivity({ conversationId, runId, kind: "error", title: message, detail: null, status: "failed" });
        broadcast({ type: "agent.activity", activity });
        broadcast({ type: "agent.failed", conversationId, runId, message });
      }
      broadcastSnapshot();
      void refreshProviderInfo(conversation.providerId).catch(() => undefined);
    }).catch((error: unknown) => {
      flushAssistantMessage();
      settleReasoning("failed");
      settleRunningActivities("failed");
      const message = publicError(error);
      store.updateConversation(conversationId, { status: "failed" });
      broadcast({ type: "agent.failed", conversationId, runId, message });
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
          await refreshProviderInfo(command.payload.providerId, true);
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
            () => { void refreshProviderInfo(command.payload.providerId, true).catch(() => undefined); },
          );
          send(socket, { type: "terminal.created", requestId: command.requestId, terminalId });
          return;
        }
        case "project.create":
          store.createProject(command.payload.name, ensureDirectory(command.payload.path));
          break;
        case "project.select":
          store.selectProject(command.payload.projectId);
          break;
        case "project.remove":
          store.removeProject(command.payload.projectId);
          break;
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
              await createWorktree(repositoryPath, target, { branch, createBranch: true, startPoint: status.branch });
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
          store.updateConversation(conversationId, update);
          break;
        }
        case "conversation.archive":
          store.archiveConversation(command.payload.conversationId, true);
          break;
        case "conversation.unarchive":
          store.archiveConversation(command.payload.conversationId, false);
          break;
        case "conversation.delete": {
          const conversation = store.conversation(command.payload.conversationId);
          await deleteCheckpoints(store.projectPath(conversation.projectId), conversation.id).catch(() => undefined);
          if (conversation.worktreePath) {
            try {
              await removeWorktree(store.projectPath(conversation.projectId), conversation.worktreePath, false);
            } catch (error) {
              if (!(error instanceof GitError && error.code === "not-found")) throw error;
            }
          }
          store.deleteConversation(command.payload.conversationId);
          break;
        }
        case "message.send": {
          const conversation = store.conversation(command.payload.conversationId);
          if (providers.isRunning(conversation.id)) throw new RequestError("Wait for the current run to finish or stop it first.");
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
          if (conversation.title === "New thread") store.updateConversation(conversation.id, { title: command.payload.content.slice(0, 64) });
          send(socket, { type: "request.ok", requestId: command.requestId });
          broadcastSnapshot();
          if (enableProviders) {
            startAgent(conversation.id, command.payload.content, command.payload.attachments.map((attachment) => attachment.path));
          }
          return;
        }
        case "agent.stop":
          if (!providers.cancel(command.payload.conversationId)) throw new RequestError("This thread does not have an active run.");
          break;
        case "agent.approval.respond": {
          const pending = pendingApprovals.get(command.payload.requestId);
          if (!pending || pending.conversationId !== command.payload.conversationId) throw new RequestError("That approval request is no longer pending.");
          if (!providers.respondToApproval(command.payload.conversationId, command.payload.requestId, command.payload.decision)) {
            throw new RequestError("That approval request is no longer pending.");
          }
          break;
        }
        case "agent.input.respond": {
          const pending = pendingInputs.get(command.payload.requestId);
          if (!pending || pending.conversationId !== command.payload.conversationId) throw new RequestError("That question is no longer pending.");
          const expected = new Set(pending.questions.map(({ id }) => id));
          if (Object.keys(command.payload.answers).some((id) => !expected.has(id)) || [...expected].some((id) => !command.payload.answers[id]?.length)) {
            throw new RequestError("Answer every question before continuing.");
          }
          if (!providers.respondToInput(command.payload.conversationId, command.payload.requestId, command.payload.answers)) {
            throw new RequestError("That question is no longer pending.");
          }
          break;
        }
        case "settings.update":
          store.updateSettings(command.payload);
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
          send(socket, { type: "request.result", requestId: command.requestId, result: { kind: "git.diff", diff: { patch: diff.text, truncated: diff.truncated, files: changedFiles(status) } } });
          return;
        }
        case "git.branches": {
          const path = workspacePath(command.payload.projectId);
          const branches = await listBranches(path);
          send(socket, { type: "request.result", requestId: command.requestId, result: { kind: "git.branches", branches: [...branches.local, ...branches.remote].map((branch) => ({ name: branch.name, current: branch.current, remote: branch.kind === "remote", worktreePath: null })) } });
          return;
        }
        case "git.branch.create": {
          const result = await createBranch(workspacePath(command.payload.projectId), command.payload.name);
          send(socket, { type: "request.result", requestId: command.requestId, result: { kind: "git.action", message: `Created ${result.status.branch ?? command.payload.name}.` } });
          return;
        }
        case "git.branch.switch": {
          const result = await switchBranch(workspacePath(command.payload.projectId), command.payload.name);
          send(socket, { type: "request.result", requestId: command.requestId, result: { kind: "git.action", message: `Switched to ${result.status.branch ?? command.payload.name}.` } });
          return;
        }
        case "git.worktree.create": {
          const conversation = store.conversation(command.payload.conversationId);
          if (conversation.projectId !== command.payload.projectId) throw new RequestError("The thread does not belong to this project.");
          if (conversation.worktreePath) throw new RequestError("This thread already has a worktree.");
          const target = join(dataDirectory, "worktrees", conversation.id);
          mkdirSync(resolve(target, ".."), { recursive: true, mode: 0o700 });
          await createWorktree(store.projectPath(command.payload.projectId), target, { branch: command.payload.branch, createBranch: true, startPoint: command.payload.baseBranch });
          store.updateConversation(conversation.id, { worktreePath: target, branch: command.payload.branch });
          send(socket, { type: "request.result", requestId: command.requestId, result: { kind: "worktree.created", path: target, branch: command.payload.branch } });
          broadcastSnapshot();
          return;
        }
        case "git.pull":
          await pullRepository(workspacePath(command.payload.projectId, command.payload.conversationId));
          send(socket, { type: "request.result", requestId: command.requestId, result: { kind: "git.action", message: "Pulled the latest changes." } });
          return;
        case "git.commit": {
          const result = await commitChanges(workspacePath(command.payload.projectId, command.payload.conversationId), command.payload.message, command.payload.paths);
          send(socket, { type: "request.result", requestId: command.requestId, result: { kind: "git.action", message: `Committed ${result.commit.slice(0, 7)}.` } });
          return;
        }
        case "git.push":
          await pushCurrentBranch(workspacePath(command.payload.projectId, command.payload.conversationId));
          send(socket, { type: "request.result", requestId: command.requestId, result: { kind: "git.action", message: "Pushed the current branch." } });
          return;
        case "git.pr.open": {
          const url = await getPullRequestCreateUrl(workspacePath(command.payload.projectId, command.payload.conversationId));
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
          const terminalId = terminals.create(socket, cwd, command.payload.cols, command.payload.rows);
          terminals.input(socket, terminalId, `${actionCommand(scripts.packageManager, action.name)}\r`);
          send(socket, { type: "terminal.created", requestId: command.requestId, terminalId });
          return;
        }
        case "checkpoint.revert": {
          const checkpoint = store.checkpoint(command.payload.checkpointId);
          if (checkpoint.conversationId !== command.payload.conversationId) throw new RequestError("The checkpoint does not belong to this thread.");
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
      send(socket, { type: "request.ok", requestId: command.requestId });
      broadcastSnapshot();
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
    socket.on("close", () => { clients.delete(socket); terminals.disposeOwner(socket); });
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

class RequestError extends Error {}
