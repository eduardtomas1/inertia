import { stopRuntimeAndPrivateConnect } from "./runtime-shutdown-coordination.js";

interface DestroyableWindow {
  isDestroyed(): boolean;
  destroy(): void;
}

export function finishPrivilegedExit(options: {
  takeWindow(): DestroyableWindow | null;
  recordExit(): void;
  exit(): never;
}): never {
  const window = options.takeWindow();
  if (window && !window.isDestroyed()) window.destroy();
  options.recordExit();
  // Every privileged owner has settled. Electron's native exit can still
  // remain resident, so normal shutdown ends the already-clean process.
  return options.exit();
}

export async function runPrivilegedCleanupSequence(options: {
  stopRuntime(): Promise<boolean>;
  stopPrivateConnect(): Promise<void>;
  disposeTemporaryAttachments(): Promise<void>;
  closeDurableAttachments(): Promise<void>;
  onTemporaryAttachmentError(error: unknown): void;
  onUnconfirmedRuntimeExit(): void;
}): Promise<boolean> {
  const runtimeExitConfirmed = await stopRuntimeAndPrivateConnect(
    options.stopRuntime,
    options.stopPrivateConnect,
  );
  if (runtimeExitConfirmed) {
    await options.disposeTemporaryAttachments().catch(
      options.onTemporaryAttachmentError,
    );
  } else {
    options.onUnconfirmedRuntimeExit();
  }
  await options.closeDurableAttachments();
  return runtimeExitConfirmed;
}

export function cleanupPrivilegedOwners(options: {
  runtime: { stop(): Promise<boolean> } | null;
  privateConnect: { shutdown(): Promise<void> } | null;
  onRuntimeStopped(): void;
  onRuntimeError(error: unknown): void;
  onPrivateConnectError(error: unknown): void;
  disposeTemporaryAttachments(): Promise<void>;
  closeDurableAttachments(): Promise<void>;
  onTemporaryAttachmentError(error: unknown): void;
  onUnconfirmedRuntimeExit(): void;
}): Promise<boolean> {
  let privateConnectExitConfirmed = true;
  return runPrivilegedCleanupSequence({
    stopRuntime: async () => {
      if (!options.runtime) return true;
      const confirmed = await options.runtime.stop().catch((error: unknown) => {
        options.onRuntimeError(error);
        return false;
      });
      if (confirmed) options.onRuntimeStopped();
      return confirmed;
    },
    stopPrivateConnect: async () => {
      await options.privateConnect?.shutdown().catch((error: unknown) => {
        privateConnectExitConfirmed = false;
        options.onPrivateConnectError(error);
      });
    },
    disposeTemporaryAttachments: options.disposeTemporaryAttachments,
    closeDurableAttachments: options.closeDurableAttachments,
    onTemporaryAttachmentError: options.onTemporaryAttachmentError,
    onUnconfirmedRuntimeExit: options.onUnconfirmedRuntimeExit,
  }).then((runtimeExitConfirmed) => runtimeExitConfirmed && privateConnectExitConfirmed);
}
