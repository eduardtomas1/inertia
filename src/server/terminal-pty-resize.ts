/**
 * Resize a PTY without letting node-pty crash the runtime.
 *
 * On Windows, node-pty queues every `resize` issued before the first output
 * byte and replays the queue inside its own socket `data` handler. If the
 * process exits before producing output (a fast-exiting command), that replay
 * throws "Cannot resize a pty that has already exited" as an uncaught
 * exception no caller can intercept. Hold the size until output proves
 * readiness, then apply it on a fresh tick where a failure is catchable and an
 * observed exit simply drops the stale request.
 */

export interface PtyResizeTarget {
  pty: { resize(cols: number, rows: number): void };
  readonly outputObserved: boolean;
  readonly exitObserved: boolean;
  pendingResize: { cols: number; rows: number } | null;
}

/** Returns false when the PTY can no longer be resized. */
export function resizePty(
  platform: NodeJS.Platform,
  target: PtyResizeTarget,
  cols: number,
  rows: number,
): boolean {
  if (target.exitObserved) return false;
  if (platform === "win32" && !target.outputObserved) {
    target.pendingResize = { cols, rows };
    return true;
  }
  // A resize after first output supersedes any request held for the readiness
  // tick; otherwise that older callback can overwrite the new dimensions.
  target.pendingResize = null;
  try {
    target.pty.resize(cols, rows);
    return true;
  } catch {
    return false;
  }
}

/** Call once the first output byte arrives; applies any held resize. */
export function applyPendingPtyResize(target: PtyResizeTarget): void {
  const pending = target.pendingResize;
  if (!pending) return;
  setImmediate(() => {
    if (target.pendingResize !== pending || target.exitObserved) return;
    target.pendingResize = null;
    try {
      target.pty.resize(pending.cols, pending.rows);
    } catch {
      // The process exited between readiness and this tick; the terminal
      // exit path already owns the outcome and nothing depends on the size.
    }
  });
}
