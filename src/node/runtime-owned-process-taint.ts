import type { DarwinProcessIdentity } from "./runtime-owned-process-darwin.js";

export interface RuntimeOwnedProcessRegistryOptions {
  readonly platform?: NodeJS.Platform;
  readonly darwinGuardianPath?: string;
  readonly readDarwinIdentity?: (pid: number) => DarwinProcessIdentity | null;
  readonly readDarwinGuardianReady?: (pid: number) => DarwinProcessIdentity | null;
  readonly readDarwinIdentityAsync?: (pid: number, abortSignal?: AbortSignal) =>
    Promise<DarwinProcessIdentity | null>;
  readonly readDarwinGuardianReadyAsync?: (pid: number, abortSignal?: AbortSignal) =>
    Promise<DarwinProcessIdentity | null>;
  readonly readDarwinSessionEmptyAsync?: (sessionId: number, abortSignal?: AbortSignal) =>
    Promise<boolean | null>;
  readonly onTainted?: () => void;
}

export interface RuntimeOwnedProcessTaintState {
  readonly onTainted: () => void;
  tainted: boolean;
}

export function taintRuntimeOwnedProcessRegistry(
  state: RuntimeOwnedProcessTaintState,
  notify: boolean,
): void {
  if (state.tainted) return;
  state.tainted = true;
  if (!notify) return;
  try { state.onTainted(); } catch {
    // Ownership stays fail-closed even when the recovery request fails.
  }
}
