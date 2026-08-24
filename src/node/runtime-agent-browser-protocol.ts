import {
  parseAgentBrowserCommand,
  parseAgentBrowserResult,
  type AgentBrowserCommand,
  type AgentBrowserResult,
  type AgentBrowserRunIdentity,
} from "../shared/agent-browser.js";

export interface RuntimeAgentBrowserResult {
  type: "runtime.agent-browser-result";
  requestId: string;
  result: AgentBrowserResult;
}

export type RuntimeAgentBrowserEvent =
  | {
      type: "runtime.agent-browser-request";
      requestId: string;
      identity: AgentBrowserRunIdentity;
      command: AgentBrowserCommand;
    }
  | {
      type: "runtime.agent-browser-cancel";
      requestId: string;
      identity: AgentBrowserRunIdentity;
    };

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseIdentity(value: unknown): AgentBrowserRunIdentity | null {
  if (
    !plainObject(value)
    || Object.keys(value).length !== 3
    || typeof value.conversationId !== "string"
    || !UUID_PATTERN.test(value.conversationId)
    || typeof value.runId !== "string"
    || !UUID_PATTERN.test(value.runId)
    || typeof value.turnId !== "string"
    || !UUID_PATTERN.test(value.turnId)
  ) return null;
  return {
    conversationId: value.conversationId,
    runId: value.runId,
    turnId: value.turnId,
  };
}

export function parseRuntimeAgentBrowserResult(
  value: unknown,
): RuntimeAgentBrowserResult | null {
  if (
    !plainObject(value)
    || value.type !== "runtime.agent-browser-result"
    || Object.keys(value).length !== 3
    || typeof value.requestId !== "string"
    || !UUID_PATTERN.test(value.requestId)
  ) return null;
  const result = parseAgentBrowserResult(value.result);
  return result
    ? { type: "runtime.agent-browser-result", requestId: value.requestId, result }
    : null;
}

export function parseRuntimeAgentBrowserEvent(
  value: unknown,
): RuntimeAgentBrowserEvent | null {
  if (
    !plainObject(value)
    || (
      value.type !== "runtime.agent-browser-request"
      && value.type !== "runtime.agent-browser-cancel"
    )
    || typeof value.requestId !== "string"
    || !UUID_PATTERN.test(value.requestId)
  ) return null;
  const identity = parseIdentity(value.identity);
  if (!identity) return null;
  if (value.type === "runtime.agent-browser-cancel") {
    return Object.keys(value).length === 3
      ? {
          type: "runtime.agent-browser-cancel",
          requestId: value.requestId,
          identity,
        }
      : null;
  }
  if (Object.keys(value).length !== 4) return null;
  const command = parseAgentBrowserCommand(value.command);
  return command
    ? {
        type: "runtime.agent-browser-request",
        requestId: value.requestId,
        identity,
        command,
      }
    : null;
}
