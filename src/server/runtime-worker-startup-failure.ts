import {
  categorizedRuntimeStartupFailureMessage,
  runtimeStartupBlockerCode,
  runtimeStartupFailureMessage,
  type RuntimeStartupFailureCategory,
  type RuntimeStartupFailureEvent,
  type RuntimeStartupFailurePhase,
} from "../shared/runtime-startup-diagnostics.js";
import { GitError, isGitProcessTreeTerminationFailure } from "./git/types.js";

/** Classify known error types/codes only; never copy message, cause or paths. */
export function runtimeStartupFailureCategory(error: unknown): RuntimeStartupFailureCategory {
  try {
    if (isGitProcessTreeTerminationFailure(error)) return "git-cleanup-unconfirmed";
    if (error instanceof GitError) {
      if (error.code === "timeout") return "git-timeout";
      return error.code === "git-unavailable" ? "git-unavailable" : "git-operation-failed";
    }
    if (error instanceof TypeError) return "type-error";
    if (error instanceof RangeError) return "range-error";
    if (error instanceof Error && "code" in error) {
      if (error.code === "EACCES" || error.code === "EPERM") return "filesystem-permission";
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return "filesystem-missing";
      if (error.code === "EIO" || error.code === "ENOSPC" || error.code === "EMFILE" || error.code === "ENFILE") return "filesystem-io";
    }
  } catch { /* A diagnostic must not interfere with the original cleanup path. */ }
  return "unknown";
}

export function runtimeStartupErrorEvent(
  error: unknown,
  phase: RuntimeStartupFailurePhase,
): RuntimeStartupFailureEvent {
  const blockerCode = runtimeStartupBlockerCode(error);
  return {
    type: "runtime.startup-failed",
    message: blockerCode ? runtimeStartupFailureMessage(blockerCode)
      : categorizedRuntimeStartupFailureMessage(phase, runtimeStartupFailureCategory(error)),
    ...(blockerCode ? { blockerCode } : {}),
  };
}

/** Preserve which side of startup failed, including asynchronous close errors. */
export async function observeRuntimeStartup<Runtime>(
  startup: Promise<Runtime>,
  started: (runtime: Runtime) => Promise<void>,
  failed: (event: RuntimeStartupFailureEvent) => Promise<void>,
): Promise<void> {
  let phase: RuntimeStartupFailurePhase = "initialization";
  try {
    const runtime = await startup;
    phase = "startup completion";
    await started(runtime);
  } catch (error) {
    await failed(runtimeStartupErrorEvent(error, phase));
  }
}
