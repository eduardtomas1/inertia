import type { TestInfo } from "@playwright/test";
import { ElectronFixtureCloseError, settleOperationBounded } from "./electron-app-lifecycle";
import { captureBoundedFailureDiagnostic } from "../../helpers/bounded-failure-diagnostic";
import { readImageSendRuntimeRecords } from "./image-send-failure-diagnostics";

type ReadTestInfo = () => Pick<TestInfo, "attach">;

async function attachElectronFailureEvidence(
  readTestInfo: ReadTestInfo,
  name: string,
  body: string,
  contentType = "text/plain",
  timeoutMs = 250,
): Promise<void> {
  // Failure-only reporting has its own bound; unavailable Playwright context,
  // rejection or a hung reporter cannot replace the cleanup error.
  if (timeoutMs <= 0) return;
  await settleOperationBounded(Promise.resolve().then(() => readTestInfo().attach(name, {
    body: Buffer.from(body), contentType,
  })), timeoutMs);
}

export async function attachElectronFixtureRuntimeRecords(
  readTestInfo: ReadTestInfo,
  testDirectory: string,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  // Reuse the fixed-file, digest-checked allowlist projection. Never retain
  // raw logs, arbitrary error messages, credentials, or runtime endpoints.
  const records = await captureBoundedFailureDiagnostic(
    () => readImageSendRuntimeRecords(testDirectory, signal), 500,
  );
  if (signal.aborted) return;
  await attachElectronFailureEvidence(readTestInfo, "electron-cleanup-runtime-records",
    JSON.stringify(records, null, 2), "application/json");
}

async function attachElectronTestBodyFailure(
  readTestInfo: ReadTestInfo,
  error: unknown,
): Promise<void> {
  const body = error instanceof Error ? error.stack ?? error.message : String(error);
  await attachElectronFailureEvidence(
    readTestInfo, "original-test-body-failure", body.slice(0, 16_384),
  );
}

export async function attachElectronFixtureCloseFailure(
  readTestInfo: ReadTestInfo,
  error: unknown,
): Promise<void> {
  if (!(error instanceof ElectronFixtureCloseError)) return;
  const deadlineAt = Date.now() + 250;
  if (error.processEvidence) {
    await attachElectronFailureEvidence(readTestInfo, "electron-process-lifecycle",
      JSON.stringify(error.processEvidence, null, 2), "application/json", deadlineAt - Date.now());
  }
  if (error.mainProcessSamples.length) {
    await attachElectronFailureEvidence(readTestInfo, "electron-main-process-samples",
      JSON.stringify(error.mainProcessSamples, null, 2), "application/json", deadlineAt - Date.now());
  }
}

export async function closeElectronAfterTest(
  close: () => Promise<void>,
  readTestInfo: ReadTestInfo,
  bodyFailure?: { error: unknown },
): Promise<void> {
  let closeFailure: { error: unknown } | undefined;
  try { await close(); } catch (error) { closeFailure = { error }; }
  if (bodyFailure) await attachElectronTestBodyFailure(readTestInfo, bodyFailure.error);
  if (!closeFailure) return;
  if (bodyFailure) {
    throw new AggregateError([bodyFailure.error, closeFailure.error],
      "The test body and Electron fixture cleanup both failed.", { cause: bodyFailure.error });
  }
  throw closeFailure.error;
}
