import type { ElectronApplication } from "@playwright/test";

import type { ElectronPrivilegedCleanupReceipt } from
  "./electron-app-lifecycle";

interface ElectronTestRuntimeShutdown {
  preparePrivilegedCleanup?: () => Promise<ElectronPrivilegedCleanupReceipt>;
  privilegedCleanupSnapshot?: () => ElectronPrivilegedCleanupReceipt;
  finishPreparedQuit?: () => ElectronPrivilegedCleanupReceipt;
}

export async function prepareElectronPrivilegedCleanup(
  current: ElectronApplication | null,
): Promise<ElectronPrivilegedCleanupReceipt> {
  if (!current) {
    throw new Error("The Electron fixture is unavailable during cleanup.");
  }
  return await current.evaluate(async () => {
    const runtime = Reflect.get(
      globalThis,
      "__inertiaTestRuntime",
    ) as ElectronTestRuntimeShutdown | undefined;
    if (!runtime?.preparePrivilegedCleanup) {
      throw new Error("The test privileged-cleanup controller is unavailable.");
    }
    return await runtime.preparePrivilegedCleanup();
  });
}

export async function readElectronPrivilegedCleanupPhase(
  current: ElectronApplication | null,
): Promise<string> {
  if (!current) return "application-unavailable";
  const receipt = await current.evaluate(() => {
    const runtime = Reflect.get(
      globalThis,
      "__inertiaTestRuntime",
    ) as ElectronTestRuntimeShutdown | undefined;
    return runtime?.privilegedCleanupSnapshot?.() ?? null;
  });
  return receipt?.phase ?? "controller-unavailable";
}

export async function finishElectronPreparedQuit(
  current: ElectronApplication | null,
): Promise<number | null> {
  if (!current) return null;
  const receipt = await current.evaluate(() => {
    const runtime = Reflect.get(
      globalThis,
      "__inertiaTestRuntime",
    ) as ElectronTestRuntimeShutdown | undefined;
    if (!runtime?.finishPreparedQuit) {
      throw new Error("The test prepared-quit controller is unavailable.");
    }
    return runtime.finishPreparedQuit();
  });
  return receipt.runtimePid;
}
