import type { ProviderRunFailure } from "../provider/contracts";
import { providerActivityDetailSections } from "../provider/activity-detail";
import { boundedText, objectValue, type JsonObject } from "./protocol";
import { codexFailureKind, codexUsageLimited } from "./app-server-status";
import { classifyCodexManagedError, redactCodexErrorHeaders } from "./managed-errors";
import type { TurnFailureKind } from "../../shared/turn-lifecycle";
import type { OrchestrationRunFailureCode } from "../../shared/orchestration-v2";
import type { CodexAppServerOptions, CodexAppServerResult } from "./types";

export const CODEX_RETRY_BUDGET_MS = 10 * 60 * 1_000;
export const CODEX_RETRY_BUDGET_EXCEEDED_MESSAGE =
  "Codex exceeded the retry time limit without making progress.";

interface CodexRetryBudgetState {
  startedAt: number;
  timer?: NodeJS.Timeout;
}

const retryBudgetByHost = new WeakMap<object, CodexRetryBudgetState>();

interface CodexErrorNotificationHost {
  options: CodexAppServerOptions & { retryBudgetMs?: number };
  setLastError: (message: string) => void;
  rememberFailure: (
    reason: ProviderRunFailure["reason"],
    message: string,
    technicalDetail?: string,
    usageLimited?: boolean,
    failureKind?: TurnFailureKind,
    code?: OrchestrationRunFailureCode,
  ) => void;
  finish?: (
    status: CodexAppServerResult["status"],
    exitCode: number | null,
    signal: NodeJS.Signals | null,
  ) => void;
}

export interface CodexErrorRetryBudgetOptions {
  now?: () => number;
  maxRetryDurationMs?: number;
}

function resolveCodexRetryBudgetMs(
  configured: number | undefined,
): number {
  if (
    typeof configured !== "number"
    || !Number.isFinite(configured)
    || configured < 1
  ) {
    return CODEX_RETRY_BUDGET_MS;
  }
  return Math.min(Math.floor(configured), CODEX_RETRY_BUDGET_MS);
}

/** Clears retry-duration tracking once the run makes substantive progress or settles. */
export function resetCodexRetryBudget(host: object): void {
  const state = retryBudgetByHost.get(host);
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  retryBudgetByHost.delete(host);
}

export function projectCodexErrorNotification(
  host: CodexErrorNotificationHost,
  params: JsonObject,
  budget?: CodexErrorRetryBudgetOptions,
): void {
  const error = objectValue(params.error);
  const message = boundedText(error?.message, 4_000) ?? "Codex reported an error.";
  const itemId = boundedText(params.itemId, 1_000);
  // T3 classifies the notification's whole error object: its code, message and additional details. A classified
  // error keeps only its code and safe summary (T3 stores no raw text); any other keeps its text without headers.
  const managed = classifyCodexManagedError(error);
  const shown = managed?.message ?? redactCodexErrorHeaders(message);
  const activity = {
    ...(itemId ? { activityId: itemId } : {}),
    detail: providerActivityDetailSections({ error: shown })!,
  };
  host.setLastError(shown);
  if (params.willRetry === true) {
    const now = budget?.now?.() ?? Date.now();
    const maxRetryDurationMs = resolveCodexRetryBudgetMs(
      budget?.maxRetryDurationMs ?? host.options.retryBudgetMs,
    );
    let state = retryBudgetByHost.get(host);
    if (!state) {
      state = { startedAt: now };
      if (host.finish && !budget?.now) {
        state.timer = setTimeout(() => {
          resetCodexRetryBudget(host);
          host.setLastError(CODEX_RETRY_BUDGET_EXCEEDED_MESSAGE);
          host.rememberFailure(
            "codex-error",
            CODEX_RETRY_BUDGET_EXCEEDED_MESSAGE,
            shown,
            codexUsageLimited(error?.codexErrorInfo),
            codexFailureKind(error?.codexErrorInfo),
            managed?.code,
          );
          host.options.onActivity?.("system", "failed", CODEX_RETRY_BUDGET_EXCEEDED_MESSAGE, activity);
          host.finish?.("failed", 1, null);
        }, maxRetryDurationMs);
        state.timer.unref();
      }
      retryBudgetByHost.set(host, state);
    }
    if (now - state.startedAt >= maxRetryDurationMs) {
      resetCodexRetryBudget(host);
      host.setLastError(CODEX_RETRY_BUDGET_EXCEEDED_MESSAGE);
      host.rememberFailure(
        "codex-error",
        CODEX_RETRY_BUDGET_EXCEEDED_MESSAGE,
        shown,
        codexUsageLimited(error?.codexErrorInfo),
        codexFailureKind(error?.codexErrorInfo),
        managed?.code,
      );
      host.options.onActivity?.("system", "failed", CODEX_RETRY_BUDGET_EXCEEDED_MESSAGE, activity);
      host.finish?.("failed", 1, null);
      return;
    }
    host.options.onStatus?.("retrying", "error/willRetry");
    host.options.onActivity?.("system", "info", "Codex is retrying after an error", activity);
    return;
  }
  resetCodexRetryBudget(host);
  host.rememberFailure(
    "codex-error",
    shown,
    managed ? `Codex error: ${managed.code}` : shown,
    codexUsageLimited(error?.codexErrorInfo),
    codexFailureKind(error?.codexErrorInfo),
    managed?.code,
  );
  host.options.onActivity?.("system", "failed", "Codex reported an error", activity);
}
