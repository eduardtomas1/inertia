import type { BrowserContext, Request, Response, TestInfo } from "@playwright/test";
import { captureBoundedFailureDiagnostic } from "../../helpers/bounded-failure-diagnostic";
import type { AppFixture } from "./app-fixture";

/** Fixed scalar observations for the private synthetic image fixture only. */
export function observeImagePreviewFailure(app: AppFixture): {
  afterRestart: () => Promise<void>;
  finish: (info: TestInfo, bodyFailed: boolean) => Promise<void>;
} {
  let context: BrowserContext = app.electronApp.context();
  let restarted = false;
  let tracing = false;
  const events: Record<string, unknown>[] = [];
  const knownErrors = new Set([
    "net::ERR_ABORTED", "net::ERR_FAILED", "net::ERR_FILE_NOT_FOUND",
    "net::ERR_CONNECTION_CLOSED", "net::ERR_INVALID_RESPONSE",
  ]);
  const isPreview = (request: Request): boolean =>
    /^inertia:\/\/bundle\/attachment-preview\/[0-9a-f-]{36}$/iu.test(request.url());
  function record(event: string, fields: Record<string, unknown> = {}): void {
    if (events.length === 64) events.shift();
    events.push({ phase: restarted ? "restarted" : "initial", event, ...fields });
  }
  const requested = (request: Request): void => { if (isPreview(request)) record("requested"); };
  const responded = (response: Response): void => {
    if (isPreview(response.request())) record("response", { status: response.status() });
  };
  const failed = (request: Request): void => {
    if (!isPreview(request)) return;
    const error = request.failure()?.errorText;
    record("failed", { code: error && knownErrors.has(error) ? error : "other" });
  };
  function observe(): void {
    context.on("request", requested);
    context.on("response", responded);
    context.on("requestfailed", failed);
  }
  function unobserve(): void {
    context.off("request", requested);
    context.off("response", responded);
    context.off("requestfailed", failed);
  }
  observe();
  return {
    async afterRestart(): Promise<void> {
      unobserve();
      context = app.electronApp.context();
      restarted = true;
      observe();
      tracing = true;
      // app.restart() has already reached readiness; initial thumbnail requests
      // from that new context may precede this observer and are not claimed.
      const result = await captureBoundedFailureDiagnostic(
        () => context.tracing.start({ screenshots: true, snapshots: true, sources: true }), 2_000,
      );
      record("trace-start", { outcome: result.outcome });
    },
    async finish(info: TestInfo, bodyFailed: boolean): Promise<void> {
      try {
        const failed = bodyFailed || info.status !== info.expectedStatus;
        const dom = failed ? await captureBoundedFailureDiagnostic(() => app.page.evaluate(() => {
          const dialogs = [...document.querySelectorAll('[role="dialog"]')];
          return {
            dialogCount: dialogs.length,
            sentPreviewButtonCount: document.querySelectorAll('.sent-attachments button[aria-label^="Preview attachment "]').length,
            unavailablePreview: [...document.querySelectorAll('[role="alert"]')]
              .some((element) => element.textContent?.includes("Preview unavailable")),
            dialogs: dialogs.slice(0, 4).map((dialog) => ({
              visible: dialog.getBoundingClientRect().width > 0 && dialog.getBoundingClientRect().height > 0,
              imageCount: dialog.querySelectorAll("img").length,
              images: [...dialog.querySelectorAll("img")].slice(0, 4).map((image) => ({
                complete: image.complete, width: image.naturalWidth, height: image.naturalHeight,
                connected: image.isConnected,
              })),
            })),
            sentImages: [...document.querySelectorAll<HTMLImageElement>(".sent-attachments img")]
              .slice(0, 12).map((image) => ({ complete: image.complete,
                width: image.naturalWidth, height: image.naturalHeight })),
          };
        }), 2_000) : null;
        const tracePath = failed && tracing ? info.outputPath("image-preview-browser-trace.zip") : null;
        const trace = tracing ? await captureBoundedFailureDiagnostic(
          () => context.tracing.stop(tracePath ? { path: tracePath } : undefined), 2_000,
        ) : null;
        tracing = false;
        if (trace) record("trace-stop", { outcome: trace.outcome });
        if (failed) await captureBoundedFailureDiagnostic(async () => {
          await info.attach("image-preview-state", {
            body: JSON.stringify({ dom, rendererErrorCount: app.rendererErrors.length, events }),
            contentType: "application/json",
          });
          if (tracePath && trace?.outcome === "captured") await info.attach("image-preview-browser-trace", {
            path: tracePath, contentType: "application/zip",
          });
        }, 2_000);
      } finally { unobserve(); }
    },
  };
}
