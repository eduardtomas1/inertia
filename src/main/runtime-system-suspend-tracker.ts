import { randomUUID } from "node:crypto";

import type { RuntimeSystemSuspendInterval } from "../node/runtime-process-protocol";

const MAX_RETAINED_INTERVALS = 64;

function normalizedTimestamp(value: string, label: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error(`${label} is invalid.`);
  return new Date(milliseconds).toISOString();
}

/** Retains trusted desktop suspend windows across local runtime generations. */
export class RuntimeSystemSuspendTracker {
  private active: { id: string; suspendedAt: string } | null = null;
  private readonly intervals: RuntimeSystemSuspendInterval[] = [];

  suspend(at = new Date().toISOString()): void {
    if (this.active) return;
    const requestedSuspend = normalizedTimestamp(at, "The system suspend time");
    const previousResume = this.intervals.at(-1)?.resumedAt;
    this.active = {
      id: randomUUID(),
      suspendedAt: previousResume
        ? new Date(Math.max(
            Date.parse(requestedSuspend),
            Date.parse(previousResume),
          )).toISOString()
        : requestedSuspend,
    };
  }

  resume(at = new Date().toISOString()): RuntimeSystemSuspendInterval | null {
    const suspended = this.active;
    if (!suspended) return null;
    const requestedResume = normalizedTimestamp(at, "The system resume time");
    this.active = null;
    const interval = {
      ...suspended,
      resumedAt: new Date(Math.max(
        Date.parse(requestedResume),
        Date.parse(suspended.suspendedAt),
      )).toISOString(),
    };
    this.intervals.push(interval);
    if (this.intervals.length > MAX_RETAINED_INTERVALS) {
      this.intervals.splice(0, this.intervals.length - MAX_RETAINED_INTERVALS);
    }
    return interval;
  }

  completed(): readonly RuntimeSystemSuspendInterval[] {
    return this.intervals;
  }
}
