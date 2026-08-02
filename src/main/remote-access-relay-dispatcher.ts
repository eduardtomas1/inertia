import type { RawData } from "ws";

import {
  REMOTE_LIMITS,
  encodedRemoteFrameBytes,
  relayServerMessageSchema,
  type RelayServerMessage,
  type RemoteCipherFrame,
} from "../shared/remote-protocol";
import {
  remoteRawDataByteLength,
  remoteRawDataText,
} from "./remote-access-policy";

export type RemoteConnectionEpoch = number;

interface RemoteRelayDispatcherHandlers {
  hello?(message: Extract<RelayServerMessage, { type: "relay.hello" }>): void;
  challenge?(
    message: Extract<RelayServerMessage, { type: "relay.register.challenge" }>,
  ): void;
  registered(
    message: Extract<RelayServerMessage, { type: "relay.registered" }>,
  ): void;
  incompatible?(
    message: Extract<RelayServerMessage, { type: "relay.incompatible" }>,
  ): void;
  peerConnected?(
    message: Extract<RelayServerMessage, { type: "relay.peer-connected" }>,
  ): void;
  error(code: Extract<RelayServerMessage, { type: "relay.error" }>["code"]): void;
  frame(
    connectionId: string,
    epoch: RemoteConnectionEpoch,
    frame: RemoteCipherFrame,
  ): Promise<void>;
  invalidated(connectionId: string, epoch: RemoteConnectionEpoch): void;
  disconnected(connectionId: string, epoch: RemoteConnectionEpoch): void;
  rejected(connectionId: string): void;
  oversized(): void;
}

interface QueuedRemoteFrame {
  epoch: RemoteConnectionEpoch;
  frame: RemoteCipherFrame;
}

export class RemoteRelayDispatcher {
  private readonly epochs = new Map<string, RemoteConnectionEpoch>();
  private readonly tails = new Map<string, Promise<void>>();
  private readonly depths = new Map<string, number>();
  private nextEpoch = 0;

  constructor(private readonly handlers: RemoteRelayDispatcherHandlers) {}

  receive(raw: RawData): void {
    if (remoteRawDataByteLength(raw) > REMOTE_LIMITS.relayEnvelopeBytes) {
      this.handlers.oversized();
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(remoteRawDataText(raw)) as unknown;
    } catch {
      return;
    }
    const parsed = relayServerMessageSchema.safeParse(value);
    if (!parsed.success) return;
    const message = parsed.data;
    if (message.type === "relay.hello") {
      this.handlers.hello?.(message);
      return;
    }
    if (message.type === "relay.register.challenge") {
      this.handlers.challenge?.(message);
      return;
    }
    if (message.type === "relay.registered") {
      this.handlers.registered(message);
      return;
    }
    if (message.type === "relay.incompatible") {
      this.handlers.incompatible?.(message);
      return;
    }
    if (message.type === "relay.error") {
      this.handlers.error(message.code);
      return;
    }
    if (message.type === "relay.peer-connected") {
      this.activate(message.connectionId, message.endpointEpoch);
      this.handlers.peerConnected?.(message);
      return;
    }
    if (message.type === "relay.peer-disconnected") {
      this.deactivate(message.connectionId, message.endpointEpoch);
      return;
    }
    if (message.type !== "relay.frame") return;
    const epoch = this.epochs.get(message.connectionId);
    if (epoch === undefined || epoch !== message.endpointEpoch) return;
    if (encodedRemoteFrameBytes(message.frame) > REMOTE_LIMITS.encryptedFrameBytes) {
      this.deactivate(message.connectionId, message.endpointEpoch);
      return;
    }
    this.enqueue(message.connectionId, { epoch, frame: message.frame });
  }

  owns(connectionId: string, epoch: RemoteConnectionEpoch): boolean {
    return this.epochs.get(connectionId) === epoch;
  }

  invalidate(connectionId: string, epoch: RemoteConnectionEpoch): void {
    if (!this.owns(connectionId, epoch)) return;
    this.epochs.delete(connectionId);
    this.handlers.invalidated(connectionId, epoch);
  }

  reset(): void {
    for (const [connectionId, epoch] of this.epochs) {
      this.invalidate(connectionId, epoch);
    }
  }

  private activate(
    connectionId: string,
    endpointEpoch: RemoteConnectionEpoch,
  ): void {
    const previous = this.epochs.get(connectionId);
    if (previous !== undefined) {
      this.invalidate(connectionId, previous);
      this.enqueueDisconnect(connectionId, previous);
    }
    if (this.epochs.size >= REMOTE_LIMITS.connections) {
      this.handlers.rejected(connectionId);
      return;
    }
    this.nextEpoch = Math.max(this.nextEpoch, endpointEpoch);
    this.epochs.set(connectionId, endpointEpoch);
  }

  private deactivate(
    connectionId: string,
    endpointEpoch: RemoteConnectionEpoch,
  ): void {
    const epoch = this.epochs.get(connectionId);
    if (epoch === undefined || epoch !== endpointEpoch) return;
    this.invalidate(connectionId, epoch);
    this.enqueueDisconnect(connectionId, epoch);
  }

  private enqueue(connectionId: string, value: QueuedRemoteFrame): void {
    this.enqueueWork(connectionId, async () => {
      if (!this.owns(connectionId, value.epoch)) return;
      await this.handlers.frame(connectionId, value.epoch, value.frame);
    }, value.epoch);
  }

  private enqueueDisconnect(
    connectionId: string,
    epoch: RemoteConnectionEpoch,
  ): void {
    this.enqueueWork(connectionId, async () => {
      this.handlers.disconnected(connectionId, epoch);
    }, epoch);
  }

  private enqueueWork(
    connectionId: string,
    work: () => Promise<void>,
    epoch: RemoteConnectionEpoch,
  ): void {
    const depth = this.depths.get(connectionId) ?? 0;
    if (depth >= REMOTE_LIMITS.queuedFramesPerConnection) {
      this.invalidate(connectionId, epoch);
      this.handlers.disconnected(connectionId, epoch);
      return;
    }
    this.depths.set(connectionId, depth + 1);
    const previous = this.tails.get(connectionId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(work).catch(() => {
      this.invalidate(connectionId, epoch);
      this.handlers.disconnected(connectionId, epoch);
    }).finally(() => {
      const remaining = (this.depths.get(connectionId) ?? 1) - 1;
      if (remaining > 0) this.depths.set(connectionId, remaining);
      else this.depths.delete(connectionId);
      if (this.tails.get(connectionId) === current) {
        this.tails.delete(connectionId);
      }
    });
    this.tails.set(connectionId, current);
  }
}
