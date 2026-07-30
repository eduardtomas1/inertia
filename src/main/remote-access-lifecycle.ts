import WebSocket from "ws";

import { REMOTE_LIMITS } from "../shared/remote-protocol";
import { takeRemoteRate } from "./remote-access-policy";

export const REMOTE_SHUTDOWN_TIMEOUT_MS = 1_500;

export class RemoteSessionAuthenticationBudget {
  private readonly globalTimes: number[] = [];
  private readonly timesByConnection = new Map<string, number[]>();

  take(connectionId: string, now: number): boolean {
    let connectionTimes = this.timesByConnection.get(connectionId);
    if (!connectionTimes) {
      if (
        this.timesByConnection.size
        >= REMOTE_LIMITS.sessionAuthenticationAttemptsPerMinute
      ) {
        const oldest = this.timesByConnection.keys().next().value;
        if (oldest) this.timesByConnection.delete(oldest);
      }
      connectionTimes = [];
      this.timesByConnection.set(connectionId, connectionTimes);
    }
    return takeRemoteRate(
      connectionTimes,
      REMOTE_LIMITS.sessionAuthenticationAttemptsPerConnection,
      now,
    ) && takeRemoteRate(
      this.globalTimes,
      REMOTE_LIMITS.sessionAuthenticationAttemptsPerMinute,
      now,
    );
  }

  drop(connectionId: string): void {
    this.timesByConnection.delete(connectionId);
  }

  clear(): void {
    this.timesByConnection.clear();
    this.globalTimes.length = 0;
  }
}

export async function closeRemoteSocket(
  socket: WebSocket | null,
  setTimer: typeof setTimeout = setTimeout,
  clearTimer: typeof clearTimeout = clearTimeout,
  timeoutMs = REMOTE_SHUTDOWN_TIMEOUT_MS,
): Promise<void> {
  if (!socket || socket.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (terminate: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimer(timer);
      socket.off("close", onClose);
      socket.off("error", onError);
      if (terminate) {
        try {
          socket.terminate();
        } catch {
          // The socket is already unusable.
        }
      }
      resolve();
    };
    const onClose = (): void => finish(false);
    const onError = (): void => finish(true);
    socket.once("close", onClose);
    socket.once("error", onError);
    timer = setTimer(() => finish(true), timeoutMs);
  });
}
