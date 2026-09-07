import { beforeTerminalDeadline } from "./terminal-deadline";

interface TerminalOwnershipDeadline {
  readonly shutdownDeadlineAt: number | null;
  readonly waitForShutdownDeadline: Promise<number>;
  confirmOwnedProcessStopped(): boolean;
  waitForOwnedGuardianStop(): Promise<boolean>;
}

export async function waitForBooleanWithinTerminalDeadline(
  operation: Promise<boolean>,
  session: TerminalOwnershipDeadline,
  localDeadlineAt: number | null,
): Promise<boolean> {
  if (session.shutdownDeadlineAt !== null) {
    return await beforeTerminalDeadline(
      operation,
      localDeadlineAt === null
        ? session.shutdownDeadlineAt
        : Math.min(localDeadlineAt, session.shutdownDeadlineAt),
    );
  }
  const boundedOperation = localDeadlineAt === null
    ? operation.catch(() => false)
    : beforeTerminalDeadline(operation, localDeadlineAt);
  const first = await Promise.race([
    boundedOperation.then((value) => ({ kind: "operation" as const, value })),
    session.waitForShutdownDeadline.then((deadlineAt) => ({
      kind: "deadline" as const,
      deadlineAt,
    })),
  ]);
  return first.kind === "operation"
    ? first.value
    : await beforeTerminalDeadline(
        operation,
        localDeadlineAt === null
          ? first.deadlineAt
          : Math.min(localDeadlineAt, first.deadlineAt),
      );
}

export async function waitForGuardianStopWithinDeadline(
  session: TerminalOwnershipDeadline,
  localDeadlineAt: number | null,
): Promise<boolean> {
  return await waitForBooleanWithinTerminalDeadline(
    session.waitForOwnedGuardianStop(),
    session,
    localDeadlineAt,
  );
}

export async function waitForOwnedProcessStoppedWithinDeadline(
  session: TerminalOwnershipDeadline,
  fallbackWaitMs: number,
  localDeadlineAt: number | null = null,
): Promise<boolean> {
  const initialDeadlineAt = localDeadlineAt
    ?? session.shutdownDeadlineAt
    ?? Date.now() + fallbackWaitMs;
  while (!session.confirmOwnedProcessStopped()) {
    const deadlineAt = session.shutdownDeadlineAt === null
      ? initialDeadlineAt
      : Math.min(initialDeadlineAt, session.shutdownDeadlineAt);
    const remainingMs = Math.trunc(deadlineAt - Date.now());
    if (remainingMs <= 0) return false;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.min(10, remainingMs));
      timer.unref();
    });
  }
  return true;
}
