import { remoteRandomSecret } from "../shared/remote-crypto";
import type {
  RemoteAuditEvent,
  RelayServerMessage,
  RemoteSetupDiagnostics,
  RemoteSetupMode,
} from "../shared/remote-protocol";
import { generateRemoteEndpointKeyPair } from "./remote-access-endpoint-auth";
import {
  DEFAULT_REMOTE_RELAY_URL,
  emptyRemoteSetupDiagnostics,
} from "./remote-access-policy";
import {
  probeRemoteSetup,
  RemoteSetupProbeError,
} from "./remote-access-setup-diagnostics";
import type { PersistedRemoteAccess } from "./remote-access-store";

interface RemoteAccessSetupManagerOptions {
  data(): PersistedRemoteAccess | null;
  initializeIdentity(relayUrl: string): Promise<PersistedRemoteAccess>;
  serialize<T>(operation: () => Promise<T>): Promise<T>;
  persist(): Promise<void>;
  persistAuthorityReduction(mutate: () => void): Promise<void>;
  disableLiveAccess(): void;
  audit(type: RemoteAuditEvent["type"], detail: string): void;
  now(): Date;
  emit(): void;
  probe?: typeof probeRemoteSetup;
}

export class RemoteAccessSetupManager {
  private diagnostics = emptyRemoteSetupDiagnostics();
  private endpointRecovery: {
    endpointOwnership: "missing" | "owned-by-another-key";
    message: string;
  } | null = null;
  private successfulFingerprint: string | null = null;

  constructor(private readonly options: RemoteAccessSetupManagerOptions) {}

  current(): RemoteSetupDiagnostics {
    return this.diagnostics;
  }

  requireTested(
    enabled: boolean,
    relayUrl: string,
    companionUrl: string,
    setupMode: RemoteSetupMode,
    enforce: boolean,
  ): void {
    if (
      enabled
      && enforce
      && this.successfulFingerprint !== setupFingerprint(
        relayUrl,
        companionUrl,
        setupMode,
      )
    ) throw new Error("Test this exact Remote Companion setup before enabling it.");
  }

  async test(
    relayUrl: string,
    companionUrl: string,
    setupMode: RemoteSetupMode,
    resetEndpoint = false,
  ): Promise<void> {
    this.diagnostics = {
      ...emptyRemoteSetupDiagnostics(),
      status: "testing",
      message: "Testing companion HTTPS headers and relay WSS policy…",
    };
    this.options.emit();
    try {
      const result = await (this.options.probe ?? probeRemoteSetup)(
        relayUrl,
        companionUrl,
        setupMode,
        { now: this.options.now },
      );
      if (this.endpointRecovery && !resetEndpoint) {
        throw new RemoteSetupProbeError(
          "endpoint-authentication",
          this.endpointRecovery.message,
        );
      }
      await this.options.serialize(async () => {
        const data = this.options.data()
          ?? await this.options.initializeIdentity(result.relayUrl);
        const relayIdentityChanged =
          data.relayBinding
          && data.relayBinding.relayIdentity !== result.relayIdentity;
        if (relayIdentityChanged && !resetEndpoint) {
          throw new RemoteSetupProbeError(
            "endpoint-authentication",
            "This relay has a different durable identity. Reset the endpoint and re-pair every browser.",
          );
        }
        const applySetup = (): void => {
          data.relayUrl = result.relayUrl;
          data.setupMode = setupMode;
          data.companionUrl = result.companionUrl;
        };
        if (resetEndpoint) {
          await this.options.persistAuthorityReduction(() => {
            this.resetEndpoint(data);
            applySetup();
          });
        } else {
          applySetup();
          await this.options.persist();
        }
      });
      this.endpointRecovery = null;
      this.diagnostics = result.diagnostics;
      this.successfulFingerprint = setupFingerprint(
        result.relayUrl,
        result.companionUrl,
        setupMode,
      );
      this.options.emit();
    } catch (error) {
      const failure = error instanceof RemoteSetupProbeError
        ? error
        : new RemoteSetupProbeError(
            "network",
            "The Remote Companion setup test failed.",
          );
      this.successfulFingerprint = null;
      this.diagnostics = {
        ...emptyRemoteSetupDiagnostics(),
        status: "failed",
        testedAt: this.options.now().toISOString(),
        tls: failure.failureClass === "tls-certificate" ? "failed" : null,
        originPolicy: failure.failureClass === "origin-policy"
          ? "rejected"
          : "unknown",
        endpointOwnership: failure.failureClass === "endpoint-authentication"
          ? this.endpointRecovery?.endpointOwnership ?? "unclaimed"
          : "unclaimed",
        retryClass: failure.failureClass === "network" ? "automatic" : "manual",
        failureClass: failure.failureClass,
        message: failure.message,
      };
      this.options.emit();
      throw failure;
    }
  }

  relayError(
    code: Extract<RelayServerMessage, { type: "relay.error" }>["code"],
    message: string,
  ): void {
    const endpointOwnership = code === "endpoint-missing"
      ? "missing"
      : code === "endpoint-owned" ? "owned-by-another-key" : null;
    if (!endpointOwnership) return;
    this.endpointRecovery = { endpointOwnership, message };
    this.successfulFingerprint = null;
    this.diagnostics = {
      ...this.diagnostics,
      status: "failed",
      testedAt: this.options.now().toISOString(),
      endpointOwnership,
      retryClass: "manual",
      failureClass: "endpoint-authentication",
      message,
    };
  }

  registered(input: {
    relayVersion: string;
    relayProtocol: number;
    remoteProtocol: number;
    endpointAuthentication: "required" | "migration";
    persistence: "durable" | "ephemeral";
    endpointEpoch: number;
    connectedAt: string;
    desktopVersion: string;
  }): void {
    this.endpointRecovery = null;
    this.diagnostics = {
      ...this.diagnostics,
      relayVersion: input.relayVersion,
      desktopVersion: input.desktopVersion,
      relayProtocol: input.relayProtocol,
      remoteProtocol: input.remoteProtocol,
      endpointAuthentication: input.endpointAuthentication,
      persistence: input.persistence,
      endpointOwnership: "verified",
      endpointEpoch: input.endpointEpoch,
      lastConnectedAt: input.connectedAt,
      retryClass: "none",
      failureClass: "none",
    };
  }

  private resetEndpoint(data: PersistedRemoteAccess): void {
    this.options.disableLiveAccess();
    const retiredAt = this.options.now().toISOString();
    data.enabled = false;
    data.endpointId = remoteRandomSecret(24);
    data.endpointKeyPair = generateRemoteEndpointKeyPair();
    data.endpointAuthMigratedAt = retiredAt;
    data.relayBinding = null;
    for (const device of data.devices) {
      if (device.revokedAt === null) {
        device.revokedAt = retiredAt;
        device.grantVersion += 1;
      }
    }
    data.receipts = [];
    data.usedSessions = [];
    this.options.audit(
      "remote.disabled",
      "The relay endpoint was reset; every browser must be paired again.",
    );
  }
}

function setupFingerprint(
  relayUrl: string,
  companionUrl: string,
  setupMode: RemoteSetupMode,
): string {
  return `${setupMode}\u0000${relayUrl}\u0000${companionUrl}`;
}

export function effectiveSetupRelay(
  relayUrl: string | undefined,
  data: PersistedRemoteAccess | null,
): string {
  return relayUrl ?? data?.relayUrl ?? DEFAULT_REMOTE_RELAY_URL;
}
