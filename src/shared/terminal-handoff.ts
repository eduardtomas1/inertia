import { UUID_PATTERN } from "./request-identifiers";

export const MAX_PERSISTED_TERMINAL_TABS = 4;

export interface DetachedChatTerminalHandoff {
  conversationId: string;
  terminalIds: readonly string[];
  dock: boolean;
}

export function parseTerminalHandoffIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_PERSISTED_TERMINAL_TABS) return null;
  const terminalIds: string[] = [];
  for (const terminalId of value) {
    if (
      typeof terminalId !== "string"
      || !UUID_PATTERN.test(terminalId)
      || terminalIds.includes(terminalId)
    ) return null;
    terminalIds.push(terminalId);
  }
  return terminalIds;
}

export function parseDetachedChatTerminalHandoff(
  value: unknown,
): DetachedChatTerminalHandoff | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (
    keys.length !== 3
    || !keys.includes("conversationId")
    || !keys.includes("terminalIds")
    || !keys.includes("dock")
  ) return null;
  const { conversationId, terminalIds, dock } = value as Record<string, unknown>;
  if (
    typeof conversationId !== "string"
    || !UUID_PATTERN.test(conversationId)
    || typeof dock !== "boolean"
  ) return null;
  const parsed = parseTerminalHandoffIds(terminalIds);
  return parsed ? { conversationId, terminalIds: parsed, dock } : null;
}
