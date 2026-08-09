import type { RuntimeMutationEvent, ServerEvent } from "@shared/contracts";

export const UNREADABLE_RUNTIME_RESPONSE =
  "Inertia received an unreadable response from its local service.";

export type RuntimeCommandDelivery =
  | "not-sent"
  | "rejected"
  | "ambiguous";

export class RuntimeCommandError extends Error {
  constructor(
    message: string,
    readonly delivery: RuntimeCommandDelivery,
  ) {
    super(message);
    this.name = "RuntimeCommandError";
  }
}

export function runtimeCommandDelivery(
  error: unknown,
): RuntimeCommandDelivery | null {
  return error instanceof RuntimeCommandError ? error.delivery : null;
}

export interface PendingConnectionRequest {
  resolve: (event: ServerEvent) => void;
  reject: (error: Error) => void;
  timeout: number;
  timedOut?: boolean;
  authoritativePublicationReceived?: boolean;
  awaitsWorkspaceGitPublication?: boolean;
  timeoutDelivery: Exclude<RuntimeCommandDelivery, "not-sent">;
}

export type PendingConnectionSettlement =
  | "settled"
  | "late"
  | "late-awaiting-publication"
  | "late-published"
  | null;

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: UnknownRecord, key: string): boolean {
  return typeof value[key] === "string";
}

function nullableStringField(value: UnknownRecord, key: string): boolean {
  return value[key] === null || stringField(value, key);
}

function recordWithStrings(value: unknown, ...keys: string[]): value is UnknownRecord {
  return record(value) && keys.every((key) => stringField(value, key));
}

function recordArray(value: unknown, ...keys: string[]): boolean {
  return Array.isArray(value)
    && value.every((entry) => recordWithStrings(entry, ...keys));
}

function recordList(value: unknown, validate: (entry: UnknownRecord) => boolean): boolean {
  return Array.isArray(value) && value.every((entry) => record(entry) && validate(entry));
}

function syncCursor(value: unknown): boolean {
  return recordWithStrings(value, "runtimeGeneration")
    && (value.runtimeGeneration as string).length > 0
    && Number.isSafeInteger(value.latestSequence)
    && Number(value.latestSequence) >= 0;
}

function appSnapshot(value: unknown): boolean {
  return record(value)
    && recordArray(value.projects, "id")
    && recordArray(value.conversations, "id")
    && recordArray(value.runs, "id")
    && recordList(value.providers, (provider) =>
      record(provider.metadataState) && record(provider.metadataState.rateLimits))
    && record(value.settings)
    && nullableStringField(value, "activeProjectId")
    && nullableStringField(value, "activeConversationId")
    && (value.sync === undefined || syncCursor(value.sync));
}

type RequestResult = Extract<ServerEvent, { type: "request.result" }>["result"];
const REQUEST_RESULT_PAYLOADS = {
  "agent.skills": "skills",
  "agent.workflow": "workflow",
  "backend.default": "value",
  "backend.profile": "profile",
  "backend.profile.probe": "profile",
  "conversation.created": "conversationId",
  "conversation.detail": "conversationId",
  "duo.pending": "launchIds",
  "duo.prepared": "launchId",
  "duo.status": "launchId",
  "external.url": "url",
  "git.action": "message",
  "git.branches": "branches",
  "git.diff": "diff",
  "git.reversal": "operation",
  "git.reversal.plan": "plan",
  "git.status": "status",
  "git.turn.diff": "diff",
  "git.workspace.diff": "diff",
  "git.workspace.status": "status",
  "message.accepted": "conversationId",
  "project.actions": "actions",
  "project.created": "projectId",
  "provider.maintenance": "providers",
  "provider.maintenance.operation": "operation",
  "review.selection.answer": "answer",
  "review.summary": "summary",
  "workspace.entries": "entries",
  "workspace.file": "file",
  "worktree.created": "path",
} satisfies Record<RequestResult["kind"], string>;

function requestResult(value: unknown): value is RequestResult {
  if (!recordWithStrings(value, "kind")) return false;
  const kind = value.kind as RequestResult["kind"];
  const descriptor = REQUEST_RESULT_PAYLOADS[kind];
  if (!descriptor) return false;
  const payload = value[descriptor];
  if (kind === "message.accepted") {
    return ["conversationId", "turnId", "userMessageId"].every((field) => stringField(value, field))
      && (value.disposition === "new-turn" || value.disposition === "follow-up");
  }
  if (kind === "git.status") return record(payload) && Array.isArray(payload.files);
  if (kind === "git.workspace.status") return record(payload) && Array.isArray(payload.repositories);
  if (kind === "agent.workflow") return record(payload) && Array.isArray(payload.skills);
  if (kind === "duo.prepared" || kind === "duo.status") return typeof payload === "string" && Array.isArray(value.sides);
  return payload !== undefined;
}

const RUNTIME_MUTATION_PAYLOADS = {
  "snapshot.updated": "snapshot",
  "conversation.shell.updated": "conversation",
  "workspace.git.invalidated": "requestId",
  "conversation.detail.invalidated": "conversationId",
  "conversation.message.persisted": "message",
  "provider.maintenance.updated": "providers",
  "provider.maintenance.operation": "operation",
  "agent.started": "conversationId",
  "agent.text": "text",
  "agent.reasoning": "text",
  "agent.commentary.persisted": "message",
  "agent.usage": "usage",
  "agent.activity": "activity",
  "agent.subagent.updated": "trace",
  "agent.approval.requested": "request",
  "agent.approval.resolved": "requestId",
  "agent.input.requested": "request",
  "agent.input.resolved": "requestId",
  "agent.plan.updated": "plan",
  "agent.goal.updated": "goal",
  "agent.goal.cleared": "conversationId",
  "agent.completed": "conversationId",
  "agent.failed": "message",
} satisfies Record<RuntimeMutationEvent["type"], string>;

function runtimeMutationEvent(value: UnknownRecord): boolean {
  const descriptor = RUNTIME_MUTATION_PAYLOADS[value.type as RuntimeMutationEvent["type"]];
  if (!descriptor) return false;
  const payload = value[descriptor];
  if (value.type === "snapshot.updated") return appSnapshot(payload);
  if (value.type === "agent.plan.updated") {
    return recordWithStrings(payload, "conversationId", "runId")
      && nullableStringField(payload, "turnId")
      && Array.isArray(payload.steps);
  }
  return payload !== undefined;
}

function isServerEvent(value: unknown): value is ServerEvent {
  if (!record(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "server.welcome":
      return value.protocolVersion === 1
        && appSnapshot(value.snapshot)
        && (value.sync === undefined || syncCursor(value.sync));
    case "runtime.resumed":
      return value.protocolVersion === 1 && syncCursor(value.sync);
    case "runtime.sync.completed":
    case "runtime.cursor":
      return syncCursor(value.sync);
    case "runtime.event":
      return syncCursor(value.sync)
        && record(value.scope)
        && (value.scope.kind === "shell"
          || (value.scope.kind === "conversation-detail"
            && stringField(value.scope, "conversationId")))
        && record(value.event)
        && runtimeMutationEvent(value.event);
    case "request.ok":
      return stringField(value, "requestId");
    case "request.error":
      return stringField(value, "requestId") && stringField(value, "message");
    case "request.result":
      return stringField(value, "requestId")
        && requestResult(value.result);
    case "terminal.created":
      return stringField(value, "requestId")
        && stringField(value, "terminalId")
        && (value.providerResume === undefined
          || recordWithStrings(value.providerResume, "providerId", "sessionId"));
    case "terminal.output":
      return stringField(value, "terminalId") && stringField(value, "data");
    case "terminal.exit":
      return stringField(value, "terminalId") && Number.isInteger(value.exitCode);
    default:
      return runtimeMutationEvent(value);
  }
}

export function decodeServerEventMessage(data: unknown): ServerEvent {
  const received: unknown = JSON.parse(String(data));
  if (!isServerEvent(received)) throw new Error("Malformed server event");
  return received;
}

export function deliverDecodedServerEvent(
  data: unknown,
  onEvent: (event: ServerEvent) => void,
  onUnreadable: () => void,
): boolean {
  let event: ServerEvent;
  try {
    event = decodeServerEventMessage(data);
  } catch {
    onUnreadable();
    return false;
  }
  // Deliberately outside the decode catch: projection or subscriber failures
  // must never be relabelled as malformed transport data.
  onEvent(event);
  return true;
}

export function notifyConnectionListeners(
  event: ServerEvent,
  listeners: Iterable<(event: ServerEvent) => void>,
  onListenerError: (error: unknown) => void = console.error,
): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (error) {
      onListenerError(error);
    }
  }
}

export function settlePendingConnectionRequest(
  event: ServerEvent,
  pendingRequests: Map<string, PendingConnectionRequest>,
  clearPendingTimeout: (timeout: number) => void,
): PendingConnectionSettlement {
  if (
    event.type !== "request.error"
    && event.type !== "request.ok"
    && event.type !== "request.result"
    && event.type !== "terminal.created"
  ) {
    return null;
  }
  const pending = pendingRequests.get(event.requestId);
  if (!pending) return null;
  clearPendingTimeout(pending.timeout);
  pendingRequests.delete(event.requestId);
  if (pending.timedOut) {
    if (pending.authoritativePublicationReceived) return "late-published";
    if (pending.awaitsWorkspaceGitPublication) {
      return "late-awaiting-publication";
    }
    return "late";
  }
  if (event.type === "request.error") {
    pending.reject(new RuntimeCommandError(event.message, "rejected"));
  } else {
    pending.resolve(event);
  }
  return "settled";
}
