import { createHash } from "node:crypto";

import type { Event } from "@opencode-ai/sdk/v2";

import {
  objectValue,
  openCodeEventSessionId,
  stringValue,
} from "./opencode-sdk-support";

const MAX_OWNED_SESSIONS = 256;
const MAX_SESSION_ID_CHARS = 512;
const MAX_ACTIVITY_EVENT_IDS = 8_192;

const ACTIVE_NEXT_EVENTS = new Set([
  "session.next.prompted",
  "session.next.prompt.admitted",
  "session.next.context.updated",
  "session.next.synthetic",
  "session.next.shell.started",
  "session.next.shell.ended",
  "session.next.step.started",
  "session.next.step.ended",
  "session.next.step.failed",
  "session.next.text.started",
  "session.next.text.delta",
  "session.next.text.ended",
  "session.next.reasoning.started",
  "session.next.reasoning.delta",
  "session.next.reasoning.ended",
  "session.next.tool.input.started",
  "session.next.tool.input.delta",
  "session.next.tool.input.ended",
  "session.next.tool.called",
  "session.next.tool.progress",
  "session.next.tool.success",
  "session.next.tool.failed",
  "session.next.retried",
  "session.next.compaction.started",
  "session.next.compaction.delta",
  "session.next.compaction.ended",
  "session.next.revert.staged",
  "session.next.revert.cleared",
  "session.next.revert.committed",
]);

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

function activeDescendantEvent(event: Event, sessionId: string): boolean {
  const properties = event.properties as Record<string, unknown>;
  if (ACTIVE_NEXT_EVENTS.has(event.type)) {
    return exactSession(properties.sessionID, sessionId)
      && typeof properties.timestamp === "number"
      && Number.isFinite(properties.timestamp);
  }
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
  const eventId = safeSessionId((event as { id?: unknown }).id);
  if (eventId) return `id:${eventId}`;
  try {
    return `hash:${createHash("sha256")
      .update(JSON.stringify(event))
      .digest("base64url")}`;
  } catch {
    return undefined;
  }
}

/**
 * Tracks only descendants proven by OpenCode's session.created parent link.
 * Descendant events are liveness evidence, never parent transcript authority.
 */
export class OpenCodeSessionOwnership {
  private readonly sessions = new Set<string>();
  private readonly activityEventIds = new Set<string>();

  constructor(private readonly rootSessionId: string) {
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
    if (!eventKey) return { scope, active };
    if (this.activityEventIds.has(eventKey)) return { scope, active: false };
    this.activityEventIds.add(eventKey);
    if (this.activityEventIds.size > MAX_ACTIVITY_EVENT_IDS) {
      const oldest = this.activityEventIds.values().next().value;
      if (oldest) this.activityEventIds.delete(oldest);
    }
    return { scope, active };
  }
}
