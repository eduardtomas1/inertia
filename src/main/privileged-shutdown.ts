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

export function finishNormalShutdownAfterCleanup(options: {
  cleanupConfirmed: boolean;
  finish(): void;
  onUnconfirmed(): void;
}): boolean {
  if (!options.cleanupConfirmed) {
    options.onUnconfirmed();
    return false;
  }
  options.finish();
  return true;
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

export interface RetryablePrivilegedCleanupOptions {
  retryUnconfirmed?: boolean;
  runtime: { stop(): Promise<boolean> } | null;
  privateConnect: { shutdown(): Promise<void> } | null;
  onRuntimeStopped(): void;
  onRuntimeError(error: unknown): void;
  onPrivateConnectStopped(): void;
  onPrivateConnectError(error: unknown): void;
  disposeTemporaryAttachments(): Promise<void>;
  closeDurableAttachments(): Promise<void>;
  onDurableAttachmentsClosed(): void;
  onTemporaryAttachmentError(error: unknown): void;
  onUnconfirmedRuntimeExit(): void;
}

/** Retains every original owner until that exact owner's cleanup succeeds. */
export class RetryablePrivilegedCleanup {
  private runtimeConfirmed: boolean;
  private privateConnectConfirmed: boolean;
  private durableAttachmentsConfirmed = false;
  private temporaryAttachmentsHandled = false;
  private attempt: Promise<boolean> | null = null;

  constructor(private readonly options: RetryablePrivilegedCleanupOptions) {
    this.runtimeConfirmed = options.runtime === null;
    this.privateConnectConfirmed = options.privateConnect === null;
  }

  cleanup(): Promise<boolean> {
    if (this.attempt) return this.attempt;
    const attempt = this.run().then((confirmed) => {
      if (
        !confirmed
        && this.options.retryUnconfirmed === true
        && this.attempt === attempt
      ) this.attempt = null;
      return confirmed;
    }, (error: unknown) => {
      if (
        this.options.retryUnconfirmed === true
        && this.attempt === attempt
      ) this.attempt = null;
      throw error;
    });
    this.attempt = attempt;
    return attempt;
  }

  private async run(): Promise<boolean> {
    const [runtimeConfirmed, privateConnectConfirmed] = await Promise.all([
      this.stopRuntime(),
      this.stopPrivateConnect(),
    ]);
    if (runtimeConfirmed && !this.temporaryAttachmentsHandled) {
      this.temporaryAttachmentsHandled = true;
      await this.options.disposeTemporaryAttachments().catch(
        this.options.onTemporaryAttachmentError,
      );
    } else if (!runtimeConfirmed) {
      this.options.onUnconfirmedRuntimeExit();
    }
    if (!this.durableAttachmentsConfirmed) {
      await this.options.closeDurableAttachments();
      this.durableAttachmentsConfirmed = true;
      this.options.onDurableAttachmentsClosed();
    }
    return runtimeConfirmed
      && privateConnectConfirmed
      && this.durableAttachmentsConfirmed;
  }

  private async stopRuntime(): Promise<boolean> {
    if (this.runtimeConfirmed || !this.options.runtime) return true;
    const confirmed = await this.options.runtime.stop().catch((error: unknown) => {
      this.options.onRuntimeError(error);
      return false;
    });
    if (confirmed) {
      this.runtimeConfirmed = true;
      this.options.onRuntimeStopped();
    }
    return confirmed;
  }

  private async stopPrivateConnect(): Promise<boolean> {
    if (this.privateConnectConfirmed || !this.options.privateConnect) return true;
    try {
      await this.options.privateConnect.shutdown();
      this.privateConnectConfirmed = true;
      this.options.onPrivateConnectStopped();
      return true;
    } catch (error) {
      this.options.onPrivateConnectError(error);
      return false;
    }
  }
}
