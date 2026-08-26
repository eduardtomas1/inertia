import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { RuntimeGenerationLeaseJournal } from "../node/runtime-generation-leases.js";
import { RuntimeOwnedProcessJournal } from "../node/runtime-owned-processes.js";
import {
  RuntimeCleanupReceiptJournal,
  runtimeCleanupReceiptIds,
} from "./runtime-cleanup-receipts.js";
import {
  readSystemBootId,
  readSystemBootStartedAtMs,
} from "./system-boot-id.js";
export { runtimeProcessEnvironment } from "./runtime-process-environment.js";

export interface RuntimeBootstrapSafety {
  systemBootId: string;
  preserveAttachments: boolean;
}

const LEGACY_REBOOT_PROOF_MARGIN_MS = 60_000;

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
  const cleanupReceipts = new RuntimeCleanupReceiptJournal(dataDirectory);
  const needsLegacyBootRecovery = generationLeases.isValid()
    && generationLeases.all().some((lease) =>
      lease.systemBootId === "unavailable");
  const systemBootStartedAtMs = needsLegacyBootRecovery
    ? readSystemBootStartedAtMs()
    : null;
  const rebootedGenerations = systemBootStartedAtMs === null
    ? []
    : generationLeases.generationsCreatedBefore(
        Math.max(0, systemBootStartedAtMs - LEGACY_REBOOT_PROOF_MARGIN_MS),
        "unavailable",
      );
  const rebootedGenerationsRetired = rebootedGenerations !== null
    && rebootedGenerations.every((generationId) => (
      ownedProcesses.clearRuntimeGenerationAfterConfirmedReboot(generationId)
      && cleanupReceipts.publish(generationId)
      && generationLeases.clearRuntimeGeneration(generationId)
    ));
  const receiptsRetired = runtimeCleanupReceiptIds(dataDirectory).every(
    (generationId) => generationLeases.clearRuntimeGeneration(generationId),
  );
  const priorBootRetired = ownedProcesses.clearPriorBootSessions(systemBootId)
    && generationLeases.clearPriorBootSessions(systemBootId);
  return {
    systemBootId,
    preserveAttachments: !receiptsRetired
      || !rebootedGenerationsRetired
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
