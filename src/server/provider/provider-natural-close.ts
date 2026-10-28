import type { ChildProcess } from "node:child_process";

import {
  activeRuntimeOwnedProcessPlatform,
  awaitRuntimeOwnedProcessStopped,
} from "../../node/runtime-owned-processes";

export const PROVIDER_NATURAL_CLOSE_MS = 2_000;

export function providerNaturalCloseFirst(): boolean {
  return activeRuntimeOwnedProcessPlatform() === "darwin";
}

function childClosed(child: ChildProcess): boolean {
  return (child.exitCode !== null || child.signalCode !== null)
    && child.stdio.every((stream) => stream === null || stream === undefined || stream.closed);
}

export function endProviderInput(child: ChildProcess): void {
  try { child.stdin?.end(); } catch { return; }
}

export function waitForProviderNaturalClose(
  child: ChildProcess,
  waitMs = PROVIDER_NATURAL_CLOSE_MS,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (stopped: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("close", onClose);
      resolve(stopped);
    };
    const onClose = (): void => {
      awaitRuntimeOwnedProcessStopped(child).then(finish, () => finish(false));
    };
    const timer = setTimeout(() => finish(false), waitMs);
    timer.unref();
    if (childClosed(child)) onClose();
    else child.once("close", onClose);
  });
}
