import { join, resolve } from "node:path";

import { RuntimeGenerationLeaseJournal } from "../node/runtime-generation-leases.js";
import { runtimeCleanupReceiptIds } from "./runtime-cleanup-receipts.js";
import { readSystemBootId } from "./system-boot-id.js";

export interface RuntimeBootstrapSafety {
  systemBootId: string;
  preserveAttachments: boolean;
}

export function runtimeDataPath(configuredPath: string | undefined, userDataPath: string): string {
  return configuredPath ? resolve(configuredPath) : join(userDataPath, "runtime");
}

export function runtimeWorkspacePath(configuredPath: string | undefined, homePath: string): string {
  return configuredPath ? resolve(configuredPath) : join(homePath, "Inertia");
}

export function prepareRuntimeBootstrapSafety(
  dataDirectory: string,
): RuntimeBootstrapSafety {
  const systemBootId = readSystemBootId() ?? "unavailable";
  const generationLeases = new RuntimeGenerationLeaseJournal(dataDirectory);
  const receiptsRetired = runtimeCleanupReceiptIds(dataDirectory).every(
    (generationId) => generationLeases.clearRuntimeGeneration(generationId),
  );
  const priorBootRetired = generationLeases.clearPriorBootSessions(systemBootId);
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
