import type { IncidentObservation } from "../../node/application-incidents";
import { diagnosticContextSchema } from "../../shared/application-diagnostics";
import { forceTerminationBudgetMs } from "../process-lifecycle";
import type { PosixCleanupFailureReason } from "../posix-cleanup-diagnostics";
import type { ProviderRunIdentity } from "./contracts";

export const DEFAULT_PROVIDER_CANCEL_GRACE_MS = 2_000;
export const PROVIDER_SHUTDOWN_STOP_GRACE_MS = 1_000;
export const PROVIDER_SHUTDOWN_RESERVE_MS = 2_500;
const MAX_CLEANUP_CONFIRMATION_WAIT_MS = 30_000;
const MAX_CLEANUP_RECEIPTS = 256;

export function ownedProviderStopBudgetMs(
  platform: NodeJS.Platform = process.platform,
  cancelGraceMs = DEFAULT_PROVIDER_CANCEL_GRACE_MS,
): number {
  return cancelGraceMs + forceTerminationBudgetMs(platform);
}

export function boundedCleanupConfirmation(
  confirmation: Promise<boolean> | undefined,
): Promise<boolean> {
  if (!confirmation) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), MAX_CLEANUP_CONFIRMATION_WAIT_MS);
    timer.unref?.();
    Promise.resolve(confirmation).then(
      (confirmed) => {
        clearTimeout(timer);
        resolve(confirmed === true);
      },
      () => {
        clearTimeout(timer);
        resolve(false);
      },
    );
  });
}

export async function drainBeforeShutdownReserve(
  operations: ReadonlySet<Promise<unknown>>,
  shutdownDeadlineAt: number | null,
): Promise<boolean> {
  let expired = false;
  let timer: NodeJS.Timeout | undefined;
  const reserve = shutdownDeadlineAt === null
    ? null
    : new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          expired = true;
          resolve();
        }, Math.max(0, shutdownDeadlineAt - PROVIDER_SHUTDOWN_RESERVE_MS - Date.now()));
        timer.unref?.();
      });
  try {
    while (operations.size > 0 && !expired) {
      const drained = Promise.allSettled(operations);
      await (reserve ? Promise.race([drained, reserve]) : drained);
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
  return operations.size === 0;
}

export function providerCleanupIncident(
  identity: ProviderRunIdentity,
  cleanupReason?: PosixCleanupFailureReason,
): IncidentObservation {
  const context = diagnosticContextSchema.safeParse({
    providerId: identity.providerId,
    conversationId: identity.conversationId,
    turnId: identity.turnId,
  });
  return {
    code: "provider.cleanup-unconfirmed",
    outcome: "unknown",
    context: context.success ? context.data : { providerId: identity.providerId },
    ...(cleanupReason ? { metadata: { cleanupReason } } : {}),
  };
}

function runOwnerKey(identity: { runId: string; turnId: string }): string {
  return JSON.stringify([identity.runId, identity.turnId]);
}

function notify(
  listener: ((identity: ProviderRunIdentity, cleanupReason?: PosixCleanupFailureReason) => void) | undefined,
  identity: ProviderRunIdentity,
  cleanupReason?: PosixCleanupFailureReason,
): void {
  try {
    listener?.(identity, cleanupReason);
  } catch {
    return;
  }
}

interface CleanupReceipt {
  identity: ProviderRunIdentity;
  confirmed: boolean;
}

export class ProviderRunCleanupLedger {
  private readonly receipts = new Map<string, CleanupReceipt>();
  private readonly unconfirmed = new Map<string, ProviderRunIdentity>();

  constructor(
    private readonly onUnconfirmed?: (
      identity: ProviderRunIdentity,
      cleanupReason?: PosixCleanupFailureReason,
    ) => void,
    private readonly onConfirmedLate?: (identity: ProviderRunIdentity) => void,
  ) {}

  confirmed(identity: ProviderRunIdentity): void {
    const confirmedLate = this.unconfirmed.delete(runOwnerKey(identity));
    const receipt = this.receipts.get(identity.conversationId);
    if (
      receipt
      && receipt.identity.runId === identity.runId
      && receipt.identity.turnId === identity.turnId
    ) {
      receipt.confirmed = true;
    } else if (!confirmedLate) {
      this.remember(identity, true);
    }
    if (confirmedLate) notify(this.onConfirmedLate, identity);
  }

  detached(identity: ProviderRunIdentity, cleanupReason?: PosixCleanupFailureReason): void {
    this.unconfirmed.set(runOwnerKey(identity), identity);
    this.remember(identity, false);
    notify(this.onUnconfirmed, identity, cleanupReason);
  }

  lateConfirmed(identity: ProviderRunIdentity): void {
    if (this.unconfirmed.has(runOwnerKey(identity))) this.confirmed(identity);
  }

  observeLateCleanup(
    identity: ProviderRunIdentity,
    confirmation: Promise<boolean> | undefined,
  ): void {
    void boundedCleanupConfirmation(confirmation).then((confirmed) => {
      if (confirmed) this.lateConfirmed(identity);
    });
  }

  receipt(
    conversationId: string,
    identity: { runId: string; turnId: string },
  ): "settled" | "force-detached" | null {
    const receipt = this.receipts.get(conversationId);
    if (
      !receipt
      || receipt.identity.runId !== identity.runId
      || receipt.identity.turnId !== identity.turnId
    ) return null;
    return receipt.confirmed ? "settled" : "force-detached";
  }

  forget(conversationId: string): void {
    this.receipts.delete(conversationId);
  }

  allConfirmed(): boolean {
    return this.unconfirmed.size === 0;
  }

  private remember(identity: ProviderRunIdentity, confirmed: boolean): void {
    this.receipts.delete(identity.conversationId);
    this.receipts.set(identity.conversationId, { identity, confirmed });
    while (this.receipts.size > MAX_CLEANUP_RECEIPTS) {
      const oldest = this.receipts.keys().next().value;
      if (oldest === undefined) break;
      this.receipts.delete(oldest);
    }
  }
}
