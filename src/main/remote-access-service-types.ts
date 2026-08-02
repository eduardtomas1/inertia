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

export type RemotePrivacySuspension = "locked" | "unverified";

export interface PendingRemotePairing {
  connectionId: string;
  connectionEpoch: number;
  payload: RemotePairingRequestPayload;
  receivedAt: string;
  expiresAt: string;
  comparisonCode: string;
}

export interface ActiveRemoteSession {
  connectionId: string;
  connectionEpoch: number;
  sessionId: string;
  device: PersistedRemoteDevice;
  recipient: RemoteRecipientState;
  sender: RemoteSenderState;
  subject: RemoteAuthorizationSubject;
  supportsAuthenticatedRejection: boolean;
  supportsConditionalProjections: boolean;
  createdAt: number;
  lastActivityAt: number;
  requestTimes: number[];
  promptTimes: number[];
  inFlight: Map<string, RemoteRequest>;
  postedPromptDeliveries: Set<string>;
  outboundTail: Promise<void>;
  outboundAbandoned: boolean;
}

export interface RemoteAccessServiceOptions {
  store: RemoteAccessStore;
  runtime: Pick<RuntimeSupervisor, "remoteRequest">
    & Partial<Pick<
      RuntimeSupervisor,
      "prepareRemotePrompt" | "commitRemotePrompt" | "forgetRemoteTranscripts"
    >>;
  onStateChange?: (state: RemoteAccessState) => void;
  autoConnect?: boolean;
  initialPrivacy?: RemotePrivacySuspension | null;
  now?: () => Date;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  createSocket?: (url: string) => WebSocket;
}
