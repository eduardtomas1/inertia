import type { ElectronApplication } from "@playwright/test";

import type { ElectronPrivilegedCleanupReceipt } from
  "./electron-app-lifecycle";

interface ElectronTestRuntimeShutdown {
  preparePrivilegedCleanup?: () => Promise<ElectronPrivilegedCleanupReceipt>;
  privilegedCleanupSnapshot?: () => ElectronPrivilegedCleanupReceipt & { owners?: unknown };
  finishPreparedQuit?: () => ElectronPrivilegedCleanupReceipt;
  quit?: () => unknown;
}

export function formatElectronPrivilegedCleanupPhase(
  receipt: (ElectronPrivilegedCleanupReceipt & { owners?: unknown }) | null,
): string {
  const phase = receipt?.phase ?? "controller-unavailable";
  // Fixed scalar evidence only; never serialize arbitrary inspector values.
  try {
    const owners = receipt?.owners;
    if (owners === undefined) return phase;
    if (!owners || typeof owners !== "object") return `${phase};owners=unavailable`;
    const summary: string[] = [];
    for (const owner of ["runtime", "privateConnect", "temporaryAttachments", "durableAttachments"] as const) {
      const state: unknown = Reflect.get(owners, owner);
      if (state !== "not-started" && state !== "pending" && state !== "fulfilled" && state !== "rejected") {
        return `${phase};owners=unavailable`;
      }
      summary.push(`${owner}:${state}`);
    }
    return `${phase};owners=${summary.join(",")}`;
  } catch { return `${phase};owners=unavailable`; }
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
  // This RPC is only read after preparation failed. Keep the authoritative
  // receipt phase/result unchanged; enrich only the fixture's failure text.
  return formatElectronPrivilegedCleanupPhase(receipt);
}

export async function finishElectronPreparedQuit(
  current: ElectronApplication | null,
): Promise<number | null> {
  return await requestElectronQuit(current, "prepared");
}

export async function requestElectronApplicationQuit(
  current: ElectronApplication,
): Promise<number | null> {
  return await requestElectronQuit(current, "application");
}

async function requestElectronQuit(
  current: ElectronApplication | null,
  mode: "prepared" | "application",
): Promise<number | null> {
  if (!current) return null;
  return await current.evaluate(({ BrowserWindow, app }, quitMode) => {
    const runtime = Reflect.get(
      globalThis,
      "__inertiaTestRuntime",
    ) as ElectronTestRuntimeShutdown | undefined;
    if (quitMode === "prepared" && !runtime?.finishPreparedQuit) {
      throw new Error("The test prepared-quit controller is unavailable.");
    }
    if (quitMode === "application" && !runtime?.quit) {
      throw new Error("The test application-quit controller is unavailable.");
    }
    // Both paths retain their own cleanup and exit authority. The inspector
    // is detached only when that path reaches process.exit after cleanup.
    const mark = (stage: string): void => {
      try { process.getBuiltinModule("node:fs").writeSync(2, `[Inertia test exit: ${stage}]\n`); } catch { /* advisory */ }
    };
    try {
      const windows = BrowserWindow.getAllWindows();
      if (windows.length === 1) {
        const window = windows[0]!;
        const destroy = window.destroy;
        window.destroy = function () {
          mark("window-destroy-entered");
          const result = destroy.call(this);
          mark("window-destroy-returned");
          return result;
        };
      } else { mark("window-identity-unavailable"); }
    } catch { mark("window-observer-unavailable"); }
    try {
      app.prependOnceListener("quit", () => mark("app-quit-entered"));
      app.once("quit", () => mark("app-quit-tail-observed"));
      if (quitMode === "prepared") {
        app.once("browser-window-created", () => mark("window-created-after-cleanup"));
        app.once("activate", () => mark("activated-after-cleanup"));
      }
    } catch { mark("quit-events-observer-unavailable"); }
    try {
      const exit = process.exit;
      process.exit = function (...args): never {
        // Node waits for attached debuggers inside process.exit. Detach the
        // test inspector here, after privileged cleanup and window destruction,
        // so Playwright's debugger cannot keep the clean process resident.
        process.getBuiltinModule("node:inspector").close();
        mark("process-exit-called");
        const result = exit.apply(this, args);
        // Electron replaces process.exit with app.exit, which may return after
        // scheduling native shutdown. This marker is not proof of OS exit.
        mark("native-exit-returned");
        return result;
      };
    } catch { mark("process-exit-observer-unavailable"); }
    if (quitMode === "application") {
      runtime!.quit!();
      return null;
    }
    return runtime!.finishPreparedQuit!().runtimePid;
  }, mode);
}
