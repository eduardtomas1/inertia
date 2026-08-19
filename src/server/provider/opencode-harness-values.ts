import { extname } from "node:path";

import type { Agent } from "@opencode-ai/sdk/v2";

import type { AgentPlanStep } from "./interactions";

const MAX_EVENT_TEXT_CHARS = 1024 * 1024;

export function bounded(value: string): string {
  return value.slice(0, MAX_EVENT_TEXT_CHARS);
}

export function objectValue(value: unknown): Record<string, unknown> | undefined {
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

export function jsonSummary(value: unknown): string {
  try {
    return value === undefined ? "" : JSON.stringify(value);
  } catch {
    return "";
  }
}

export function errorMessage(error: Record<string, unknown>): string {
  return stringValue(objectValue(error.data)?.message)
    ?? stringValue(error.message)
    ?? stringValue(error.name)
    ?? "OpenCode reported an error.";
}

export function safeError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? bounded(error.message) : fallback;
}

export function serverDiagnostic(output: { toString(): string }): string {
  const value = output.toString().trim();
  return value
    ? bounded(`OpenCode server stopped: ${value}`)
    : "OpenCode server stopped unexpectedly.";
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
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".png": return "image/png";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    default: throw new Error(
      `OpenCode does not support the attached image type: ${extname(path) || "unknown"}.`,
    );
  }
}
