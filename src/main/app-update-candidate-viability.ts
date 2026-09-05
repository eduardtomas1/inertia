import { fileURLToPath } from "node:url";

import { app, utilityProcess, type UtilityProcess } from "electron";

import {
  appUpdateCandidateViabilityRequest,
  appUpdateCandidateViabilityResultAck,
  parseAppUpdateCandidateViabilityResult,
  type AppUpdateCandidateViabilityResult,
  type AppUpdateCandidateExpectedRuntimeOwner,
} from "../node/app-update-candidate-viability-protocol.js";
import { verifyLinuxRuntimeOwnedGuardianSandbox } from
  "../node/runtime-owned-process-linux.js";
import { resolveDesktopRuntimeProcessSafetyAssets } from
  "./runtime-windows-job-bootstrap.js";

const VALIDATION_TIMEOUT_MS = 30_000;
const VALIDATION_EXIT_PROOF_MS = 2_000;

export interface CandidateViabilityDependencies {
  readonly whenReady: () => Promise<void>;
  readonly resolveRuntimeAssets: typeof resolveDesktopRuntimeProcessSafetyAssets;
  readonly verifyLinuxGuardian: typeof verifyLinuxRuntimeOwnedGuardianSandbox;
  readonly spawn: () => UtilityProcess;
  readonly validationTimeoutMs?: number;
  readonly exitProofMs?: number;
}

function runCandidateViabilityWorker(options: {
  readonly operationId: string;
  readonly dataDirectory: string;
  readonly expectedActiveRuntimeOwner:
    AppUpdateCandidateExpectedRuntimeOwner | null;
  readonly spawn: () => UtilityProcess;
  readonly timeoutMs: number;
  readonly exitProofMs: number;
  readonly retainLateTerminationAuthority: boolean;
}): Promise<void> {
  let child: UtilityProcess;
  try {
    child = options.spawn();
  } catch {
    return Promise.reject(new Error(
      "The app update viability process could not be created.",
    ));
  }
  return new Promise((resolve, reject) => {
    let spawned = false;
    let result: AppUpdateCandidateViabilityResult | null = null;
    let stoppingError: Error | null = null;
    let exitProofTimer: NodeJS.Timeout | null = null;
    let killAccepted = false;
    let exitObserved = false;
    let settled = false;
    const cleanup = (terminationObserved = false): void => {
      clearTimeout(timeout);
      if (exitProofTimer) clearTimeout(exitProofTimer);
      child.removeListener("message", onMessage);
      if (terminationObserved || !options.retainLateTerminationAuthority) {
        child.removeListener("spawn", onSpawn);
        child.removeListener("error", onError);
        child.removeListener("exit", onExit);
      }
    };
    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup(exitObserved);
      if (error) reject(error);
      else resolve();
    };
    const stop = (error: Error): void => {
      if (settled || stoppingError) return;
      stoppingError = error;
      requestKill();
      exitProofTimer = setTimeout(() => settle(new Error(
        "The app update viability process exit is unconfirmed.",
      )), options.exitProofMs);
      exitProofTimer.unref();
    };
    const requestKill = (): void => {
      if (killAccepted || exitObserved) return;
      try {
        killAccepted = child.kill();
      } catch { /* Exit proof remains authoritative. */ }
    };
    const onSpawn = (): void => {
      if (stoppingError) {
        if (options.retainLateTerminationAuthority) requestKill();
        return;
      }
      spawned = true;
      try {
        child.postMessage(appUpdateCandidateViabilityRequest({
          operationId: options.operationId,
          dataDirectory: options.dataDirectory,
          expectedActiveRuntimeOwner: options.expectedActiveRuntimeOwner,
        }));
      } catch {
        stop(new Error("The app update viability request could not be delivered."));
      }
    };
    const onMessage = (value: unknown): void => {
      const parsed = parseAppUpdateCandidateViabilityResult(value);
      if (
        !spawned
        || result
        || !parsed
        || parsed.operationId !== options.operationId
      ) {
        stop(new Error("The app update viability result is invalid."));
        return;
      }
      result = parsed;
      try {
        child.postMessage(appUpdateCandidateViabilityResultAck(
          options.operationId,
        ));
      } catch {
        stop(new Error(
          "The app update viability result could not be acknowledged.",
        ));
      }
    };
    const onError = (): void => stop(new Error(
      "The app update viability process stopped unexpectedly.",
    ));
    const onExit = (code: number): void => {
      exitObserved = true;
      if (settled) {
        cleanup(true);
        return;
      }
      if (stoppingError) {
        settle(stoppingError);
        return;
      }
      if (result?.status === "validated" && code === 0) {
        settle();
        return;
      }
      if (result?.status === "rejected" && code === 1) {
        settle(new Error(
          `The app update candidate failed viability validation (${result.code}).`,
        ));
        return;
      }
      settle(new Error("The app update viability process stopped unexpectedly."));
    };
    const timeout = setTimeout(() => stop(new Error(
      "The app update candidate viability validation timed out.",
    )), options.timeoutMs);
    timeout.unref();
    child.once("spawn", onSpawn);
    child.on("message", onMessage);
    child.on("error", onError);
    child.once("exit", onExit);
  });
}

export async function validateDesktopAppUpdateCandidate(options: {
  readonly operationId: string;
  readonly dataDirectory: string;
  readonly expectedActiveRuntimeOwner:
    AppUpdateCandidateExpectedRuntimeOwner | null;
  readonly platform?: NodeJS.Platform;
  readonly dependencies?: CandidateViabilityDependencies;
}): Promise<void> {
  const dependencies: CandidateViabilityDependencies = options.dependencies ?? {
    whenReady: async () => await app.whenReady(),
    resolveRuntimeAssets: resolveDesktopRuntimeProcessSafetyAssets,
    verifyLinuxGuardian: verifyLinuxRuntimeOwnedGuardianSandbox,
    spawn: () => utilityProcess.fork(
      fileURLToPath(new URL(
        "./app-update-candidate-viability-worker.js",
        import.meta.url,
      )),
      [],
      {
        env: {},
        stdio: "ignore",
        serviceName: "Inertia Update Validator",
      },
    ),
  };
  await dependencies.whenReady();
  const platform = options.platform ?? process.platform;
  const assets = dependencies.resolveRuntimeAssets();
  if (
    platform === "linux"
    && (
      !assets.runtimeProcessGuardianPath
      || !dependencies.verifyLinuxGuardian(assets.runtimeProcessGuardianPath)
    )
  ) throw new Error("The app update candidate runtime guardian is invalid.");
  if (platform === "win32" && !assets.windowsRuntimeJobAssembly) {
    throw new Error("The app update candidate runtime containment asset is invalid.");
  }
  await runCandidateViabilityWorker({
    operationId: options.operationId,
    dataDirectory: options.dataDirectory,
    expectedActiveRuntimeOwner: options.expectedActiveRuntimeOwner,
    spawn: dependencies.spawn,
    timeoutMs: Math.max(1, Math.min(
      VALIDATION_TIMEOUT_MS,
      dependencies.validationTimeoutMs ?? VALIDATION_TIMEOUT_MS,
    )),
    exitProofMs: Math.max(1, Math.min(
      VALIDATION_EXIT_PROOF_MS,
      dependencies.exitProofMs ?? VALIDATION_EXIT_PROOF_MS,
    )),
    retainLateTerminationAuthority: platform === "linux",
  });
}
