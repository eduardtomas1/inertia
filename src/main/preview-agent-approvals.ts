import { randomUUID } from "node:crypto";
import type { AgentBrowserRequest } from "../shared/agent-browser-approval.js";
import type { AgentBrowserCommand, AgentBrowserRunIdentity } from "../shared/agent-browser.js";
import { sanitizeBrowserEvidenceText } from "../shared/browser-evidence.js";
import type { PreviewAgentTarget } from "./preview-agent-page.js";
import type { PreviewTab } from "./preview-tab.js";

interface ApprovalScope {
  activeTabId: string;
  tabs: ReadonlyMap<string, PreviewTab>;
}

interface PreparedAction {
  identity: AgentBrowserRunIdentity;
  command: AgentBrowserCommand;
  scope: ApprovalScope;
  tab: PreviewTab;
  activeTabId: string;
  documentSequence: number;
  url: string;
  target: PreviewAgentTarget | null;
  timer: ReturnType<typeof setTimeout>;
}

export type BrowserApprovalGuard = (target?: PreviewAgentTarget) => void;
interface ApprovedAction { command: AgentBrowserCommand; validate: BrowserApprovalGuard }

const EXPIRY_MS = 5 * 60_000;
const MAX_PREPARED_ACTIONS = 64;
const stale = () => new Error("The Browser page or control changed after inspection. Request a new approval.");

function safeLabel(value: string): string {
  return sanitizeBrowserEvidenceText(value, "page control", 300).text;
}

function actionDetail(command: AgentBrowserCommand, tab: PreviewTab, target: PreviewAgentTarget | null): string {
  // Page titles can echo arbitrary passwords. A stable tab number identifies
  // the inspected page without copying its untrusted title into an approval.
  const page = `Browser tab ${tab.pageNumber}`;
  const control = `${safeLabel(target?.role || "control")}: ${safeLabel(target?.label ?? "page control")}`;
  switch (command.action) {
    case "click": return `${page}\nClick ${control}`;
    case "type": {
      // The evidence sanitizer is deliberately bounded. Show an explicitly
      // labelled preview; never silently claim an excerpt is the complete text.
      const preview = target?.sensitive
        ? "[sensitive text hidden]"
        : sanitizeBrowserEvidenceText(command.text, "[sensitive text hidden]", 600).text;
      const extent = command.text.length > 600 ? `Preview of ${command.text.length} characters` : "Text";
      return `${page}\n${command.replace ? "Replace text in" : "Append text to"} ${control}\n${extent}: ${JSON.stringify(preview)}`;
    }
    case "navigate": return `${page}\nNavigate: ${sanitizeBrowserEvidenceText(command.url, "[private address hidden]", 600).text}`;
    case "press": return `${page}\nPress: ${command.key}`;
    case "scroll": return `${page}\nScroll ${command.deltaY > 0 ? "down" : "up"}: ${Math.abs(command.deltaY)} pixels`;
    case "tab-open": return `Open a browser tab${command.url ? `: ${sanitizeBrowserEvidenceText(command.url, "[private address hidden]", 600).text}` : ""}`;
    case "tab-close": return `${page}\nClose this tab`;
    case "tab-activate": return `${page}\nSwitch to this tab`;
    default: throw new Error("This Browser action does not need an approval.");
  }
}

function sameTarget(left: PreviewAgentTarget | null, right: PreviewAgentTarget | null): boolean {
  return left === null ? right === null : right !== null && right.found
    && left.label === right.label && left.role === right.role && left.sensitive === right.sensitive
    && left.editable === right.editable && !right.disabled && !right.blocked;
}

/** Bounded, expiring, one-use authority retained only in the main process. */
export class PreviewAgentApprovalRegistry {
  readonly #pending = new Map<string, PreparedAction>();

  async resolve(
    request: AgentBrowserRequest,
    identity: AgentBrowserRunIdentity | null,
    scope: ApprovalScope,
    inspect: (tab: PreviewTab, ref: string) => Promise<PreviewAgentTarget>,
    signal?: AbortSignal,
  ): Promise<AgentBrowserCommand | ApprovedAction | string> {
    if (request.action !== "prepare-approval" && request.action !== "perform-approved"
      && request.action !== "discard-approval") return request;
    if (!identity || signal?.aborted) throw stale();
    if (request.action === "prepare-approval") {
      if (this.#pending.size >= MAX_PREPARED_ACTIONS) throw new Error("Too many Browser approvals are pending.");
      const command = { ...request.command };
      const tab = scope.tabs.get(command.action === "tab-close" || command.action === "tab-activate"
        ? command.tabId : scope.activeTabId);
      if (!tab) throw stale();
      const activeTabId = scope.activeTabId;
      const documentSequence = tab.documentSequence;
      const url = tab.view.webContents.getURL();
      const target = command.action === "click" || command.action === "type"
        ? await inspect(tab, command.ref) : null;
      if (target && (!target.found || target.blocked || target.disabled
        || (command.action === "type" && !target.editable))) throw stale();
      if (signal?.aborted || scope.activeTabId !== activeTabId
        || scope.tabs.get(tab.id) !== tab || tab.documentSequence !== documentSequence
        || tab.view.webContents.isDestroyed() || tab.view.webContents.isLoadingMainFrame()
        || tab.view.webContents.getURL() !== url) throw stale();
      const detail = actionDetail(command, tab, target);
      // Other chat slots can finish inspection while this slot is awaiting it.
      if (this.#pending.size >= MAX_PREPARED_ACTIONS) throw new Error("Too many Browser approvals are pending.");
      const token = randomUUID();
      const timer = setTimeout(() => this.#pending.delete(token), EXPIRY_MS);
      timer.unref();
      this.#pending.set(token, { identity: { ...identity }, command, scope, tab,
        activeTabId, documentSequence, url, target, timer });
      return JSON.stringify({ token, detail });
    }
    const prepared = this.#pending.get(request.token);
    if (!prepared || prepared.scope !== scope
      || prepared.identity.conversationId !== identity.conversationId
      || prepared.identity.runId !== identity.runId
      || prepared.identity.turnId !== identity.turnId) throw stale();
    this.#pending.delete(request.token);
    clearTimeout(prepared.timer);
    if (request.action === "discard-approval") return JSON.stringify({ discarded: true });
    const { command, tab } = prepared;
    const current = () => !signal?.aborted && scope.activeTabId === prepared.activeTabId
      && scope.tabs.get(tab.id) === tab && tab.documentSequence === prepared.documentSequence
      && !tab.view.webContents.isDestroyed() && !tab.view.webContents.isLoadingMainFrame()
      && tab.view.webContents.getURL() === prepared.url;
    if (!current()) throw stale();
    const target = command.action === "click" || command.action === "type"
      ? await inspect(tab, command.ref) : null;
    if (!current() || !sameTarget(prepared.target, target)) throw stale();
    return { command, validate: (deliveredTarget) => {
      if (!current() || (deliveredTarget && !sameTarget(prepared.target, deliveredTarget))) throw stale();
    } };
  }
}
