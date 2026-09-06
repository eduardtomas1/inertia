import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import { ConversationAttachmentStoreReconcilingError,
  type ConversationAttachmentStore } from "../../../node/conversation-attachment-store.js";
import { writePackagedSmokeResult } from "./package-smoke-pdf.js";

const PACKAGE_SMOKE_IMAGE_ID = "00000000-0000-4000-8000-000000000018";
const PACKAGE_SMOKE_RETENTION_ID = "00000000-0000-4000-8000-000000000019";
const PACKAGE_SMOKE_IMAGE_TIMEOUT_MS = 30_000;

export async function runPackagedImageRetentionSmoke(
  inputPath: string,
  resultPath: string,
  store: ConversationAttachmentStore,
  signal?: AbortSignal,
): Promise<void> {
  // One operation budget includes reconciliation admission, retention,
  // preview and publication. Runtime shutdown can cancel it sooner.
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error(
    "The packaged image retention smoke exceeded its deadline.",
  )), PACKAGE_SMOKE_IMAGE_TIMEOUT_MS);
  timer.unref();
  const operationSignal = signal
    ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  try {
    const bytes = await readFile(inputPath, { signal: operationSignal });
    const payloads = [{
      attachment: {
        id: PACKAGE_SMOKE_IMAGE_ID,
        name: "package-smoke.png",
        path: inputPath,
        mimeType: "image/png" as const,
        size: bytes.byteLength,
      },
      bytes,
    }];
    let retained;
    while (true) {
      operationSignal.throwIfAborted();
      try {
        [retained] = await store.retain(payloads, operationSignal, PACKAGE_SMOKE_RETENTION_ID);
        break;
      } catch (error) {
        // Only this pre-publication guard is retryable. Validation, failed
        // reconciliation and partially admitted persistence are final errors.
        if (!(error instanceof ConversationAttachmentStoreReconcilingError)) throw error;
        await delay(25, undefined, { signal: operationSignal });
      }
    }
    const preview = retained
      ? await store.preview(retained.id, operationSignal)
      : null;
    operationSignal.throwIfAborted();
    if (!preview || !Buffer.from(preview.bytes).equals(bytes)) {
      throw new Error("The packaged image retention path returned invalid bytes.");
    }
    store.acceptRetention(PACKAGE_SMOKE_RETENTION_ID);
    await writePackagedSmokeResult(resultPath, { ok: true }, { signal: operationSignal });
  } catch (error) {
    const failure: unknown = operationSignal.aborted ? operationSignal.reason : error;
    await writePackagedSmokeResult(resultPath, {
      ok: false,
      message: failure instanceof Error ? failure.message : "Image retention failed.",
    }, { signal: deadline.signal }).catch(() => undefined);
    throw failure;
  } finally {
    clearTimeout(timer);
  }
}
