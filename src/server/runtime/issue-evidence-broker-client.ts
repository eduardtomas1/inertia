import { randomUUID } from "node:crypto";

import type { IssueHostEvidence, RuntimeIssueEvidenceResult } from "../../node/runtime-issue-evidence-protocol.js";
import type { RuntimeWorkerEvent } from "../../node/runtime-process-protocol.js";

const DEFAULT_TIMEOUT_MS = 10_000;

export interface RuntimeIssueEvidenceSource {
  collect(attachDiagnostics: boolean): Promise<IssueHostEvidence | null>;
}

export class RuntimeIssueEvidenceBrokerClient implements RuntimeIssueEvidenceSource {
  private readonly pending = new Map<string, { timer: NodeJS.Timeout; resolve(value: IssueHostEvidence | null): void }>();
  private closed = false;

  constructor(
    private readonly post: (event: RuntimeWorkerEvent) => void,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  collect(attachDiagnostics: boolean): Promise<IssueHostEvidence | null> {
    if (this.closed || this.pending.size >= 2) return Promise.resolve(null);
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.settle(requestId, null), this.timeoutMs);
      this.pending.set(requestId, { timer, resolve });
      this.post({ type: "runtime.issue-evidence-request", requestId, attachDiagnostics });
    });
  }

  handle(result: RuntimeIssueEvidenceResult): boolean {
    return this.settle(result.requestId, result.ok ? result.evidence : null);
  }

  close(): void {
    this.closed = true;
    for (const requestId of this.pending.keys()) this.settle(requestId, null);
  }

  private settle(requestId: string, value: IssueHostEvidence | null): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(value);
    return true;
  }
}
