import WebSocket from "ws";

import {
  sealSessionData,
  type RemoteSenderState,
} from "../shared/remote-crypto";
import {
  REMOTE_LIMITS,
  type RemoteCipherFrame,
  type RemoteResponse,
} from "../shared/remote-protocol";
import { takeRemoteRate } from "./remote-access-policy";

export const REMOTE_SHUTDOWN_TIMEOUT_MS = 1_500;

type RemotePowerEvent = "lock-screen" | "suspend" | "unlock-screen";

export interface RemotePowerEvents {
  getSystemIdleState?(
    idleThreshold: number,
  ): "active" | "idle" | "locked" | "unknown";
  on(event: RemotePowerEvent, listener: () => void): unknown;
  off(event: RemotePowerEvent, listener: () => void): unknown;
}

export class RemotePrivacyMonitor {
  private value = true;
  private observedPowerEvent = false;
  private stopped = false;

  constructor(
    private readonly events: RemotePowerEvents,
    private readonly onChange: (locked: boolean) => void,
  ) {
    events.on("lock-screen", this.lock);
    events.on("suspend", this.lock);
    events.on("unlock-screen", this.unlock);
    const sampledLocked = initialPrivacyLocked(events);
    if (!this.observedPowerEvent || sampledLocked) {
      this.value = sampledLocked;
    }
  }

  get locked(): boolean {
    return this.value;
  }

  shutdown(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.events.off("lock-screen", this.lock);
    this.events.off("suspend", this.lock);
    this.events.off("unlock-screen", this.unlock);
  }

  private readonly lock = (): void => {
    this.observedPowerEvent = true;
    this.update(true);
  };

  private readonly unlock = (): void => {
    this.observedPowerEvent = true;
    this.update(false);
  };

  private update(locked: boolean): void {
    if (this.stopped || this.value === locked) return;
    this.value = locked;
    this.onChange(locked);
  }
}

function initialPrivacyLocked(events: RemotePowerEvents): boolean {
  if (typeof events.getSystemIdleState !== "function") return false;
  try {
    const state = events.getSystemIdleState(60);
    return state === "locked" || state === "unknown";
  } catch {
    // Older or unsupported Electron platforms may expose no usable probe.
    // Future lock/suspend events still enforce the privacy boundary.
    return false;
  }
}

interface RemoteOutboundSession {
  connectionId: string;
  sessionId: string;
  sender: RemoteSenderState;
  outboundTail: Promise<void>;
}

export async function sendSequencedRemoteResponse(
  session: RemoteOutboundSession,
  response: RemoteResponse,
  isCurrent: () => boolean,
  send: (
    connectionId: string,
    frame: Extract<RemoteCipherFrame, { kind: "session.data" }>,
  ) => void,
): Promise<void> {
  const sending = session.outboundTail.catch(() => undefined).then(async () => {
    if (!isCurrent()) return;
    send(session.connectionId, await sealSessionData(
      session.sender,
      session.sessionId,
      response,
    ));
  });
  session.outboundTail = sending;
  await sending;
}

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

export function terminateRemoteSocket(socket: WebSocket | null): void {
  if (!socket) return;
  try {
    socket.terminate();
  } catch {
    // The socket is already unusable.
  }
}
