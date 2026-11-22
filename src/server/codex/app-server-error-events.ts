import type { ProviderRunFailure } from "../provider/contracts";
import { providerActivityDetailSections } from "../provider/activity-detail";
import { boundedText, objectValue, type JsonObject } from "./protocol";
import { codexFailureKind, codexUsageLimited } from "./app-server-status";
import { classifyCodexManagedError, redactCodexErrorHeaders } from "./managed-errors";
import type { TurnFailureKind } from "../../shared/turn-lifecycle";
import type { OrchestrationRunFailureCode } from "../../shared/orchestration-v2";
import type { CodexAppServerOptions } from "./types";

interface CodexErrorNotificationHost {
  options: CodexAppServerOptions;
  setLastError: (message: string) => void;
  rememberFailure: (
    reason: ProviderRunFailure["reason"],
    message: string,
    technicalDetail?: string,
    usageLimited?: boolean,
    failureKind?: TurnFailureKind,
    code?: OrchestrationRunFailureCode,
  ) => void;
}

export function projectCodexErrorNotification(host: CodexErrorNotificationHost, params: JsonObject): void {
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
    host.options.onStatus?.("retrying", "error/willRetry");
    host.options.onActivity?.("system", "info", "Codex is retrying after an error", activity);
    return;
  }
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
