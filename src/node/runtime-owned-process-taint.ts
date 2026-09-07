import type { RuntimeOwnedProcessDiagnostic } from "./runtime-owned-process-diagnostic.js";
import type { DarwinProcessIdentity } from "./runtime-owned-process-darwin.js";
import type { LinuxGuardianExecutableIdentity } from
  "./runtime-owned-process-linux.js";

export interface RuntimeOwnedProcessRegistryOptions {
  readonly platform?: NodeJS.Platform;
  readonly darwinGuardianPath?: string;
  readonly linuxGuardianExecutable?: LinuxGuardianExecutableIdentity;
  readonly readDarwinIdentity?: (pid: number) => DarwinProcessIdentity | null;
  readonly readDarwinGuardianReady?: (pid: number) => DarwinProcessIdentity | null;
  readonly readDarwinIdentityAsync?: (pid: number, abortSignal?: AbortSignal) =>
    Promise<DarwinProcessIdentity | null>;
  readonly readDarwinGuardianReadyAsync?: (pid: number, abortSignal?: AbortSignal) =>
    Promise<DarwinProcessIdentity | null>;
  readonly readDarwinSessionEmptyAsync?: (sessionId: number, abortSignal?: AbortSignal) =>
    Promise<boolean | null>;
  readonly onTainted?: (diagnostic: RuntimeOwnedProcessDiagnostic) => void;
}

export interface RuntimeOwnedProcessTaintState {
  readonly onTainted: (diagnostic: RuntimeOwnedProcessDiagnostic) => void;
  tainted: boolean;
}

export function taintRuntimeOwnedProcessRegistry(
  state: RuntimeOwnedProcessTaintState,
  notify: boolean,
  diagnostic: RuntimeOwnedProcessDiagnostic,
): void {
  if (state.tainted) return;
  state.tainted = true;
  if (!notify) return;
  try { state.onTainted(diagnostic); } catch {
    // Ownership stays fail-closed even when the recovery request fails.
  }
}
