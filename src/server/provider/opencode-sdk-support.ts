import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { extname } from "node:path";

import type {
  Agent,
  Event,
  Model,
  PermissionRuleset,
  Provider,
} from "@opencode-ai/sdk/v2";

import type { AgentPlanStep } from "./interactions";
import type { ProviderRunFailure } from "./contracts";
import {
  sanitizeProviderActivityDetail,
  sanitizeProviderFailureSummary,
} from "./activity-detail";
import { isSafeApprovalDisplayText } from "./approval-display";
import { CappedProviderBuffer } from "./io";

const MAX_EVENT_TEXT_CHARS = 1024 * 1024;

export function openCodeApprovalDisplay(
  properties: Record<string, unknown>,
  permission = stringValue(properties.permission)
    ?? stringValue(properties.action)
    ?? "tool",
): { detail: string; resources: string[]; title: string } | null {
  const patterns = Array.isArray(properties.patterns)
    ? properties.patterns.filter((value): value is string =>
        typeof value === "string")
    : [];
  const resources = Array.isArray(properties.resources)
    ? properties.resources.filter((value): value is string =>
        typeof value === "string")
    : [];
  const title = `OpenCode wants to use ${permission}`;
  const detail = [...patterns, ...resources].join("\n")
    || jsonSummary(properties.metadata);
  return isSafeApprovalDisplayText(title)
      && isSafeApprovalDisplayText(detail, true)
      && resources.every((path) => isSafeApprovalDisplayText(path))
    ? { detail, resources, title }
    : null;
}

export function resolveOpenCodeModel(
  selection: string | undefined,
  providers: Provider[],
  connectedProviderIds: readonly string[],
): Model | undefined {
  if (!selection) return undefined;
  const slash = selection.indexOf("/");
  if (slash <= 0 || slash === selection.length - 1) {
    throw new Error(
      `OpenCode model '${selection}' must come from its native provider/model catalog.`,
    );
  }
  const providerId = selection.slice(0, slash);
  const modelId = selection.slice(slash + 1);
  if (!connectedProviderIds.includes(providerId)) {
    throw new Error(
      `OpenCode does not advertise the selected model '${selection}' from a connected provider.`,
    );
  }
  const model = findOpenCodeModel(providerId, modelId, providers);
  if (!model) {
    throw new Error(
      `OpenCode does not advertise the selected model '${selection}'.`,
    );
  }
  return model;
}

export function findOpenCodeModel(
  providerId: string,
  modelId: string,
  providers: Provider[],
): Model | undefined {
  return providers.find((provider) => provider.id === providerId)
    ?.models[modelId];
}

export function resolveOpenCodeAgent(
  mode: "build" | "plan",
  agents: Agent[],
): Agent | undefined {
  if (mode === "build") return undefined;
  const agent = agents.find((candidate) =>
    candidate.name === "plan" && candidate.mode !== "subagent");
  if (!agent) throw new Error("OpenCode does not advertise its native plan agent.");
  return agent;
}

export function openCodePermissions(
  access: "full" | "supervised" | "auto-edit",
): PermissionRuleset {
  if (access === "full") {
    return [{ permission: "*", pattern: "*", action: "allow" }];
  }
  return [
    { permission: "*", pattern: "*", action: "ask" },
    ...(access === "auto-edit"
      ? [{ permission: "edit", pattern: "*", action: "allow" } as const]
      : []),
    { permission: "question", pattern: "*", action: "allow" },
  ];
}

export function todoStep(value: unknown): AgentPlanStep[] {
  const todo = objectValue(value);
  const content = stringValue(todo?.content);
  if (!content) return [];
  const status = todo?.status === "completed"
    ? "completed"
    : todo?.status === "in_progress" ? "inProgress" : "pending";
  return [{ step: bounded(content), status }];
}

export function imageMime(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      throw new Error(
        `OpenCode does not support the attached image type: ${extname(path) || "unknown"}.`,
      );
  }
}

export function openCodeEventSessionId(event: Event): string | undefined {
  const properties = event.properties as Record<string, unknown>;
  const info = objectValue(properties.info);
  const part = objectValue(properties.part);
  return stringValue(properties.sessionID)
    ?? stringValue(info?.sessionID)
    ?? stringValue(part?.sessionID)
    ?? (event.type === "session.created"
      || event.type === "session.updated"
      || event.type === "session.deleted"
      ? stringValue(info?.id)
      : undefined);
}

export function isOpenCodeIdleEvent(event: Event): boolean {
  if (event.type === "session.idle") return true;
  if (event.type !== "session.status") return false;
  return objectValue(
    (event.properties as Record<string, unknown>).status,
  )?.type === "idle";
}

export function bounded(value: string): string {
  return value.slice(0, MAX_EVENT_TEXT_CHARS);
}

export function objectValue(
  value: unknown,
): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

export function errorMessage(error: Record<string, unknown>): string {
  const data = objectValue(error.data);
  const reported = stringValue(data?.message) ?? stringValue(error.message);
  switch (error.name) {
    case "MessageOutputLengthError":
      return reported ?? "OpenCode reached the model's maximum output length.";
    case "MessageAbortedError":
      return reported ?? "OpenCode's model response was aborted.";
    case "StructuredOutputError":
      return reported
        ?? "OpenCode could not produce the requested structured output.";
    case "ContextOverflowError":
      return reported ?? "OpenCode exceeded the model's context window.";
    case "ContentFilterError":
      return reported
        ?? "OpenCode's model blocked the response with its content filter.";
    default:
      return reported ?? stringValue(error.name) ?? stringValue(error.type)
        ?? "OpenCode reported an error.";
  }
}

export function openCodeProviderFailure(
  error: Record<string, unknown> | undefined,
  terminalEvent: string,
  activityId?: string,
  fallback = "OpenCode reported an error.",
  workspaceRoot?: string,
): ProviderRunFailure {
  const message = sanitizeProviderFailureSummary(
    error ? errorMessage(error) : fallback,
    fallback,
    { workspaceRoot },
  );
  const technicalDetail = sanitizeProviderActivityDetail(
    errorTechnicalDetail(error),
    { workspaceRoot, maxChars: 16 * 1024 },
  ) ?? undefined;
  return {
    reason: "provider-error",
    message,
    phase: "turn",
    terminalEvent,
    ...(activityId ? { activityId } : {}),
    ...(technicalDetail ? { technicalDetail } : {}),
  };
}

export function openCodeRuntimeFailure(
  rawError: string,
  message: string,
  terminalEvent: string,
  child?: ChildProcessWithoutNullStreams,
  workspaceRoot?: string,
): ProviderRunFailure {
  const normalized = rawError.toLowerCase();
  const reason: ProviderRunFailure["reason"] =
    /oversized|bounded event rate|bounded [^.]*budget/u.test(normalized)
      ? "protocol-overflow"
      : /changed a retained|accounting became inconsistent|malformed|unserializable/u
          .test(normalized)
        ? "malformed-protocol"
        : /closed (?:its )?event stream/u.test(normalized)
          ? "transport-closed"
          : /timed out|deadline|became inactive|maximum run duration/u
              .test(normalized)
            ? "rpc-timeout"
            : child?.signalCode
              ? "process-signal"
              : child?.exitCode !== null && child?.exitCode !== undefined
                ? "process-exit"
                : "provider-error";
  const safeMessage = sanitizeProviderFailureSummary(
    message,
    "OpenCode stopped unexpectedly.",
    { workspaceRoot },
  );
  const technicalDetail = sanitizeProviderActivityDetail(rawError, {
    workspaceRoot,
    maxChars: 16 * 1024,
  });
  return {
    reason,
    message: safeMessage,
    phase: "runtime",
    terminalEvent,
    ...(technicalDetail && technicalDetail !== safeMessage
      ? { technicalDetail }
      : {}),
  };
}

export function activityIdentity(
  value: unknown,
): { activityId: string } | Record<string, never> {
  const activityId = stringValue(value);
  return activityId ? { activityId } : {};
}

export function safeError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message
    ? bounded(error.message)
    : fallback;
}

export function serverDiagnostic(output: CappedProviderBuffer): string {
  const value = output.toString().trim();
  return value
    ? bounded(`OpenCode server stopped: ${value}`)
    : "OpenCode server stopped unexpectedly.";
}

function jsonSummary(value: unknown): string {
  try {
    return value === undefined ? "" : JSON.stringify(value);
  } catch {
    return "";
  }
}

function errorTechnicalDetail(
  error: Record<string, unknown> | undefined,
): string | undefined {
  if (!error) return undefined;
  const data = objectValue(error.data);
  const values = [
    ["Type", stringValue(error.name) ?? stringValue(error.type)],
    ["Provider", stringValue(data?.providerID)],
    ["Status", finite(data?.statusCode) ?? finite(error.statusCode)],
    ["Retryable", typeof data?.isRetryable === "boolean"
      ? data.isRetryable
      : typeof error.isRetryable === "boolean"
        ? error.isRetryable
        : undefined],
    ["Retries", finite(data?.retries)],
    ["Reference", stringValue(data?.ref) ?? stringValue(error.ref)],
  ] as const;
  const detail = values.flatMap(([label, value]) =>
    value === undefined || value === null
      ? []
      : [`${label}: ${String(value)}`]).join("\n");
  return detail ? bounded(detail) : undefined;
}
