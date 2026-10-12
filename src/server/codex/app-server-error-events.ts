import type { ProviderRunFailure } from "../provider/contracts";
import { providerActivityDetailSections } from "../provider/activity-detail";
import { boundedText, objectValue, type JsonObject } from "./protocol";
import { codexUsageLimited } from "./app-server-status";
import type { CodexAppServerOptions } from "./types";

interface CodexErrorNotificationHost {
  options: CodexAppServerOptions;
  setLastError: (message: string) => void;
  rememberFailure: (
    reason: ProviderRunFailure["reason"],
    message: string,
    technicalDetail?: string,
    usageLimited?: boolean,
  ) => void;
}

export function projectCodexErrorNotification(host: CodexErrorNotificationHost, params: JsonObject): void {
  const error = objectValue(params.error);
  const message = boundedText(error?.message, 4_000) ?? "Codex reported an error.";
  const itemId = boundedText(params.itemId, 1_000);
  const activity = {
    ...(itemId ? { activityId: itemId } : {}),
    detail: providerActivityDetailSections({ error: message })!,
  };
  host.setLastError(message);
  if (params.willRetry === true) {
    host.options.onStatus?.("retrying", "error/willRetry");
    host.options.onActivity?.("system", "info", "Codex is retrying after an error", activity);
    return;
  }
  host.rememberFailure("codex-error", message, message, codexUsageLimited(error?.codexErrorInfo));
  host.options.onActivity?.("system", "failed", "Codex reported an error", activity);
}
