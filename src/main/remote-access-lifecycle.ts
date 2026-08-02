import WebSocket from "ws";

import {
  sealSessionData,
  type RemoteSenderState,
} from "../shared/remote-crypto";
import {
  REMOTE_LIMITS,
  type RemoteCipherFrame,
  type RemoteResponse,
  type RemoteSessionAuthorityChangedPayload,
} from "../shared/remote-protocol";
import { takeRemoteRate } from "./remote-access-policy";
import type { RemotePrivacySuspension } from "./remote-access-service-types";

export const REMOTE_SHUTDOWN_TIMEOUT_MS = 1_500;
export const REMOTE_MAX_BUFFERED_BYTES = 2 * REMOTE_LIMITS.relayEnvelopeBytes;

type RemotePowerEvent = "lock-screen" | "suspend" | "unlock-screen";

export interface RemotePowerEvents {
  getSystemIdleState?(
    idleThreshold: number,
  ): "active" | "idle" | "locked" | "unknown";
  on(event: RemotePowerEvent, listener: () => void): unknown;
  off(event: RemotePowerEvent, listener: () => void): unknown;
}

export const REMOTE_PRIVACY_LOCKED_MESSAGE =
  "Remote Companion is paused while the desktop is locked.";
export const REMOTE_PRIVACY_UNVERIFIED_MESSAGE =
  "Remote Companion is paused because Inertia could not verify that this "
  + "desktop is unlocked.";

type RemotePrivacyProbe =
  | { kind: "locked" | "unlocked" }
  | { kind: "unknown"; detail: string };

export class RemotePrivacyMonitor {
  private value = true;
  private verified = false;
  private observedPowerEvent = false;
  private stopped = false;
  private probeDetail: string | null = null;

  constructor(
    private readonly events: RemotePowerEvents,
    private readonly onChange: (
      locked: boolean,
      suspension: RemotePrivacySuspension | null,
    ) => void,
    onDiagnostic?: (detail: string) => void,
  ) {
    events.on("lock-screen", this.lock);
    events.on("suspend", this.lock);
    events.on("unlock-screen", this.unlock);
    const probe = probeRemotePrivacyState(events);
    const sampledLocked = probe.kind !== "unlocked";
    if (!this.observedPowerEvent || sampledLocked) {
      this.value = sampledLocked;
    }
    if (probe.kind === "unknown") this.probeDetail = probe.detail;
    else this.verified = true;
    if (this.observedPowerEvent) this.verified = true;
    if (probe.kind === "unknown" && !this.verified) onDiagnostic?.(probe.detail);
  }

  get locked(): boolean {
    return this.value;
  }

  get lockStateVerified(): boolean {
    return this.verified;
  }

  get probeDiagnostic(): string | null {
    return this.verified ? null : this.probeDetail;
  }

  get suspension(): RemotePrivacySuspension | null {
    if (!this.value) return null;
    return this.verified ? "locked" : "unverified";
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
    this.verified = true;
    this.update(true);
  };

  private readonly unlock = (): void => {
    this.observedPowerEvent = true;
    const wasUnverified = !this.verified;
    this.verified = true;
    if (wasUnverified && !this.stopped && !this.value) {
      this.onChange(false, null);
    }
    this.update(false);
  };

  private update(locked: boolean): void {
    if (this.stopped || this.value === locked) return;
    this.value = locked;
    this.onChange(locked, this.suspension);
  }
}

function probeRemotePrivacyState(events: RemotePowerEvents): RemotePrivacyProbe {
  if (typeof events.getSystemIdleState !== "function") {
    return {
      kind: "unknown",
      detail: "This platform exposes no desktop lock-state probe.",
    };
  }
  try {
    const state = events.getSystemIdleState(60);
    if (state === "locked") return { kind: "locked" };
    if (state === "active" || state === "idle") return { kind: "unlocked" };
    return {
      kind: "unknown",
      detail: `The desktop lock-state probe reported "${String(state)}".`,
    };
  } catch {
    return {
      kind: "unknown",
      detail: "The desktop lock-state probe failed.",
    };
  }
}

interface RemoteOutboundSession {
  connectionId: string;
  sessionId: string;
  sender: RemoteSenderState;
  outboundTail: Promise<void>;
  outboundAbandoned: boolean;
}

interface RemoteAuthoritySession extends RemoteOutboundSession {
  connectionEpoch: number;
  device: { id: string };
  supportsAuthenticatedRejection: boolean;
}

export async function sendSequencedRemoteResponse(
  session: RemoteOutboundSession,
  response: RemoteResponse | RemoteSessionAuthorityChangedPayload,
  isCurrent: () => boolean,
  send: (
    connectionId: string,
    frame: Extract<RemoteCipherFrame, { kind: "session.data" }>,
  ) => void,
): Promise<void> {
  const sending = session.outboundTail.catch(() => undefined).then(async () => {
    if (session.outboundAbandoned || !isCurrent()) return;
    const frame = await sealSessionData(
      session.sender,
      session.sessionId,
      response,
    );
    if (session.outboundAbandoned || !isCurrent()) {
      session.outboundAbandoned = true;
      return;
    }
    send(session.connectionId, frame);
  });
  session.outboundTail = sending;
  await sending;
}

export async function sendRemoteAuthorityInvalidation(
  sessions: Iterable<RemoteAuthoritySession>,
  deviceId: string,
  serverTime: string,
  isCurrent: (session: RemoteAuthoritySession) => boolean,
  send: (
    connectionId: string,
    frame: Extract<RemoteCipherFrame, { kind: "session.data" }>,
  ) => void,
): Promise<void> {
  await Promise.all([...sessions].map(async (session) => {
    if (
      session.device.id !== deviceId
      || !session.supportsAuthenticatedRejection
    ) return;
    await sendSequencedRemoteResponse(
      session,
      { type: "session.authority-changed", serverTime },
      () => isCurrent(session),
      send,
    );
  }));
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
