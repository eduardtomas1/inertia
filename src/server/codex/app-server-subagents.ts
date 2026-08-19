import {
  boundedText,
  CappedTextBuffer,
  objectValue,
  stringValue,
  type JsonObject,
} from "./protocol";
import type { CodexAppServerOptions } from "./types";

export type CodexSubagentUpdate = Parameters<
  NonNullable<CodexAppServerOptions["onSubagent"]>
>[0];

export type CodexSubagentAuthority = "activity" | "state" | "turn";

export interface CodexSubagentProjection {
  status: CodexSubagentUpdate["status"];
  authority: CodexSubagentAuthority;
  isLive: boolean;
}

interface CodexSubagentLifecycleHost {
  rootThreadId: () => string | undefined;
  rootTurnId: () => string | undefined;
  emitSubagent: (
    update: Omit<CodexSubagentUpdate, "sequence" | "isLive">,
    authority: CodexSubagentAuthority,
    isLive?: boolean,
  ) => void;
  projection: (providerAgentId: string) =>
    CodexSubagentProjection | undefined;
  rejectMalformed: (message: string) => void;
}

interface CodexSpawnMetadata {
  providerName: string | null;
  description: string | null;
}

interface CodexThreadSpawnSource {
  parentThreadId: string;
  providerName: string | null;
  providerRole: string | null;
}

interface ProvisionalChildEvent {
  method:
    | "turn/started"
    | "turn/completed"
    | "thread/status/changed"
    | "error"
    | "thread/closed";
  params: JsonObject;
}

export interface CodexChildTurn {
  threadId: string;
  turnId: string;
}

const MAX_CODEX_CHILD_THREADS = 128;
const MAX_CODEX_COLLAB_RECEIVERS = 128;
const MAX_CODEX_CHILD_TURN_HISTORY = 1_024;
const MAX_CODEX_PROVISIONAL_CHILD_THREADS = 128;
const MAX_CODEX_PROVISIONAL_EVENTS_PER_CHILD = 8;

const LIVE_SUBAGENT_STATUSES = new Set<CodexSubagentUpdate["status"]>([
  "queued",
  "spawned",
  "running",
  "waiting",
]);

const TERMINAL_SUBAGENT_STATUSES =
  new Set<CodexSubagentUpdate["status"]>([
    "completed",
    "failed",
    "cancelled",
    "interrupted",
    "unknown",
    "lost",
  ]);

export function strictCodexProviderIdentifier(
  value: unknown,
  maxChars = 1_000,
): string | null {
  if (typeof value !== "string" || value.includes("\0")) return null;
  const identifier = value.trim();
  return identifier
      && identifier === value
      && identifier.length <= maxChars
    ? identifier
    : null;
}

function agentPathName(value: unknown): string | null {
  const path = boundedText(value, 1_000);
  if (!path || path === "/" || path === "/root") return null;
  return boundedText(
    path.split("/").filter(Boolean).at(-1),
    200,
  ) ?? null;
}

function spawnDescription(value: unknown): string | null {
  const description = boundedText(value, 4_000);
  if (!description) return null;
  if (/^gAAAAA[A-Za-z0-9_-]+={0,2}$/u.test(description)) return null;
  return description;
}

function parseSpawnMetadata(item: JsonObject): {
  toolUseId: string;
  metadata: CodexSpawnMetadata;
} | null {
  if (
    stringValue(item.type) !== "function_call"
    || stringValue(item.name) !== "spawn_agent"
    || (
      item.namespace !== undefined
      && stringValue(item.namespace) !== "collaboration"
    )
  ) return null;
  const toolUseId = strictCodexProviderIdentifier(item.call_id);
  const rawArguments = boundedText(item.arguments, 16_000);
  if (!toolUseId || !rawArguments) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArguments);
  } catch {
    return null;
  }
  const args = objectValue(parsed);
  if (!args) return null;
  return {
    toolUseId,
    metadata: {
      providerName: boundedText(args.task_name, 200) ?? null,
      description: spawnDescription(args.message),
    },
  };
}

function parseThreadSpawnSource(
  thread: JsonObject,
): CodexThreadSpawnSource | null {
  const source = objectValue(thread.source);
  const subAgent = objectValue(source?.subAgent)
    ?? objectValue(source?.subagent);
  const spawn = objectValue(subAgent?.thread_spawn)
    ?? objectValue(subAgent?.threadSpawn);
  if (!spawn) return null;
  const parentThreadId = strictCodexProviderIdentifier(
    spawn.parent_thread_id ?? spawn.parentThreadId,
  );
  if (!parentThreadId) return null;
  const agentPath = boundedText(
    spawn.agent_path ?? spawn.agentPath,
    1_000,
  ) ?? null;
  return {
    parentThreadId,
    providerName:
      boundedText(spawn.agent_nickname ?? spawn.agentNickname, 200)
      ?? agentPathName(agentPath)
      ?? null,
    providerRole:
      boundedText(spawn.agent_role ?? spawn.agentRole, 200) ?? null,
  };
}

export class CodexSubagentLifecycle {
  private readonly childParents = new Map<string, string>();
  private readonly childResults = new Map<string, CappedTextBuffer>();
  private readonly childDeltaItems = new Set<string>();
  private readonly childActiveTurns = new Map<string, string>();
  private readonly completedChildTurns = new Set<string>();
  private readonly spawnMetadata = new Map<string, CodexSpawnMetadata>();
  private readonly subagentByToolUseId = new Map<string, string>();
  private readonly provisionalEvents = new Map<
    string,
    ProvisionalChildEvent[]
  >();
  private readonly provisionalActiveTurns = new Map<string, string>();
  private provisionalOverflowed = false;

  constructor(private readonly host: CodexSubagentLifecycleHost) {}

  dispose(): void {
    this.childParents.clear();
    this.childResults.clear();
    this.childDeltaItems.clear();
    this.childActiveTurns.clear();
    this.completedChildTurns.clear();
    this.spawnMetadata.clear();
    this.subagentByToolUseId.clear();
    this.provisionalEvents.clear();
    this.provisionalActiveTurns.clear();
    this.provisionalOverflowed = false;
  }

  isOwnedProviderThread(threadId: string): boolean {
    const rootThreadId = this.host.rootThreadId();
    if (!rootThreadId) return false;
    let currentThreadId: string | undefined = threadId;
    const visited = new Set<string>();
    while (currentThreadId) {
      if (currentThreadId === rootThreadId) return true;
      if (visited.has(currentThreadId)) return false;
      visited.add(currentThreadId);
      currentThreadId = this.childParents.get(currentThreadId);
    }
    return false;
  }

  isOwnedProviderTurn(threadId: string, turnId: string): boolean {
    if (threadId === this.host.rootThreadId()) {
      return turnId === this.host.rootTurnId();
    }
    return this.isOwnedProviderThread(threadId)
      && this.childActiveTurns.get(threadId) === turnId;
  }

  interruptibleTurns(): CodexChildTurn[] {
    // App Server is spawned per Inertia run, so even pre-registration turns
    // come from this run's isolated provider process. They are safe to stop,
    // but are never projected into the UI until an owned ancestry edge arrives.
    const turns = new Map<string, string>(this.provisionalActiveTurns);
    for (const [threadId, turnId] of this.childActiveTurns) {
      turns.set(threadId, turnId);
    }
    return [...turns].map(([threadId, turnId]) => ({ threadId, turnId }));
  }

  handleNotification(method: string, params: JsonObject): boolean {
    if (method === "rawResponseItem/completed") {
      this.handleRawResponseItem(params);
      return true;
    }
    if (method === "thread/started" && this.handleChildThread(params)) {
      return true;
    }

    const threadId = strictCodexProviderIdentifier(params.threadId);
    if (!threadId) return false;
    if (this.childParents.has(threadId)) {
      return this.handleChildNotification(method, params, threadId);
    }
    if (threadId === this.host.rootThreadId()) return false;
    return this.rememberProvisionalLifecycle(method, params, threadId);
  }

  handleItem(
    item: JsonObject,
    itemPhase: "started" | "completed",
    ownerThreadId: string | null,
  ): boolean {
    if (
      this.emitCollabAgentItem(item, itemPhase, ownerThreadId ?? "")
      || this.emitSubagentActivity(item, ownerThreadId)
    ) return true;
    return false;
  }

  private registerChild(
    childThreadId: string,
    parentThreadId: string,
  ): boolean {
    const rootThreadId = this.host.rootThreadId();
    if (
      !rootThreadId
      || childThreadId === rootThreadId
      || childThreadId === parentThreadId
      || !this.isOwnedProviderThread(parentThreadId)
    ) return false;

    const existingParent = this.childParents.get(childThreadId);
    if (existingParent) return existingParent === parentThreadId;
    if (this.childParents.size >= MAX_CODEX_CHILD_THREADS) {
      this.host.rejectMalformed(
        `Codex exceeded the ${MAX_CODEX_CHILD_THREADS}-child delegated-agent limit.`,
      );
      return false;
    }

    let ancestor: string | undefined = parentThreadId;
    const visited = new Set<string>();
    while (ancestor) {
      if (ancestor === childThreadId || visited.has(ancestor)) return false;
      if (ancestor === rootThreadId) break;
      visited.add(ancestor);
      ancestor = this.childParents.get(ancestor);
    }
    if (ancestor !== rootThreadId) return false;
    this.childParents.set(childThreadId, parentThreadId);
    return true;
  }

  private replayProvisionalLifecycle(threadId: string): void {
    const buffered = this.provisionalEvents.get(threadId);
    this.provisionalEvents.delete(threadId);
    this.provisionalActiveTurns.delete(threadId);
    if (!buffered) return;
    for (const event of buffered) {
      this.handleChildNotification(event.method, event.params, threadId);
    }
  }

  private rememberProvisionalLifecycle(
    method: string,
    params: JsonObject,
    threadId: string,
  ): boolean {
    const event = this.normalizedProvisionalEvent(method, params, threadId);
    if (!event) return false;
    let events = this.provisionalEvents.get(threadId);
    if (!events) {
      if (this.provisionalEvents.size >= MAX_CODEX_PROVISIONAL_CHILD_THREADS) {
        this.rejectProvisionalOverflow(
          `Codex exceeded the ${MAX_CODEX_PROVISIONAL_CHILD_THREADS}-thread provisional child limit.`,
        );
        return true;
      }
      events = [];
      this.provisionalEvents.set(threadId, events);
    }
    if (events.length >= MAX_CODEX_PROVISIONAL_EVENTS_PER_CHILD) {
      this.rejectProvisionalOverflow(
        `Codex exceeded the ${MAX_CODEX_PROVISIONAL_EVENTS_PER_CHILD}-event provisional child limit.`,
      );
      return true;
    }
    events.push(event);
    const turnId = strictCodexProviderIdentifier(
      objectValue(event.params.turn)?.id,
    );
    if (event.method === "turn/started" && turnId) {
      this.provisionalActiveTurns.set(threadId, turnId);
    } else if (
      event.method === "turn/completed"
      || event.method === "thread/closed"
      || (event.method === "error" && event.params.willRetry !== true)
      || (
        event.method === "thread/status/changed"
        && objectValue(event.params.status)?.type === "systemError"
      )
    ) {
      this.provisionalActiveTurns.delete(threadId);
    }
    return true;
  }

  private rejectProvisionalOverflow(message: string): void {
    if (this.provisionalOverflowed) return;
    this.provisionalOverflowed = true;
    this.host.rejectMalformed(message);
  }

  private normalizedProvisionalEvent(
    method: string,
    params: JsonObject,
    threadId: string,
  ): ProvisionalChildEvent | null {
    if (method === "turn/started" || method === "turn/completed") {
      const turn = objectValue(params.turn);
      const turnId = strictCodexProviderIdentifier(turn?.id);
      if (!turnId) return null;
      return {
        method,
        params: {
          threadId,
          turn: {
            id: turnId,
            status: boundedText(turn?.status, 200) ?? null,
            error: boundedText(objectValue(turn?.error)?.message, 16_000)
              ? {
                  message: boundedText(
                    objectValue(turn?.error)?.message,
                    16_000,
                  ),
                }
              : null,
          },
        },
      };
    }
    if (method === "thread/status/changed") {
      const status = objectValue(params.status);
      const type = boundedText(status?.type, 200);
      if (!type) return null;
      const activeFlags = Array.isArray(status?.activeFlags)
        ? status.activeFlags.filter((flag): flag is string =>
            flag === "waitingOnApproval" || flag === "waitingOnUserInput")
        : [];
      return { method, params: { threadId, status: { type, activeFlags } } };
    }
    if (method === "error") {
      return {
        method,
        params: {
          threadId,
          willRetry: params.willRetry === true,
          error: {
            message: boundedText(objectValue(params.error)?.message, 16_000)
              ?? "Codex reported an error for this delegated agent.",
          },
        },
      };
    }
    if (method === "thread/closed") {
      return { method, params: { threadId } };
    }
    return null;
  }

  private collabStatus(
    providerStatus: string | null,
  ): CodexSubagentUpdate["status"] | null {
    if (providerStatus === "pendingInit") return "queued";
    if (providerStatus === "running") return "running";
    if (providerStatus === "interrupted") return "interrupted";
    if (providerStatus === "completed") return "completed";
    if (providerStatus === "errored") return "failed";
    if (providerStatus === "notFound") return "lost";
    if (providerStatus === "shutdown") return "unknown";
    return providerStatus ? "unknown" : null;
  }

  private emitCollabAgentItem(
    item: JsonObject,
    itemPhase: "started" | "completed",
    ownerThreadId: string,
  ): boolean {
    if (stringValue(item.type) !== "collabAgentToolCall") return false;
    const tool = stringValue(item.tool);
    if (
      tool !== "spawnAgent"
      && tool !== "sendInput"
      && tool !== "resumeAgent"
      && tool !== "wait"
      && tool !== "closeAgent"
    ) return true;
    const senderThreadId = strictCodexProviderIdentifier(item.senderThreadId);
    if (
      !senderThreadId
      || senderThreadId !== ownerThreadId
      || !this.isOwnedProviderThread(senderThreadId)
    ) {
      this.host.rejectMalformed(
        "A Codex collaboration item did not belong to its addressed provider thread.",
      );
      return true;
    }
    if (
      !Array.isArray(item.receiverThreadIds)
      || item.receiverThreadIds.length > MAX_CODEX_COLLAB_RECEIVERS
    ) {
      this.host.rejectMalformed(
        `A Codex collaboration item exceeded the ${MAX_CODEX_COLLAB_RECEIVERS}-receiver limit.`,
      );
      return true;
    }
    const receiverThreadIds: string[] = [];
    const uniqueReceivers = new Set<string>();
    for (const value of item.receiverThreadIds) {
      const id = strictCodexProviderIdentifier(value);
      if (!id) {
        this.host.rejectMalformed(
          "A Codex collaboration item contained an invalid receiver thread identifier.",
        );
        return true;
      }
      if (!uniqueReceivers.has(id)) {
        uniqueReceivers.add(id);
        receiverThreadIds.push(id);
      }
    }
    const toolUseId = strictCodexProviderIdentifier(item.id) ?? null;
    const prompt = boundedText(item.prompt, 4_000) ?? null;
    const agentsStates = objectValue(item.agentsStates) ?? {};
    for (const providerAgentId of receiverThreadIds) {
      const rootThreadId = this.host.rootThreadId();
      if (
        providerAgentId === rootThreadId
        || providerAgentId === senderThreadId
      ) continue;
      if (
        !this.childParents.has(providerAgentId)
        && !this.registerChild(providerAgentId, senderThreadId)
      ) continue;
      const agentState = objectValue(agentsStates[providerAgentId]);
      const providerStatus = boundedText(agentState?.status, 200) ?? null;
      const exactStatus = this.collabStatus(providerStatus);
      const fallbackStatus: CodexSubagentUpdate["status"] | null =
        tool === "spawnAgent"
          ? itemPhase === "started" ? "spawned" : "running"
          : tool === "wait"
            ? itemPhase === "started" ? "waiting" : "running"
            : tool === "closeAgent"
              ? null
              : "running";
      const status = exactStatus ?? fallbackStatus;
      if (!status) continue;
      const terminal = TERMINAL_SUBAGENT_STATUSES.has(status);
      const isLive = status === "unknown"
        ? providerStatus !== "shutdown"
        : LIVE_SUBAGENT_STATUSES.has(status);
      this.host.emitSubagent({
        providerTaskId: null,
        providerAgentId,
        parentProviderAgentId:
          this.childParents.get(providerAgentId) !== rootThreadId
            ? this.childParents.get(providerAgentId) ?? null
            : null,
        parentProviderToolUseId: null,
        providerToolUseId: toolUseId,
        providerRole: null,
        providerName: null,
        providerStatus,
        status,
        description: tool === "spawnAgent" ? prompt : null,
        progress: terminal
          ? null
          : boundedText(agentState?.message, 4_000) ?? null,
        result: terminal
          ? boundedText(agentState?.message, 16_000) ?? null
          : null,
      }, exactStatus ? "state" : "activity", isLive);
      this.replayProvisionalLifecycle(providerAgentId);
    }
    return true;
  }

  private emitSubagentActivity(
    item: JsonObject,
    ownerThreadId: string | null,
  ): boolean {
    if (stringValue(item.type) !== "subAgentActivity") return false;
    const providerAgentId = strictCodexProviderIdentifier(item.agentThreadId);
    const kind = stringValue(item.kind);
    if (!providerAgentId || !kind) return true;
    const rootThreadId = this.host.rootThreadId();
    const path = boundedText(item.agentPath, 1_000);
    if (
      providerAgentId === rootThreadId
      || path === "/root"
      || path === "/"
    ) return true;
    if (!ownerThreadId || !this.isOwnedProviderThread(ownerThreadId)) {
      return true;
    }
    if (
      !this.childParents.has(providerAgentId)
      && !this.registerChild(providerAgentId, ownerThreadId)
    ) return true;
    const parentProviderAgentId = this.childParents.get(providerAgentId)
      ?? null;
    const providerToolUseId = strictCodexProviderIdentifier(item.id) ?? null;
    if (providerToolUseId) {
      this.subagentByToolUseId.set(providerToolUseId, providerAgentId);
    }
    const metadata = providerToolUseId
      ? this.spawnMetadata.get(providerToolUseId)
      : undefined;
    this.host.emitSubagent({
      providerTaskId: null,
      providerAgentId,
      parentProviderAgentId:
        parentProviderAgentId === rootThreadId
          ? null
          : parentProviderAgentId,
      parentProviderToolUseId: null,
      providerToolUseId,
      providerRole: null,
      providerName: metadata?.providerName ?? agentPathName(path),
      providerStatus: kind,
      status: kind === "started" || kind === "interacted"
        ? "running"
        : kind === "interrupted"
          ? "interrupted"
          : "unknown",
      description: metadata?.description ?? null,
      progress: null,
      result: null,
    }, kind === "started" || kind === "interacted" ? "activity" : "state",
    kind !== "interrupted");
    this.replayProvisionalLifecycle(providerAgentId);
    return true;
  }

  private handleRawResponseItem(params: JsonObject): void {
    const ownerThreadId = strictCodexProviderIdentifier(params.threadId);
    if (!ownerThreadId || !this.isOwnedProviderThread(ownerThreadId)) return;
    const turnId = strictCodexProviderIdentifier(params.turnId);
    if (
      !turnId
      || (
        ownerThreadId === this.host.rootThreadId()
          ? turnId !== this.host.rootTurnId()
          : this.childActiveTurns.has(ownerThreadId)
            && turnId !== this.childActiveTurns.get(ownerThreadId)
      )
    ) return;
    const item = objectValue(params.item);
    if (!item) return;
    const parsed = parseSpawnMetadata(item);
    if (!parsed) return;
    if (
      !this.spawnMetadata.has(parsed.toolUseId)
      && this.spawnMetadata.size >= MAX_CODEX_CHILD_THREADS
    ) return;
    this.spawnMetadata.set(parsed.toolUseId, parsed.metadata);
    const providerAgentId = this.subagentByToolUseId.get(parsed.toolUseId);
    if (!providerAgentId) return;
    const projection = this.host.projection(providerAgentId);
    if (!projection) return;
    const parentProviderAgentId = this.childParents.get(providerAgentId)
      ?? null;
    this.host.emitSubagent({
      providerTaskId: null,
      providerAgentId,
      parentProviderAgentId:
        parentProviderAgentId === this.host.rootThreadId()
          ? null
          : parentProviderAgentId,
      parentProviderToolUseId: null,
      providerToolUseId: parsed.toolUseId,
      providerRole: null,
      providerName: parsed.metadata.providerName,
      providerStatus: null,
      status: projection.status,
      description: parsed.metadata.description,
      progress: null,
      result: null,
    }, projection.authority, projection.isLive);
  }

  private handleChildThread(params: JsonObject): boolean {
    const thread = objectValue(params.thread);
    if (!thread) return false;
    const childThreadId = strictCodexProviderIdentifier(thread.id);
    const directParentThreadId = strictCodexProviderIdentifier(
      thread.parentThreadId,
    );
    const spawn = parseThreadSpawnSource(thread);
    if (
      directParentThreadId
      && spawn?.parentThreadId
      && directParentThreadId !== spawn.parentThreadId
    ) {
      this.host.rejectMalformed(
        "A Codex child thread reported conflicting parent identities.",
      );
      return true;
    }
    const parentThreadId = directParentThreadId ?? spawn?.parentThreadId;
    if (!childThreadId || !parentThreadId) return false;
    if (!this.registerChild(childThreadId, parentThreadId)) return true;
    this.host.emitSubagent({
      providerTaskId: null,
      providerAgentId: childThreadId,
      parentProviderAgentId:
        parentThreadId === this.host.rootThreadId()
          ? null
          : parentThreadId,
      parentProviderToolUseId: null,
      providerToolUseId: null,
      providerRole:
        spawn?.providerRole ?? boundedText(thread.agentRole, 200) ?? null,
      providerName:
        spawn?.providerName
        ?? boundedText(thread.agentNickname, 200)
        ?? boundedText(thread.name, 200)
        ?? null,
      providerStatus: null,
      status: "running",
      description: boundedText(thread.preview, 4_000) ?? null,
      progress: null,
      result: null,
    }, "activity");
    this.replayProvisionalLifecycle(childThreadId);
    return true;
  }

  private emitChildLifecycle(
    threadId: string,
    status: CodexSubagentUpdate["status"],
    authority: CodexSubagentAuthority,
    options: {
      providerStatus?: string | null;
      progress?: string | null;
      result?: string | null;
      isLive?: boolean;
    } = {},
  ): void {
    this.host.emitSubagent({
      providerTaskId: null,
      providerAgentId: threadId,
      parentProviderAgentId:
        this.childParents.get(threadId) === this.host.rootThreadId()
          ? null
          : this.childParents.get(threadId) ?? null,
      parentProviderToolUseId: null,
      providerToolUseId: null,
      providerRole: null,
      providerName: null,
      providerStatus: options.providerStatus ?? null,
      status,
      description: null,
      progress: options.progress ?? null,
      result: options.result ?? null,
    }, authority, options.isLive ?? LIVE_SUBAGENT_STATUSES.has(status));
  }

  private handleChildNotification(
    method: string,
    params: JsonObject,
    threadId: string,
  ): boolean {
    if (method === "turn/started") {
      const turnId = strictCodexProviderIdentifier(objectValue(params.turn)?.id);
      if (!turnId) return true;
      const completionKey = `${threadId}\0${turnId}`;
      if (this.completedChildTurns.has(completionKey)) return true;
      const priorTurnId = this.childActiveTurns.get(threadId);
      if (priorTurnId && priorTurnId !== turnId) {
        this.childResults.delete(threadId);
      }
      this.childActiveTurns.set(threadId, turnId);
      this.emitChildLifecycle(threadId, "running", "turn", {
        providerStatus: boundedText(objectValue(params.turn)?.status, 200)
          ?? "inProgress",
      });
      return true;
    }
    if (method === "thread/status/changed") {
      const status = objectValue(params.status);
      const statusType = boundedText(status?.type, 200);
      if (statusType === "active") {
        const waiting = Array.isArray(status?.activeFlags)
          && status.activeFlags.some((flag) =>
            flag === "waitingOnApproval" || flag === "waitingOnUserInput");
        this.emitChildLifecycle(
          threadId,
          waiting ? "waiting" : "running",
          "state",
          { providerStatus: statusType },
        );
      } else if (statusType === "systemError") {
        this.childActiveTurns.delete(threadId);
        this.emitChildLifecycle(threadId, "failed", "turn", {
          providerStatus: statusType,
          result: "Codex reported a system error for this delegated agent.",
        });
      }
      return true;
    }
    if (method === "error") {
      if (params.willRetry === true) return true;
      const message = boundedText(objectValue(params.error)?.message, 16_000)
        ?? "Codex reported an error for this delegated agent.";
      this.childActiveTurns.delete(threadId);
      this.emitChildLifecycle(threadId, "failed", "turn", {
        providerStatus: "error",
        result: message,
      });
      return true;
    }
    if (method === "thread/closed") {
      this.childActiveTurns.delete(threadId);
      this.childResults.delete(threadId);
      this.emitChildLifecycle(threadId, "unknown", "turn", {
        providerStatus: "closed",
        isLive: false,
      });
      return true;
    }
    if (method === "thread/tokenUsage/updated") return true;
    if (method === "item/agentMessage/delta") {
      const delta = stringValue(params.delta);
      if (delta) {
        const itemId = boundedText(params.itemId, 1_000);
        if (itemId) this.childDeltaItems.add(itemId);
        const buffer =
          this.childResults.get(threadId) ?? new CappedTextBuffer(16_000);
        buffer.append(delta);
        this.childResults.set(threadId, buffer);
      }
      return true;
    }
    if (method === "item/started" || method === "item/completed") {
      const item = objectValue(params.item);
      if (!item) return true;
      if (this.handleItem(
        item,
        method === "item/started" ? "started" : "completed",
        threadId,
      )) return true;
      if (
        method === "item/completed"
        && stringValue(item.type) === "agentMessage"
      ) {
        const text = stringValue(item.text);
        const itemId = boundedText(item.id, 1_000);
        if (text && (!itemId || !this.childDeltaItems.has(itemId))) {
          const buffer =
            this.childResults.get(threadId) ?? new CappedTextBuffer(16_000);
          buffer.append(text);
          this.childResults.set(threadId, buffer);
          this.host.emitSubagent({
            providerTaskId: null,
            providerAgentId: threadId,
            parentProviderAgentId:
              this.childParents.get(threadId) === this.host.rootThreadId()
                ? null
                : this.childParents.get(threadId) ?? null,
            parentProviderToolUseId: null,
            providerToolUseId: itemId ?? null,
            providerRole: null,
            providerName: null,
            providerStatus: null,
            status: "running",
            description: null,
            progress: boundedText(text, 4_000) ?? null,
            result: null,
          }, "activity");
        }
      }
      return true;
    }
    if (method !== "turn/completed") return false;
    const turn = objectValue(params.turn);
    const turnId = strictCodexProviderIdentifier(turn?.id);
    if (!turnId) return true;
    const completionKey = `${threadId}\0${turnId}`;
    if (this.completedChildTurns.has(completionKey)) return true;
    const activeTurnId = this.childActiveTurns.get(threadId);
    if (activeTurnId && activeTurnId !== turnId) return true;
    if (this.completedChildTurns.size >= MAX_CODEX_CHILD_TURN_HISTORY) {
      const oldest = this.completedChildTurns.values().next().value;
      if (oldest) this.completedChildTurns.delete(oldest);
    }
    this.completedChildTurns.add(completionKey);
    this.childActiveTurns.delete(threadId);
    const status = stringValue(turn?.status);
    const failure = boundedText(objectValue(turn?.error)?.message, 16_000)
      ?? null;
    const output = boundedText(
      this.childResults.get(threadId)?.toString(),
      16_000,
    ) ?? null;
    const terminalStatus: CodexSubagentUpdate["status"] =
      status === "completed"
        ? "completed"
        : status === "failed"
          ? "failed"
          : status === "interrupted"
            ? "interrupted"
            : "unknown";
    this.emitChildLifecycle(threadId, terminalStatus, "turn", {
      providerStatus: boundedText(status, 200) ?? null,
      result: terminalStatus === "failed"
        ? failure ?? output
        : output ?? failure,
      isLive: false,
    });
    this.childResults.delete(threadId);
    return true;
  }
}
