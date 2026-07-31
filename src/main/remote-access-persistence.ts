import { randomUUID } from "node:crypto";

import {
  REMOTE_LIMITS,
  type RemoteAuditEvent,
} from "../shared/remote-protocol";
import { sanitizeRemoteLabel } from "../shared/remote-sanitizer";
import { trimRemoteArray } from "./remote-access-policy";
import type {
  PersistedRemoteAccess,
  RemoteAccessStore,
} from "./remote-access-store";

export class RemoteAccessPersistenceQueue {
  private queue: Promise<void> = Promise.resolve();
  private failed = false;

  constructor(
    private readonly store: RemoteAccessStore,
    private readonly onFailure: () => void,
  ) {}

  save(data: PersistedRemoteAccess): Promise<void> {
    trimRemoteArray(data.audit, REMOTE_LIMITS.auditEvents);
    trimRemoteArray(data.receipts, REMOTE_LIMITS.deliveryReceipts);
    const snapshot = structuredClone(data);
    const pending = this.queue.then(async () => {
      await this.store.save(snapshot);
    }).catch((error: unknown) => {
      if (!this.failed) {
        this.failed = true;
        try {
          this.onFailure();
        } catch {
          // Preserve the durable write error for the caller.
        }
      }
      throw error;
    });
    this.queue = pending;
    return pending;
  }

  async drain(): Promise<void> {
    await this.queue.catch(() => undefined);
  }
}

export function appendRemoteAudit(
  data: PersistedRemoteAccess,
  type: RemoteAuditEvent["type"],
  deviceId: string | null,
  detail: string,
  now: Date,
): void {
  data.audit.push({
    id: randomUUID(),
    type,
    deviceId,
    detail: sanitizeRemoteLabel(detail, 240) ?? "Remote event.",
    createdAt: now.toISOString(),
  });
  trimRemoteArray(data.audit, REMOTE_LIMITS.auditEvents);
}
