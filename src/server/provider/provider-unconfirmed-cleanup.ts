import type { ChildProcess } from "node:child_process";

import {
  lateCleanupConfirmation,
  posixCleanupDiagnosticFor,
  providerCleanupConfirmationBudgetMs,
} from "../process-lifecycle";
import type { PosixCleanupFailureReason } from "../posix-cleanup-diagnostics";

export interface ProviderUnconfirmedCleanup {
  readonly cleanupConfirmation: Promise<boolean>;
  readonly cleanupReason?: PosixCleanupFailureReason;
}

export function providerUnconfirmedCleanup(child: ChildProcess): ProviderUnconfirmedCleanup {
  const cleanupReason = posixCleanupDiagnosticFor(child)?.reason;
  return {
    cleanupConfirmation: lateCleanupConfirmation(child, providerCleanupConfirmationBudgetMs()),
    ...(cleanupReason ? { cleanupReason } : {}),
  };
}
