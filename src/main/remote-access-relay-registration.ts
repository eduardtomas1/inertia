import {
  RELAY_PROTOCOL_VERSION,
  REMOTE_DESKTOP_COMPATIBILITY,
  REMOTE_PROTOCOL_VERSION,
  type RelayClientMessage,
  type RelayEndpointChallenge,
  type RelayIncompatibility,
  type RelayServerMessage,
} from "../shared/remote-protocol";
import {
  signRemoteEndpointChallenge,
  type RemoteEndpointKeyPair,
} from "./remote-access-endpoint-auth";
import type { PersistedRemoteAccess } from "./remote-access-store";

type RelayHello = Extract<RelayServerMessage, { type: "relay.hello" }>;
type RelayChallenge = Extract<
  RelayServerMessage,
  { type: "relay.register.challenge" }
>;
type RelayRegistered = Extract<RelayServerMessage, { type: "relay.registered" }>;

// The relay remains the nonce/TTL authority; this bounds implausible peer clocks.
export const REMOTE_RELAY_CHALLENGE_CLOCK_SKEW_MS = 30_000;
export const REMOTE_RELAY_CHALLENGE_TTL_MS = 5_000;

export interface RegisteredRemoteRelay {
  relayVersion: string;
  desktopVersion: string;
  relayProtocol: number;
  remoteProtocol: number;
  endpointAuthentication: "required" | "migration";
  persistence: "durable" | "ephemeral";
  endpointEpoch: number;
  connectedAt: string;
}

export class RemoteRelayRegistration {
  private helloMessage: RelayHello | null = null;

  constructor(private readonly options: {
    data(): PersistedRemoteAccess;
    endpointKeyPair(): RemoteEndpointKeyPair;
    now(): Date;
    persist(): Promise<void>;
    send(message: RelayClientMessage): void;
    reject(message: string): void;
    online(input: RegisteredRemoteRelay): void;
  }) {}

  hello(): RelayHello | null {
    return this.helloMessage;
  }

  reset(): void {
    this.helloMessage = null;
  }

  begin(message: RelayHello): void {
    const data = this.options.data();
    const relayBinding = data.relayBinding ?? null;
    const identityChanged = relayBinding !== null
      && relayBinding.relayIdentity !== message.relayIdentity;
    if (
      this.helloMessage !== null
      || message.endpointAuthentication !== "required"
      || message.relayProtocol.minimum > RELAY_PROTOCOL_VERSION
      || message.relayProtocol.maximum < RELAY_PROTOCOL_VERSION
      || message.remoteProtocol.minimum > REMOTE_PROTOCOL_VERSION
      || message.remoteProtocol.maximum < REMOTE_PROTOCOL_VERSION
      || identityChanged
    ) {
      this.options.reject(identityChanged
        ? "The relay identity changed. Configure a fresh endpoint and re-pair."
        : "The relay does not support endpoint-authenticated protocol v2.");
      return;
    }
    this.helloMessage = message;
    const endpointPublicKey = this.options.endpointKeyPair().publicKey;
    this.options.send(relayBinding === null
      ? {
          relayProtocolVersion: RELAY_PROTOCOL_VERSION,
          type: "relay.claim.begin",
          endpointId: data.endpointId,
          endpointPublicKey,
          desktop: REMOTE_DESKTOP_COMPATIBILITY,
        }
      : {
          relayProtocolVersion: RELAY_PROTOCOL_VERSION,
          type: "relay.register.begin",
          endpointId: data.endpointId,
          desktop: REMOTE_DESKTOP_COMPATIBILITY,
        });
  }

  prove(message: RelayChallenge, timeoutMs: number): void {
    const data = this.options.data();
    const hello = this.helloMessage;
    const relayBinding = data.relayBinding ?? null;
    const purpose = relayBinding === null ? "claim" : "register";
    const epoch = relayBinding === null ? 1 : relayBinding.epoch + 1;
    const transportNow = Date.now();
    const estimatedRelayNow = message.expiresAt
      - REMOTE_RELAY_CHALLENGE_TTL_MS;
    const clockDifference = Math.abs(estimatedRelayNow - transportNow);
    if (
      !hello
      || message.relayIdentity !== hello.relayIdentity
      || message.endpointId !== data.endpointId
      || message.endpointPublicKey !== this.options.endpointKeyPair().publicKey
      || message.purpose !== purpose
      || (purpose === "claim" ? message.epoch !== epoch : message.epoch < epoch)
      || timeoutMs < REMOTE_RELAY_CHALLENGE_TTL_MS
      || clockDifference > REMOTE_RELAY_CHALLENGE_CLOCK_SKEW_MS
    ) {
      this.options.reject("The relay endpoint challenge was invalid.");
      return;
    }
    const challenge: RelayEndpointChallenge = {
      purpose: message.purpose,
      relayIdentity: message.relayIdentity,
      endpointId: message.endpointId,
      endpointPublicKey: message.endpointPublicKey,
      nonce: message.nonce,
      epoch: message.epoch,
      expiresAt: message.expiresAt,
    };
    this.options.send(signRemoteEndpointChallenge(
      challenge,
      this.options.endpointKeyPair(),
    ));
  }

  async accept(message: RelayRegistered): Promise<void> {
    const data = this.options.data();
    const hello = this.helloMessage;
    const relayBinding = data.relayBinding ?? null;
    if (
      !hello
      || message.versions.relay !== hello.relayVersion
      || message.versions.desktop !== REMOTE_DESKTOP_COMPATIBILITY.version
      || message.selected.relayProtocol !== RELAY_PROTOCOL_VERSION
      || message.selected.remoteProtocol !== REMOTE_PROTOCOL_VERSION
      || (relayBinding !== null && message.endpointEpoch <= relayBinding.epoch)
    ) {
      this.options.reject("The relay registration response was invalid.");
      return;
    }
    const connectedAt = this.options.now().toISOString();
    data.relayBinding = {
      relayIdentity: hello.relayIdentity,
      epoch: message.endpointEpoch,
      lastConnectedAt: message.lastConnectedAt,
      connectedAt,
    };
    await this.options.persist();
    this.options.online({
      relayVersion: hello.relayVersion,
      desktopVersion: REMOTE_DESKTOP_COMPATIBILITY.version,
      relayProtocol: message.selected.relayProtocol,
      remoteProtocol: message.selected.remoteProtocol,
      endpointAuthentication: hello.endpointAuthentication,
      persistence: hello.persistence,
      endpointEpoch: message.endpointEpoch,
      connectedAt,
    });
  }

  incompatible(message: RelayIncompatibility): void {
    const axis = message.axis === "relay-protocol"
      ? "relay transport"
      : "Remote Companion";
    const action = message.guidance.find(({ action }) => action === "upgrade");
    this.options.reject(action
      ? `Incompatible ${axis} versions. Upgrade the ${action.component} component.`
      : `Incompatible ${axis} versions. Install a supported component set.`);
  }
}
