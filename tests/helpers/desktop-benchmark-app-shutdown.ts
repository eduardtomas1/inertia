import {
  runtimePidAfterQuit,
  type BoundedQuitRequestResult,
} from "./runtime-pid-after-quit";

export interface DesktopBenchmarkAppResource {
  runtimePid: number | null;
}

export interface DesktopBenchmarkQuitResult {
  readonly outcome: "graceful" | "abnormal" | "forced";
  readonly requestResult: BoundedQuitRequestResult;
  readonly transportSettled: boolean;
}

export interface DesktopBenchmarkShutdown {
  readonly durationMs: number;
  readonly outcome: DesktopBenchmarkQuitResult["outcome"];
  readonly transportSettled: boolean;
  readonly runtimePid: number | null;
}

/** Completes process proof using the quit-time snapshot before releasing ownership. */
export async function completeDesktopBenchmarkShutdown(
  resource: DesktopBenchmarkAppResource,
  dependencies: {
    readonly quit: () => Promise<DesktopBenchmarkQuitResult>;
    readonly waitForRuntimeExit: (pid: number) => Promise<void>;
    readonly now?: () => number;
  },
): Promise<DesktopBenchmarkShutdown> {
  const now = dependencies.now ?? Date.now;
  const startedAt = now();
  const result = await dependencies.quit();
  const currentRuntime = runtimePidAfterQuit(
    result.requestResult,
    resource.runtimePid,
  );
  if (!currentRuntime.confirmed) {
    throw new Error(
      "Desktop benchmark shutdown could not identify the current utility-runtime PID.",
    );
  }
  resource.runtimePid = currentRuntime.pid;
  if (currentRuntime.pid !== null) {
    await dependencies.waitForRuntimeExit(currentRuntime.pid);
  }
  return {
    durationMs: now() - startedAt,
    outcome: result.outcome,
    transportSettled: result.transportSettled,
    runtimePid: currentRuntime.pid,
  };
}
