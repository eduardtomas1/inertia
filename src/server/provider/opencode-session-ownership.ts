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

/**
 * Tracks only descendants proven by OpenCode's session.created parent link.
 * Descendant events are liveness evidence, never parent transcript authority.
 */
export class OpenCodeSessionOwnership {
  private readonly sessions = new Set<string>();

  constructor(private readonly rootSessionId: string) {
    this.sessions.add(rootSessionId);
  }

  observe(event: Event): OpenCodeEventSessionScope {
    const eventSessionId = openCodeEventSessionId(event);
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
      }
    }
    if (eventSessionId === this.rootSessionId) return "root";
    return eventSessionId && this.sessions.has(eventSessionId)
      ? "descendant"
      : "unrelated";
  }
}
