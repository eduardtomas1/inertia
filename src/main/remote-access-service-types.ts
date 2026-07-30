import type WebSocket from "ws";

import type {
  RemoteRecipientState,
  RemoteSenderState,
} from "../shared/remote-crypto";
import type {
  RemoteAccessState,
  RemoteAuthorizationSubject,
  RemotePairingRequestPayload,
  RemoteRequest,
} from "../shared/remote-protocol";
import type { PersistedRemoteDevice, RemoteAccessStore } from "./remote-access-store";
import type { RuntimeSupervisor } from "./runtime-supervisor";

export interface PendingRemotePairing {
  connectionId: string;
  payload: RemotePairingRequestPayload;
  receivedAt: string;
  expiresAt: string;
  comparisonCode: string;
}

export interface ActiveRemoteSession {
  connectionId: string;
  sessionId: string;
  device: PersistedRemoteDevice;
  recipient: RemoteRecipientState;
  sender: RemoteSenderState;
  subject: RemoteAuthorizationSubject;
  createdAt: number;
  lastActivityAt: number;
  requestTimes: number[];
  promptTimes: number[];
  inFlight: Map<string, RemoteRequest>;
}

export interface RemoteAccessServiceOptions {
  store: RemoteAccessStore;
  runtime: Pick<RuntimeSupervisor, "remoteRequest">;
  onStateChange?: (state: RemoteAccessState) => void;
  now?: () => Date;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  createSocket?: (url: string) => WebSocket;
}
