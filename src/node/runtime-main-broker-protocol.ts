import {
  parseRuntimeAgentBrowserEvent,
  parseRuntimeAgentBrowserResult,
  type RuntimeAgentBrowserEvent,
  type RuntimeAgentBrowserResult,
} from "./runtime-agent-browser-protocol";
import {
  parseRuntimeAppControlEvent,
  parseRuntimeAppControlResult,
  type RuntimeAppControlEvent,
  type RuntimeAppControlResult,
} from "./runtime-app-control-protocol";
import {
  parseRuntimeIssueEvidenceRequest,
  parseRuntimeIssueEvidenceResult,
  type RuntimeIssueEvidenceRequest,
  type RuntimeIssueEvidenceResult,
} from "./runtime-issue-evidence-protocol";

/**
 * Messages of the runtime brokers whose work the Electron main process
 * performs: the Browser, App control and issue evidence. Each parser below is
 * strict for its own message types and answers null for anything else, so
 * the runtime process protocol dispatches all three with one call each way.
 */

export type RuntimeMainBrokerResult = RuntimeAgentBrowserResult | RuntimeIssueEvidenceResult | RuntimeAppControlResult;
export type RuntimeMainBrokerEvent = RuntimeAgentBrowserEvent | RuntimeIssueEvidenceRequest | RuntimeAppControlEvent;

/** A main-to-runtime broker result, or null when `value` is not one (or is malformed). */
export function parseRuntimeMainBrokerResult(value: Record<string, unknown>): RuntimeMainBrokerResult | null {
  if (value.type === "runtime.app-control-result") return parseRuntimeAppControlResult(value);
  if (value.type === "runtime.issue-evidence-result") return parseRuntimeIssueEvidenceResult(value);
  return parseRuntimeAgentBrowserResult(value);
}

/** A runtime-to-main broker request or cancel, or null when `value` is not one (or is malformed). */
export function parseRuntimeMainBrokerEvent(value: Record<string, unknown>): RuntimeMainBrokerEvent | null {
  if (value.type === "runtime.app-control-request" || value.type === "runtime.app-control-cancel") {
    return parseRuntimeAppControlEvent(value);
  }
  if (value.type === "runtime.issue-evidence-request") return parseRuntimeIssueEvidenceRequest(value);
  return parseRuntimeAgentBrowserEvent(value);
}
