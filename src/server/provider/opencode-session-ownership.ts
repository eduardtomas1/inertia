import { createHash } from "node:crypto";

import type { Event } from "@opencode-ai/sdk/v2";

import {
  objectValue,
  openCodeEventSessionId,
  stringValue,
} from "./opencode-sdk-support";

const MAX_OWNED_SESSIONS = 256;
const MAX_SESSION_ID_CHARS = 512;

function safeSessionId(value: unknown): string | undefined {
  const candidate = stringValue(value);
  return candidate
    && candidate.length <= MAX_SESSION_ID_CHARS
    && !/[\u0000-\u001f\u007f]/u.test(candidate)
    ? candidate
    : undefined;
}

export type OpenCodeEventSessionScope =
  | "root"
  | "descendant"
  | "unrelated";

export interface OpenCodeSessionObservation {
  scope: OpenCodeEventSessionScope;
  active: boolean;
}

function exactSession(value: unknown, sessionId: string): boolean {
  return safeSessionId(value) === sessionId;
}

function safeFields(
  properties: Record<string, unknown>,
  ...fields: string[]
): boolean {
  return fields.every((field) => safeSessionId(properties[field]) !== undefined);
}

function validModelRef(value: unknown): boolean {
  const model = objectValue(value);
  return safeSessionId(model?.providerID) !== undefined
    && safeSessionId(model?.modelID) !== undefined;
}

function finiteNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

function validPrompt(value: unknown): boolean {
  const prompt = objectValue(value);
  return typeof prompt?.text === "string"
    && (prompt.files === undefined || Array.isArray(prompt.files))
    && (prompt.agents === undefined || Array.isArray(prompt.agents));
}

function validStepTokens(value: unknown): boolean {
  const tokens = objectValue(value);
  const cache = objectValue(tokens?.cache);
  return finiteNumber(tokens?.input)
    && finiteNumber(tokens?.output)
    && finiteNumber(tokens?.reasoning)
    && finiteNumber(cache?.read)
    && finiteNumber(cache?.write);
}

function validUnknownError(value: unknown): boolean {
  const error = objectValue(value);
  return error?.type === "unknown" && typeof error.message === "string";
}

function validRetryError(value: unknown): boolean {
  const error = objectValue(value);
  return typeof error?.message === "string"
    && typeof error.isRetryable === "boolean";
}

function validProviderExecution(value: unknown): boolean {
  return typeof objectValue(value)?.executed === "boolean";
}

function activeNextDescendantEvent(
  type: string,
  properties: Record<string, unknown>,
  sessionId: string,
): boolean | undefined {
  if (!type.startsWith("session.next.")) return undefined;
  if (
    !exactSession(properties.sessionID, sessionId)
    || typeof properties.timestamp !== "number"
    || !Number.isFinite(properties.timestamp)
  ) return false;
  switch (type) {
    case "session.next.agent.switched":
      return safeFields(properties, "messageID")
        && stringValue(properties.agent) !== undefined;
    case "session.next.model.switched":
      return safeFields(properties, "messageID")
        && validModelRef(properties.model);
    case "session.next.prompted":
    case "session.next.prompt.admitted":
      return safeFields(properties, "messageID")
        && validPrompt(properties.prompt)
        && (properties.delivery === "steer" || properties.delivery === "queue");
    case "session.next.context.updated":
    case "session.next.synthetic":
      return safeFields(properties, "messageID")
        && typeof properties.text === "string";
    case "session.next.shell.started":
      return safeFields(properties, "messageID", "callID")
        && stringValue(properties.command) !== undefined;
    case "session.next.shell.ended":
      return safeFields(properties, "callID")
        && typeof properties.output === "string";
    case "session.next.step.started":
      return safeFields(properties, "assistantMessageID")
        && stringValue(properties.agent) !== undefined
        && validModelRef(properties.model);
    case "session.next.step.ended":
      return safeFields(properties, "assistantMessageID")
        && typeof properties.finish === "string"
        && finiteNumber(properties.cost)
        && validStepTokens(properties.tokens);
    case "session.next.step.failed":
      return safeFields(properties, "assistantMessageID")
        && validUnknownError(properties.error);
    case "session.next.text.started":
      return safeFields(properties, "assistantMessageID", "textID");
    case "session.next.text.delta":
      return safeFields(properties, "assistantMessageID", "textID")
        && stringValue(properties.delta) !== undefined;
    case "session.next.text.ended":
      return safeFields(properties, "assistantMessageID", "textID")
        && typeof properties.text === "string";
    case "session.next.reasoning.started":
      return safeFields(properties, "assistantMessageID", "reasoningID");
    case "session.next.reasoning.delta":
      return safeFields(properties, "assistantMessageID", "reasoningID")
        && stringValue(properties.delta) !== undefined;
    case "session.next.reasoning.ended":
      return safeFields(properties, "assistantMessageID", "reasoningID")
        && typeof properties.text === "string";
    case "session.next.tool.input.started":
      return safeFields(properties, "assistantMessageID", "callID")
        && stringValue(properties.name) !== undefined;
    case "session.next.tool.input.delta":
      return safeFields(properties, "assistantMessageID", "callID")
        && stringValue(properties.delta) !== undefined;
    case "session.next.tool.input.ended":
      return safeFields(properties, "assistantMessageID", "callID")
        && typeof properties.text === "string";
    case "session.next.tool.called":
      return safeFields(properties, "assistantMessageID", "callID")
        && stringValue(properties.tool) !== undefined
        && objectValue(properties.input) !== undefined
        && validProviderExecution(properties.provider);
    case "session.next.tool.progress":
      return safeFields(properties, "assistantMessageID", "callID")
        && objectValue(properties.structured) !== undefined
        && Array.isArray(properties.content);
    case "session.next.tool.success":
      return safeFields(properties, "assistantMessageID", "callID")
        && objectValue(properties.structured) !== undefined
        && Array.isArray(properties.content)
        && validProviderExecution(properties.provider);
    case "session.next.tool.failed":
      return safeFields(properties, "assistantMessageID", "callID")
        && validUnknownError(properties.error)
        && validProviderExecution(properties.provider);
    case "session.next.retried":
      return finiteNumber(properties.attempt)
        && validRetryError(properties.error);
    case "session.next.compaction.started":
      return safeFields(properties, "messageID")
        && (properties.reason === "auto" || properties.reason === "manual");
    case "session.next.compaction.delta":
      return safeFields(properties, "messageID")
        && stringValue(properties.text) !== undefined;
    case "session.next.compaction.ended":
      return safeFields(properties, "messageID")
        && (properties.reason === "auto" || properties.reason === "manual")
        && typeof properties.text === "string"
        && typeof properties.recent === "string";
    default:
      return false;
  }
}

function activeDescendantEvent(event: Event, sessionId: string): boolean {
  const properties = event.properties as Record<string, unknown>;
  const nextActivity = activeNextDescendantEvent(
    event.type,
    properties,
    sessionId,
  );
  if (nextActivity !== undefined) return nextActivity;
  switch (event.type) {
    case "session.status": {
      const status = objectValue(properties.status);
      return status?.type === "busy" || status?.type === "retry";
    }
    case "message.updated": {
      const info = objectValue(properties.info);
      return exactSession(info?.sessionID, sessionId)
        && safeSessionId(info?.id) !== undefined
        && (info?.role === "assistant" || info?.role === "user");
    }
    case "message.part.updated": {
      const part = objectValue(properties.part);
      return exactSession(part?.sessionID, sessionId)
        && safeSessionId(part?.id) !== undefined
        && safeSessionId(part?.messageID) !== undefined
        && typeof part?.type === "string"
        && part.type.length > 0;
    }
    case "message.part.delta":
      return safeSessionId(properties.messageID) !== undefined
        && safeSessionId(properties.partID) !== undefined
        && typeof properties.field === "string"
        && properties.field.length > 0
        && typeof properties.delta === "string"
        && properties.delta.length > 0;
    case "message.removed":
      return safeSessionId(properties.messageID) !== undefined;
    case "message.part.removed":
      return safeSessionId(properties.messageID) !== undefined
        && safeSessionId(properties.partID) !== undefined;
    case "session.diff":
      return Array.isArray(properties.diff);
    case "todo.updated":
      return Array.isArray(properties.todos);
    case "permission.asked":
    case "permission.v2.asked":
    case "question.asked":
    case "question.v2.asked":
      return safeSessionId(properties.id) !== undefined;
    case "permission.replied":
    case "permission.v2.replied":
    case "question.replied":
    case "question.v2.replied":
    case "question.rejected":
    case "question.v2.rejected":
      return safeSessionId(
        properties.requestID ?? properties.permissionID ?? properties.id,
      ) !== undefined;
    default:
      return false;
  }
}

function activityEventKey(event: Event): string | undefined {
  try {
    const { id: _eventId, ...payload } = event as Event & { id?: unknown };
    return `hash:${createHash("sha256")
      .update(canonicalJson(payload))
      .digest("base64url")}`;
  } catch {
    return undefined;
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}

/**
 * Tracks only descendants proven by OpenCode's session.created parent link.
 * Descendant events are liveness evidence, never parent transcript authority.
 */
export class OpenCodeSessionOwnership {
  private readonly sessions = new Set<string>();
  private readonly activityEventKeys = new Set<string>();

  constructor(
    private readonly rootSessionId: string,
    private readonly maxActivityEventKeys: number,
  ) {
    if (
      !Number.isSafeInteger(maxActivityEventKeys)
      || maxActivityEventKeys < 1
    ) {
      throw new Error("The OpenCode activity-evidence budget is invalid.");
    }
    this.sessions.add(rootSessionId);
  }

  observe(event: Event): OpenCodeSessionObservation {
    const eventSessionId = openCodeEventSessionId(event);
    let added = false;
    if (event.type === "session.created") {
      const properties = event.properties as Record<string, unknown>;
      const info = objectValue(properties.info);
      const childId = safeSessionId(info?.id);
      const parentId = safeSessionId(info?.parentID);
      if (
        childId
        && eventSessionId === childId
        && parentId
        && childId !== this.rootSessionId
        && this.sessions.has(parentId)
        && !this.sessions.has(childId)
      ) {
        if (this.sessions.size >= MAX_OWNED_SESSIONS) {
          throw new Error(
            "OpenCode exceeded the bounded owned-session budget.",
          );
        }
        this.sessions.add(childId);
        added = true;
      }
    }
    const scope: OpenCodeEventSessionScope = eventSessionId === this.rootSessionId
      ? "root"
      : eventSessionId && this.sessions.has(eventSessionId)
        ? "descendant"
        : "unrelated";
    if (scope !== "descendant") return { scope, active: false };
    const active = added || activeDescendantEvent(event, eventSessionId!);
    const eventKey = active ? activityEventKey(event) : undefined;
    if (!eventKey) return { scope, active: false };
    if (this.activityEventKeys.has(eventKey)) return { scope, active: false };
    if (this.activityEventKeys.size >= this.maxActivityEventKeys) {
      return { scope, active: false };
    }
    this.activityEventKeys.add(eventKey);
    return { scope, active };
  }
}
