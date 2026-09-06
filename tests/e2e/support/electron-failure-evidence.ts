import type { TestInfo } from "@playwright/test";
import { ElectronFixtureCloseError, settleOperationBounded } from "./electron-app-lifecycle";

type ReadTestInfo = () => Pick<TestInfo, "attach">;

async function attachElectronFailureEvidence(
  readTestInfo: ReadTestInfo,
  name: string,
  body: string,
  contentType = "text/plain",
): Promise<void> {
  // Called only after fixture cleanup. Bound reporting separately; unavailable
  // Playwright context, rejection or a hung reporter cannot replace the error.
  await settleOperationBounded(Promise.resolve().then(() => readTestInfo().attach(name, {
    body: Buffer.from(body), contentType,
  })), 250);
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
  if (!(error instanceof ElectronFixtureCloseError) || !error.mainProcessSamples.length) return;
  await attachElectronFailureEvidence(readTestInfo, "electron-main-process-samples",
    JSON.stringify(error.mainProcessSamples, null, 2), "application/json");
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
