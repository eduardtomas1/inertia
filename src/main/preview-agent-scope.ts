import {
  AGENT_BROWSER_INPUT_BUDGET_MS,
  AGENT_BROWSER_INSPECT_BUDGET_MS,
  AGENT_BROWSER_NAVIGATION_BUDGET_MS,
  type AgentBrowserCommand,
  type AgentBrowserResult,
} from "../shared/agent-browser.js";
import { sanitizeBrowserEvidenceText } from "../shared/browser-evidence.js";
import { AgentBrowserRefusal } from "./preview-agent-action.js";
import { failedAgentBrowserResult as failure } from "./preview-agent-result.js";
import type { PreviewTab } from "./preview-tab.js";

const AGENT_PAGE_REST_DELAY_MS = 2_000;
const WAIT_REPORT_RESERVE_MS = 5_000;

type PreviewContents = PreviewTab["view"]["webContents"];

export class AgentBrowserTimeout extends Error {}

const restTimers = new WeakMap<PreviewContents, ReturnType<typeof setTimeout>>();

export class AgentOperationScope {
  readonly signal: AbortSignal;
  inputSent = false;
  timedOut = false;
  readonly #deadlineAt: number;
  readonly #controller = new AbortController();
  readonly #timer: ReturnType<typeof setTimeout>;
  readonly #awake = new Set<PreviewContents>();
  readonly #caller: AbortSignal | undefined;
  readonly #onCallerAbort = (): void => this.#controller.abort();

  constructor(budgetMs: number, caller?: AbortSignal) {
    this.#deadlineAt = Date.now() + budgetMs;
    this.#caller = caller;
    this.signal = this.#controller.signal;
    this.#timer = setTimeout(() => {
      this.timedOut = true;
      this.#controller.abort();
    }, budgetMs);
    this.#timer.unref();
    if (caller?.aborted) this.#controller.abort();
    else caller?.addEventListener("abort", this.#onCallerAbort, { once: true });
  }

  remaining(): number {
    return Math.max(0, this.#deadlineAt - Date.now());
  }

  keepAwake(contents: PreviewContents): void {
    if (contents.isDestroyed() || this.#awake.has(contents)) return;
    this.#awake.add(contents);
    const pending = restTimers.get(contents);
    if (pending) clearTimeout(pending);
    restTimers.delete(contents);
    contents.setBackgroundThrottling(false);
  }

  dispose(): void {
    clearTimeout(this.#timer);
    this.#caller?.removeEventListener("abort", this.#onCallerAbort);
    for (const contents of this.#awake) {
      const timer = setTimeout(() => {
        if (restTimers.get(contents) !== timer) return;
        restTimers.delete(contents);
        if (!contents.isDestroyed()) contents.setBackgroundThrottling(true);
      }, AGENT_PAGE_REST_DELAY_MS);
      timer.unref();
      restTimers.set(contents, timer);
    }
    this.#awake.clear();
  }
}

export function agentOperationBudget(command: AgentBrowserCommand): number {
  switch (command.action) {
    case "navigate":
    case "tab-open":
      return AGENT_BROWSER_NAVIGATION_BUDGET_MS;
    case "click":
    case "type":
    case "press":
    case "scroll":
      return AGENT_BROWSER_INPUT_BUDGET_MS;
    case "wait":
      return command.timeoutMs + WAIT_REPORT_RESERVE_MS;
    default:
      return AGENT_BROWSER_INSPECT_BUDGET_MS;
  }
}

function outcomeAfterTimeout(scope: AgentOperationScope | undefined): string {
  return scope?.inputSent
    ? " Input may already have reached the page, so its effect is unknown: take a snapshot before repeating it."
    : " Nothing had been sent to the page yet, so it is safe to try again.";
}

function withReachedPage(
  result: AgentBrowserResult,
  scope: AgentOperationScope | undefined,
): AgentBrowserResult {
  return !result.ok && scope?.inputSent && result.reachedPage === undefined
    && ["cancelled", "timeout", "unavailable"].includes(result.code)
    ? { ...result, reachedPage: true }
    : result;
}

export function agentOperationFailure(
  error: unknown,
  scope: AgentOperationScope | undefined,
): AgentBrowserResult {
  if (error instanceof AgentBrowserRefusal) return error.result;
  if (error instanceof AgentBrowserTimeout) {
    return withReachedPage(failure("timeout", `${error.message}${outcomeAfterTimeout(scope)}`), scope);
  }
  if (error instanceof Error && error.message === "browser-action-cancelled") {
    return withReachedPage(scope?.timedOut
      ? failure("timeout", `The browser action ran out of time.${outcomeAfterTimeout(scope)}`)
      : failure("cancelled", "The browser action was cancelled."), scope);
  }
  return withReachedPage(failure(
    "unavailable",
    error instanceof Error
      ? sanitizeBrowserEvidenceText(error.message, "The Inertia Browser action failed.", 600).text
      : "The Inertia Browser action failed.",
  ), scope);
}

export function agentOperationDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("browser-action-cancelled"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    timer.unref();
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}
