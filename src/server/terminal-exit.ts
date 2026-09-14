interface TerminalExitObservation {
  readonly exitObserved: boolean;
  readonly exitWaiters: Set<() => void>;
}

/** Cancel the local PTY wait when a tighter enclosing deadline settles. */
export function waitForTerminalExit(
  session: TerminalExitObservation,
  waitMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  if (session.exitObserved) return Promise.resolve(true);
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (didExit: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      session.exitWaiters.delete(observeExit);
      signal?.removeEventListener("abort", cancel);
      resolve(didExit);
    };
    const observeExit = (): void => finish(true);
    const cancel = (): void => finish(false);
    session.exitWaiters.add(observeExit);
    const timer = setTimeout(() => finish(false), waitMs);
    signal?.addEventListener("abort", cancel, { once: true });
  });
}
