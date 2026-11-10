import { parseRuntimeAgentBrowserEvent, parseRuntimeAgentBrowserResult, type RuntimeAgentBrowserEvent, type RuntimeAgentBrowserResult } from "./runtime-agent-browser-protocol";
import { parseRuntimeAgentSecretCommand, parseRuntimeAgentSecretEvent, type RuntimeAgentSecretCommand, type RuntimeAgentSecretEvent } from "./runtime-agent-secret-protocol";
import { parseRuntimeHtmlRenderEvent, parseRuntimeHtmlRenderReadCommand, type RuntimeHtmlRenderEvent, type RuntimeHtmlRenderReadCommand } from "./runtime-html-render-protocol";
import { parseRuntimeIssueEvidenceRequest, parseRuntimeIssueEvidenceResult, type RuntimeIssueEvidenceRequest, type RuntimeIssueEvidenceResult } from "./runtime-issue-evidence-protocol";

export type RuntimeFeatureWorkerCommand =
  | RuntimeAgentBrowserResult
  | RuntimeIssueEvidenceResult
  | RuntimeHtmlRenderReadCommand
  | RuntimeAgentSecretCommand;

export type RuntimeFeatureWorkerEvent =
  | RuntimeAgentBrowserEvent
  | RuntimeIssueEvidenceRequest
  | RuntimeHtmlRenderEvent
  | RuntimeAgentSecretEvent;

export function parseRuntimeFeatureWorkerCommand(value: { type?: unknown }): RuntimeFeatureWorkerCommand | null {
  const browserResult = parseRuntimeAgentBrowserResult(value);
  if (browserResult) return browserResult;
  if (value.type === "runtime.issue-evidence-result") return parseRuntimeIssueEvidenceResult(value);
  if (value.type === "runtime.read-html-render") return parseRuntimeHtmlRenderReadCommand(value);
  if (value.type === "runtime.agent-secret-deliver" || value.type === "runtime.agent-secret-reconcile") return parseRuntimeAgentSecretCommand(value);
  return null;
}

export function parseRuntimeFeatureWorkerEvent(value: { type?: unknown }): RuntimeFeatureWorkerEvent | null {
  const browserEvent = parseRuntimeAgentBrowserEvent(value);
  if (browserEvent) return browserEvent;
  if (value.type === "runtime.issue-evidence-request") return parseRuntimeIssueEvidenceRequest(value);
  return parseRuntimeHtmlRenderEvent(value) ?? parseRuntimeAgentSecretEvent(value);
}
