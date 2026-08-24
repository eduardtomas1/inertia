import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { RuntimeGenerationLeaseJournal } from "../node/runtime-generation-leases.js";
import { RuntimeOwnedProcessJournal } from "../node/runtime-owned-processes.js";
import { runtimeCleanupReceiptIds } from "./runtime-cleanup-receipts.js";
import { readSystemBootId } from "./system-boot-id.js";
export { runtimeProcessEnvironment } from "./runtime-process-environment.js";

export interface RuntimeBootstrapSafety {
  systemBootId: string;
  preserveAttachments: boolean;
}

export function runtimeDataPath(configuredPath: string | undefined, userDataPath: string): string {
  return configuredPath ? resolve(configuredPath) : join(userDataPath, "runtime");
}

export function runtimeWorkspacePath(
  configuredPath: string | undefined,
  homePath: string,
  directoryName = "Inertia",
): string {
  return configuredPath ? resolve(configuredPath) : join(homePath, directoryName);
}

export function prepareRuntimeBootstrapSafety(
  dataDirectory: string,
): RuntimeBootstrapSafety {
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const systemBootId = readSystemBootId() ?? "unavailable";
  const generationLeases = new RuntimeGenerationLeaseJournal(dataDirectory);
  const ownedProcesses = new RuntimeOwnedProcessJournal(dataDirectory);
  const receiptsRetired = runtimeCleanupReceiptIds(dataDirectory).every(
    (generationId) => generationLeases.clearRuntimeGeneration(generationId),
  );
  const priorBootRetired = ownedProcesses.clearPriorBootSessions(systemBootId)
    && generationLeases.clearPriorBootSessions(systemBootId);
  return {
    systemBootId,
    preserveAttachments: !receiptsRetired
      || !priorBootRetired
      || generationLeases.safetyLocked(),
  };
}

export function runtimeUpdateVersion(currentVersion: string): string {
  const candidate = process.env.NODE_ENV === "test"
    ? process.env.INERTIA_TEST_APP_UPDATE_VERSION
    : undefined;
  return typeof candidate === "string" && /^v?\d+\.\d+\.\d+$/u.test(candidate)
    ? candidate
    : currentVersion;
}
