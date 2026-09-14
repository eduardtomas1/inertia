import { parseAgentBrowserCommand, type AgentBrowserCommand } from "./agent-browser.js";

/** Internal runtime/main requests; never advertised as provider tool arguments. */
export type AgentBrowserRequest = AgentBrowserCommand
  | { action: "prepare-approval"; command: AgentBrowserCommand }
  | { action: "perform-approved"; token: string }
  | { action: "discard-approval"; token: string };

export interface AgentBrowserApproval {
  token: string;
  detail: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function parseAgentBrowserRequest(value: unknown): AgentBrowserRequest | null {
  const command = parseAgentBrowserCommand(value);
  if (command) return command;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 2) return null;
  if (record.action === "prepare-approval") {
    const prepared = parseAgentBrowserCommand(record.command);
    return prepared ? { action: "prepare-approval", command: prepared } : null;
  }
  if ((record.action === "perform-approved" || record.action === "discard-approval")
    && typeof record.token === "string" && UUID.test(record.token)) {
    return { action: record.action, token: record.token };
  }
  return null;
}

export function parseAgentBrowserApproval(text: string): AgentBrowserApproval | null {
  if (text.length > 8_192) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    return Object.keys(record).length === 2
      && typeof record.token === "string" && UUID.test(record.token)
      && typeof record.detail === "string" && record.detail.length > 0
      && record.detail.length <= 6_000 && !record.detail.includes("\0")
      ? { token: record.token, detail: record.detail }
      : null;
  } catch { return null; }
}
