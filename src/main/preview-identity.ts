import type { AgentBrowserRunIdentity } from "../shared/agent-browser.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type PreviewOwner = "primary" | "secondary";

export function previewOwner(value: unknown): PreviewOwner {
  if (value !== "primary" && value !== "secondary") {
    throw new Error("Invalid preview owner");
  }
  return value;
}

export function previewContext(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error("Invalid preview context");
  }
  return value;
}

export function previewTabId(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new Error("Invalid preview tab");
  }
  return value;
}

export function agentBrowserIdentity(
  value: string | AgentBrowserRunIdentity,
): { contextId: string; identity: AgentBrowserRunIdentity | null } {
  if (typeof value === "string") {
    return { contextId: previewContext(value), identity: null };
  }
  if (!value || typeof value !== "object") {
    throw new Error("Invalid Browser run identity");
  }
  const conversationId = previewContext(value.conversationId);
  return {
    contextId: conversationId,
    identity: {
      conversationId,
      runId: previewContext(value.runId),
      turnId: previewContext(value.turnId),
    },
  };
}
