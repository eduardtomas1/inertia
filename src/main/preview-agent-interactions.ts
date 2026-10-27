import {
  MAX_AGENT_BROWSER_TEXT_BYTES,
  type AgentBrowserCommand,
  type AgentBrowserResult,
} from "../shared/agent-browser.js";
import type { BrowserEvidenceEntry } from "../shared/browser-evidence.js";
import { AgentBrowserRefusal, changedGeometry, stopForAbort } from "./preview-agent-action.js";
import type { BrowserApprovalGuard } from "./preview-agent-approvals.js";
import { hoverAgentPageRef } from "./preview-agent-input.js";
import { locateAgentPageRef, showAgentPageCursor, type PreviewAgentTarget } from "./preview-agent-page.js";
import { blankTabRefusal, OUTSIDE_VIEWPORT_MESSAGE, type AgentOperationSession, type PreviewAgentOperations } from "./preview-agent-operations.js";
import { boundedAgentStateText, failedAgentBrowserResult as failure, successfulAgentBrowserResult } from "./preview-agent-result.js";
import type { AgentOperationScope } from "./preview-agent-scope.js";
import { selectAgentPageOption, type AgentPageSelection } from "./preview-agent-select.js";
import { agentPageViewPoint } from "./preview-agent-viewport.js";

const MAX_LOG_ENTRIES = 100;
const MAX_FAILURE_MESSAGE_CHARS = 1_000;
const LISTED_OPTIONS_SUFFIX_RESERVE = 40;
const STALE_MESSAGE = "That page element is stale. Take a new inertia_browser_snapshot for current refs.";
const BLOCKED_MESSAGE = "That page element cannot be controlled by the Browser agent.";
const DISABLED_MESSAGE = "That page element is disabled.";

type Point = { x: number; y: number };
type HoverCommand = Extract<AgentBrowserCommand, { action: "hover" }>;
type SelectCommand = Extract<AgentBrowserCommand, { action: "select" }>;

function targetFailure(target: PreviewAgentTarget, missing: string): AgentBrowserResult | null {
  if (!target.found || target.x === undefined || target.y === undefined) return failure("not-found", missing);
  if (target.blocked) return failure("invalid", BLOCKED_MESSAGE);
  if (target.disabled) return failure("invalid", DISABLED_MESSAGE);
  return null;
}

function element(target: PreviewAgentTarget): { role: string; label: string } {
  return { role: target.role || "element", label: target.label || "page element" };
}

function stateResult<Session extends AgentOperationSession>(
  operations: PreviewAgentOperations<Session>,
  session: Session,
  detail: Record<string, unknown>,
): AgentBrowserResult {
  const state = operations.agentState(session);
  return successfulAgentBrowserResult(boundedAgentStateText(state, detail), state);
}

async function approachAgentPageRef<Session extends AgentOperationSession>(
  operations: PreviewAgentOperations<Session>,
  session: Session,
  ref: string,
  cursorLabel: string,
  changed: string,
  scope: AgentOperationScope,
  validate?: BrowserApprovalGuard,
): Promise<{ generation: number; target: PreviewAgentTarget & Point } | AgentBrowserResult> {
  const contents = operations.activeTab(session).view.webContents;
  await operations.prepareInput(contents, scope);
  const generation = session.boundsGeneration;
  const located = await operations.locateInView(contents, ref, scope);
  if (session.boundsGeneration !== generation) return changedGeometry();
  const locatedFailure = targetFailure(located, STALE_MESSAGE);
  if (locatedFailure) return locatedFailure;
  stopForAbort(scope.signal);
  await operations.rendererOperation(
    contents,
    () => showAgentPageCursor(contents, located.x!, located.y!, cursorLabel),
    { scope, phase: "page-cursor" },
  );
  if (session.boundsGeneration !== generation) return changedGeometry();
  const revalidated = await operations.rendererOperation(
    contents,
    () => locateAgentPageRef(contents, ref),
    { scope, phase: "element-lookup" },
  );
  if (session.boundsGeneration !== generation) return changedGeometry();
  const revalidatedFailure = targetFailure(revalidated, changed);
  if (revalidatedFailure) return revalidatedFailure;
  validate?.(revalidated);
  stopForAbort(scope.signal);
  return { generation, target: revalidated as PreviewAgentTarget & Point };
}

function deliveredTarget(
  session: AgentOperationSession,
  generation: number,
  target: PreviewAgentTarget,
  changed: string,
  validate?: BrowserApprovalGuard,
): PreviewAgentTarget & Point {
  if (session.boundsGeneration !== generation) throw new AgentBrowserRefusal(changedGeometry());
  const refusal = targetFailure(target, changed);
  if (refusal) throw new AgentBrowserRefusal(refusal);
  validate?.(target);
  return target as PreviewAgentTarget & Point;
}

export async function hoverAgentPageElement<Session extends AgentOperationSession>(
  operations: PreviewAgentOperations<Session>,
  session: Session,
  command: HoverCommand,
  scope: AgentOperationScope,
  validate?: BrowserApprovalGuard,
): Promise<AgentBrowserResult> {
  const contents = operations.activeTab(session).view.webContents;
  const blank = blankTabRefusal(contents, command);
  if (blank) return blank;
  const changed = "That page element changed before the hover. Take a new inertia_browser_snapshot for current refs.";
  const approached = await approachAgentPageRef(operations, session, command.ref, "Agent hover", changed, scope, validate);
  if (!("generation" in approached)) return approached;
  let target = approached.target;
  const map = await operations.pointMap(session, contents, scope);
  if (session.boundsGeneration !== approached.generation) return changedGeometry();
  if (!agentPageViewPoint(map, target.x, target.y)) return failure("not-found", OUTSIDE_VIEWPORT_MESSAGE);
  const deliveryRefusal = await operations.deliverInput(contents, async () => {
    scope.inputSent = true;
    const hovered = await operations.rendererOperation(
      contents,
      () => hoverAgentPageRef(contents, command.ref, target.x, target.y, scope.signal, map),
      { scope, phase: "page-hover" },
    );
    target = deliveredTarget(session, approached.generation, hovered, changed, validate);
    if (!agentPageViewPoint(map, target.x, target.y)) throw new AgentBrowserRefusal(failure("not-found", OUTSIDE_VIEWPORT_MESSAGE));
  }, scope);
  if (deliveryRefusal === "retargeted") {
    return failure("not-found", "That page element changed during the hover. Take a new inertia_browser_snapshot for current refs.");
  }
  if (deliveryRefusal) {
    return failure("invalid", "The hover could not be delivered because the page reported a target Inertia cannot inspect. Take a new snapshot and hover a listed control.");
  }
  operations.recordActivity(session, "hover", "Agent hovered a page element", { x: target.x, y: target.y });
  return stateResult(operations, session, { hovered: command.ref, element: element(target) });
}

function selectionFailure(selection: Exclude<AgentPageSelection, { outcome: "selected" }>): AgentBrowserResult {
  switch (selection.outcome) {
    case "not-found": {
      const prefix = "No option in that list matches. Its options include ";
      let listed = "";
      let count = 0;
      for (const option of selection.options) {
        const next = `${count > 0 ? ", " : ""}${JSON.stringify(option)}`;
        if (prefix.length + listed.length + next.length + LISTED_OPTIONS_SUFFIX_RESERVE > MAX_FAILURE_MESSAGE_CHARS) break;
        listed += next;
        count += 1;
      }
      const more = selection.total > count ? ` (${selection.total} options in total)` : "";
      return failure("not-found", count > 0
        ? `${prefix}${listed}${more}.`
        : selection.total > 0
          ? "No option in that list matches, and Inertia cannot list its options on this page."
          : "That list has no options to choose.");
    }
    case "stale":
      return failure("not-found", STALE_MESSAGE);
    case "not-select":
      return failure("invalid", "That page element is not a <select> list. Click custom menus open and choose an option with inertia_browser_click.");
    case "nested":
      return failure("invalid", "That list is inside a frame or shadow root that Inertia cannot inspect.");
    case "multiple":
      return failure("invalid", "That list allows several choices. Click its options with inertia_browser_click instead.");
    case "disabled":
      return failure("invalid", DISABLED_MESSAGE);
    case "option-disabled":
      return failure("invalid", "That option is disabled.");
    case "too-large":
      return failure("too-large", "That list has too many options for Inertia to search.");
    case "reverted":
      return failure("invalid", selection.label
        ? `The page did not keep that option. The list shows ${JSON.stringify(selection.label)}.`
        : "The page did not keep that option.");
  }
}

export async function selectAgentPageElement<Session extends AgentOperationSession>(
  operations: PreviewAgentOperations<Session>,
  session: Session,
  command: SelectCommand,
  scope: AgentOperationScope,
  validate?: BrowserApprovalGuard,
): Promise<AgentBrowserResult> {
  const contents = operations.activeTab(session).view.webContents;
  const blank = blankTabRefusal(contents, command);
  if (blank) return blank;
  const changed = "That list changed before an option was chosen. Take a new inertia_browser_snapshot for current refs.";
  const approached = await approachAgentPageRef(operations, session, command.ref, "Agent choosing", changed, scope, validate);
  if (!("generation" in approached)) return approached;
  let target = approached.target;
  let selection: AgentPageSelection = { outcome: "stale" };
  const deliveryRefusal = await operations.deliverInput(contents, async () => {
    const current = await operations.rendererOperation(
      contents,
      () => locateAgentPageRef(contents, command.ref),
      { scope, phase: "element-lookup" },
    );
    target = deliveredTarget(session, approached.generation, current, changed, validate);
    scope.inputSent = true;
    selection = await operations.rendererOperation(
      contents,
      () => selectAgentPageOption(contents, command.ref, command.value),
      { scope, phase: "option-select" },
    );
  }, scope);
  const chosen = selection as AgentPageSelection;
  if (chosen.outcome !== "selected") return selectionFailure(chosen);
  if (deliveryRefusal) {
    return failure("invalid", "The page reported a target Inertia cannot inspect while the option was chosen. Take a new snapshot to see the list's value.");
  }
  operations.recordActivity(session, "select", "Agent chose an option", { x: target.x, y: target.y });
  return stateResult(operations, session, {
    selected: command.ref,
    element: element(target),
    option: { value: chosen.value, label: chosen.label },
  });
}

function logEntry(entry: BrowserEvidenceEntry): Record<string, unknown> {
  return {
    kind: entry.kind,
    at: entry.occurredAt,
    tabId: entry.tabId,
    summary: entry.summary,
    ...(entry.detail === null ? {} : { detail: entry.detail }),
    ...(entry.occurrences > 1 ? { occurrences: entry.occurrences } : {}),
  };
}

export function agentPageLogs<Session extends AgentOperationSession>(
  operations: PreviewAgentOperations<Session>,
  session: Session,
): AgentBrowserResult {
  const ledger = session.evidence.snapshot();
  const entries = ledger.entries.slice(-MAX_LOG_ENTRIES).map(logEntry);
  const state = operations.agentState(session);
  const text = (count: number): string => boundedAgentStateText(state, {
    entries: entries.slice(entries.length - count),
    ...(ledger.omitted || count < ledger.entries.length ? { omitted: true } : {}),
  });
  const fits = (count: number): boolean => Buffer.byteLength(text(count), "utf8") <= MAX_AGENT_BROWSER_TEXT_BYTES;
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(middle)) low = middle;
    else high = middle - 1;
  }
  return successfulAgentBrowserResult(text(low), state);
}
