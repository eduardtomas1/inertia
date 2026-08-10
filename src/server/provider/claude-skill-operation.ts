export interface ClaudeSkillFilesystemTestSeam {
  beforeOperation?: (
    operation: string,
    path: string,
  ) => void | Promise<void>;
  afterOperation?: (
    operation: string,
    path: string,
    result: unknown,
  ) => void | Promise<void>;
}

export interface ClaudeSkillOperationControl
  extends ClaudeSkillFilesystemTestSeam {
  signal?: AbortSignal;
}

interface CleanupCapability {
  cleanup: () => Promise<void>;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Claude skill filesystem work was cancelled.");
}

export function checkClaudeSkillOperation(
  control: ClaudeSkillOperationControl,
): void {
  if (control.signal?.aborted) throw abortError(control.signal);
}

export async function runClaudeSkillFilesystemOperation<T>(
  control: ClaudeSkillOperationControl,
  operation: string,
  path: string,
  run: () => Promise<T>,
  abandon?: (value: T) => void | Promise<void>,
): Promise<T> {
  checkClaudeSkillOperation(control);
  await control.beforeOperation?.(operation, path);
  checkClaudeSkillOperation(control);
  // Kernel filesystem calls cannot be preempted portably. The public caller
  // races the operation signal; when this syscall eventually returns, this
  // checkpoint unwinds the abandoned work and its staging cleanup.
  const result = await run();
  try {
    await control.afterOperation?.(operation, path, result);
    checkClaudeSkillOperation(control);
    return result;
  } catch (error) {
    await abandon?.(result);
    throw error;
  }
}

export function raceClaudeSkillOperation<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const aborted = (): void => reject(abortError(signal));
    signal.addEventListener("abort", aborted, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });
}

export function raceClaudeSkillStaging<
  T extends CleanupCapability | null,
>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return raceClaudeSkillOperation(operation, signal).catch((error: unknown) => {
    // The syscall/test seam may finish after the public operation abandoned
    // staging. If it still produced a plugin, remove it instead of leaking a
    // privileged temporary capability directory.
    void operation.then(
      async (staged) => await staged?.cleanup().catch(() => undefined),
      () => undefined,
    );
    throw error;
  });
}

export function createClaudeSkillDeadline(
  timeoutMs: number,
  timeoutMessage: string,
  parentSignal?: AbortSignal,
): { dispose: () => void; signal: AbortSignal } {
  const controller = new AbortController();
  const parentAborted = (): void => controller.abort(
    parentSignal?.reason instanceof Error
      ? parentSignal.reason
      : new Error("Claude skill filesystem work was cancelled."),
  );
  if (parentSignal?.aborted) parentAborted();
  else parentSignal?.addEventListener("abort", parentAborted, { once: true });
  const timer = setTimeout(() => {
    controller.abort(new Error(timeoutMessage));
  }, Math.max(1, Math.min(Math.trunc(timeoutMs), 30_000)));
  timer.unref();
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", parentAborted);
    },
  };
}
