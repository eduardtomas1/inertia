import type { ActiveRuntimeOwnedProcessClaim } from "./runtime-owned-process-active.js";
import { LINUX_RUNTIME_OWNED_GUARDIAN_IMMEDIATE_STOP_ADMISSION_TIMEOUT_MS } from
  "./runtime-owned-process-linux.js";

export interface LinuxAdmissionBudget {
  readonly signal: AbortSignal;
  dispose(): void;
}

export function startLinuxAdmissionBudget(
  registrySignal: AbortSignal,
  claim: ActiveRuntimeOwnedProcessClaim,
): LinuxAdmissionBudget {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  const deadlineAt = Date.now() + LINUX_RUNTIME_OWNED_GUARDIAN_IMMEDIATE_STOP_ADMISSION_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const abortWhenStopping = (): void => {
    if (timer || controller.signal.aborted) return;
    timer = setTimeout(abort, Math.max(0, deadlineAt - Date.now()));
    timer.unref?.();
  };
  if (registrySignal.aborted) abort();
  else registrySignal.addEventListener("abort", abort, { once: true });
  claim.abortAdmissionWhenStopping = abortWhenStopping;
  if (claim.stopRequested) abortWhenStopping();
  return {
    signal: controller.signal,
    dispose: () => {
      if (timer) clearTimeout(timer);
      registrySignal.removeEventListener("abort", abort);
      if (claim.abortAdmissionWhenStopping === abortWhenStopping) {
        delete claim.abortAdmissionWhenStopping;
      }
    },
  };
}
