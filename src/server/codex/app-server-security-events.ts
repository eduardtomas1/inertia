import { boundedText, type JsonObject } from "./protocol";
import type { CodexAppServerOptions } from "./types";

export function projectCodexSecurityNotification(
  method: string,
  params: JsonObject,
  emit: NonNullable<CodexAppServerOptions["onActivity"]>,
): boolean {
  if (method === "windows/worldWritableWarning") {
    const samplePaths = Array.isArray(params.samplePaths)
      ? params.samplePaths.slice(0, 100).flatMap((value) =>
          boundedText(value, 2_000) ?? [])
      : [];
    const extraCount = typeof params.extraCount === "number"
      && Number.isSafeInteger(params.extraCount)
      && params.extraCount > 0
      ? params.extraCount
      : 0;
    const detail = [
      ...samplePaths,
      ...(extraCount > 0 ? [`…and ${extraCount} more paths`] : []),
      ...(params.failedScan === true
        ? ["Codex could not complete the writable-path scan."]
        : []),
    ].join("\n");
    emit(
      "system",
      "info",
      "Codex detected world-writable paths",
      detail ? { detail: boundedText(detail, 16_000)! } : undefined,
    );
    return true;
  }
  if (method !== "windowsSandbox/setupCompleted") return false;
  const success = params.success === true;
  const mode = boundedText(params.mode, 160);
  const error = boundedText(params.error, 8_000);
  emit(
    "system",
    success ? "completed" : "failed",
    success
      ? "Windows sandbox setup completed"
      : "Windows sandbox setup failed",
    mode || error
      ? {
          detail: [mode ? `Mode: ${mode}` : null, error]
            .filter((value): value is string => Boolean(value))
            .join("\n"),
        }
      : undefined,
  );
  return true;
}
