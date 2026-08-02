import WebSocket from "ws";
import {
  importRemotePublicKey,
  openPairingRequest,
  sealPairingResponse,
  type RemoteImportedKeyPair,
} from "../shared/remote-crypto";
import {
  REMOTE_LIMITS,
  RELAY_PROTOCOL_VERSION,
  REMOTE_DESKTOP_COMPATIBILITY,
  REMOTE_PROTOCOL_VERSION,
  encodedRemoteFrameBytes,
  remoteCipherFrameSchema,
  remotePairingRequestPayloadSchema,
  type RelayClientMessage,
  type RelayServerMessage,
  type RemoteAccessState,
  type RemoteAuditEvent,
  type RemoteCipherFrame,
  type RemotePairingInvitation,
  type RemoteResponse,
  type RemoteSetupMode,
  type RemoteScope,
} from "../shared/remote-protocol";
import type { RemoteConversationGrant } from "../shared/remote-grants";
import type { PersistedRemoteAccess } from "./remote-access-store";
import { settleRemoteDeliveryOnDisconnect } from "./remote-access-delivery";
import {
  createRemoteAccessIdentity,
  loadRemoteAccessIdentity,
} from "./remote-access-identity";
import {
  closeRemoteSocket,
  REMOTE_MAX_BUFFERED_BYTES,
  REMOTE_PRIVACY_LOCKED_MESSAGE,
  REMOTE_PRIVACY_UNVERIFIED_MESSAGE,
  REMOTE_SHUTDOWN_TIMEOUT_MS,
  RemoteSessionAuthenticationBudget,
  sendRemoteAuthorityInvalidation,
  sendSequencedRemoteResponse,
  terminateRemoteSocket,
} from "./remote-access-lifecycle";
import {
  DEFAULT_REMOTE_COMPANION_URL, DEFAULT_REMOTE_GRANT_MS,
  DEFAULT_REMOTE_RELAY_URL,
  projectRemoteAccessState,
  remoteDeviceIsCurrent, remotePairingComparisonCode,
  remoteRelayErrorMessage, takeRemoteRate, trimRemoteSet,
  validateRemoteRelayUrl,
} from "./remote-access-policy";
import { validateRemoteCompanionUrl } from "./remote-access-setup-diagnostics";
import {
  applyRemotePairingGrant,
  pruneRemoteDeviceTombstones,
  revokeRemoteDevice,
  updateRemoteDeviceGrant,
} from "./remote-access-devices";
import { appendRemoteAudit, RemoteAccessPersistenceQueue } from "./remote-access-persistence";
import { createRemotePairingInvitation, sanitizeRemoteDeviceLabel } from "./remote-access-pairing";
import {
  RemoteRelayDispatcher,
  type RemoteConnectionEpoch,
} from "./remote-access-relay-dispatcher";
import { RemoteRequestDispatcher } from "./remote-access-request-dispatcher";
import {
  RemoteSessionAdmissions, remoteSessionCanCommitPrompt,
  remoteSessionRetainsAuthority,
  type RemoteSessionAuthorityInput,
} from "./remote-access-session-admission";
import { openRemoteSession } from "./remote-access-session-opener";
import { handleRemoteSessionData } from "./remote-access-session-data";
import { RemoteRelayRegistration } from "./remote-access-relay-registration";
import {
  effectiveSetupRelay,
  RemoteAccessSetupManager,
} from "./remote-access-setup-manager";
import type {
  ActiveRemoteSession, PendingRemotePairing, RemoteAccessServiceOptions,
  RemotePrivacySuspension,
} from "./remote-access-service-types";
const RELAY_HANDSHAKE_TIMEOUT_MS = 10_000;
const SESSION_SWEEP_MS = 30_000;
type Timer = ReturnType<typeof setTimeout>;
export class RemoteAccessService {
  private data: PersistedRemoteAccess | null;
  private hostKeyPair: RemoteImportedKeyPair | null;
  private readonly now: () => Date;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;
  private readonly createSocket: (url: string) => WebSocket;
  private socket: WebSocket | null = null;
  private connection: RemoteAccessState["connection"] = "disabled";
  private connectionMessage: string | null = null;
  private pendingConnectionMessage: string | null = null;
  private invitation: RemotePairingInvitation | null = null;
  private readonly pendingPairings = new Map<string, PendingRemotePairing>();
  private readonly sessions = new Map<string, ActiveRemoteSession>();
  private readonly sessionByConnection = new Map<string, string>();
  private readonly sessionAdmissions: RemoteSessionAdmissions;
  private readonly relayMessages: RemoteRelayDispatcher;
  private readonly requests: RemoteRequestDispatcher;
  private authorityMutationTail: Promise<void> = Promise.resolve();
  private readonly pairingRequestIds = new Set<string>();
  private pairingAttemptTimes: number[] = [];
  private readonly sessionAuthenticationBudget =
    new RemoteSessionAuthenticationBudget();
  private reconnectAttempt = 0;
  private reconnectTimer: Timer | null = null;
  private registrationTimer: Timer | null = null;
  private readonly relayRegistration: RemoteRelayRegistration;
  private readonly peerCompatibility = new Map<string, Extract<
    RelayServerMessage,
    { type: "relay.peer-connected" }
  >>();
  private sweepTimer: Timer | null = null;
  private privacyLocked: boolean;
  private privacySuspension: RemotePrivacySuspension | null;
  private stopped = false;
  private storeError: string | null = null;
  private identityInitialization: Promise<void> | null = null;
  private readonly persistence: RemoteAccessPersistenceQueue;
  private readonly setup: RemoteAccessSetupManager;
  private constructor(
    private readonly options: RemoteAccessServiceOptions,
    data: PersistedRemoteAccess | null,
    hostKeyPair: RemoteImportedKeyPair | null,
    private readonly storageAvailable = true,
  ) {
    this.data = data;
    this.hostKeyPair = hostKeyPair;
    this.privacySuspension = options.initialPrivacy === undefined
      ? "unverified"
      : options.initialPrivacy;
    this.privacyLocked = this.privacySuspension !== null;
    this.now = options.now ?? (() => new Date());
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url, {
      perMessageDeflate: false,
      maxPayload: REMOTE_LIMITS.relayEnvelopeBytes,
      handshakeTimeout: RELAY_HANDSHAKE_TIMEOUT_MS,
    }));
    this.persistence = new RemoteAccessPersistenceQueue(
      options.store,
      () => this.failClosedStore(
        "The encrypted Remote Companion store could not be saved.",
      ),
    );
    this.setup = new RemoteAccessSetupManager({
      data: () => this.data,
      initializeIdentity: async (relayUrl) =>
        await this.initializeIdentity(relayUrl),
      serialize: async (operation) =>
        await this.serializeAuthorityMutation(operation),
      persist: async () => await this.persist(),
      disableLiveAccess: () => this.disableLiveRemoteAccess(),
      audit: (type, detail) => this.audit(type, null, detail),
      now: () => this.now(),
      emit: () => this.emitState(),
    });
    this.relayRegistration = new RemoteRelayRegistration({
      data: () => this.requireData(),
      endpointKeyPair: () => this.requireEndpointKeyPair(),
      now: () => this.now(),
      persist: async () => await this.persist(),
      send: (message) => this.sendRelay(message),
      reject: (message) => {
        this.pendingConnectionMessage = message;
        terminateRemoteSocket(this.socket);
      },
      online: (diagnostics) => {
        this.clearRegistrationDeadline();
        this.connection = "online";
        this.connectionMessage = null;
        this.setup.registered(diagnostics);
        this.reconnectAttempt = 0;
        this.emitState();
      },
    });
    this.sessionAdmissions = new RemoteSessionAdmissions({
      capacity: REMOTE_LIMITS.sessions,
      authenticationCapacity: REMOTE_LIMITS.sessions
        + REMOTE_LIMITS.sessionRejectionAuthentications,
      activeCount: () => this.sessions.size,
      hasActiveSession: (sessionId) => this.sessions.has(sessionId),
      hasUsedSession: (sessionId) =>
        this.requireData().usedSessions.some(({ id }) => id === sessionId),
      hasActiveConnection: (connectionId) =>
        this.sessionByConnection.has(connectionId),
      ownsConnection: (connectionId, epoch) =>
        this.relayMessages.owns(connectionId, epoch),
      takeAuthenticationAttempt: (connectionId) =>
        this.sessionAuthenticationBudget.take(
          connectionId,
          this.now().getTime(),
        ),
    });
    this.relayMessages = new RemoteRelayDispatcher({
      hello: (message) => this.relayRegistration.begin(message),
      challenge: (message) => {
        try {
          this.relayRegistration.prove(message, RELAY_HANDSHAKE_TIMEOUT_MS);
        } catch {
          this.pendingConnectionMessage = "The relay challenge could not be signed.";
          terminateRemoteSocket(this.socket);
        }
      },
      registered: (message) => {
        void this.relayRegistration.accept(message).catch(() => {
          this.pendingConnectionMessage = "The authenticated relay state could not be saved.";
          terminateRemoteSocket(this.socket);
        });
      },
      incompatible: (message) => this.relayRegistration.incompatible(message),
      peerConnected: (message) => {
        this.peerCompatibility.set(message.connectionId, message);
      },
      error: (code) => this.relayError(code),
      frame: async (id, epoch, frame) => {
        if (!this.stopped) await this.handleFrame(id, epoch, frame);
      },
      invalidated: (id, epoch) => {
        this.sessionAdmissions.drop(id, epoch);
      },
      disconnected: (id, epoch) => this.dropConnection(id, epoch),
      rejected: (id) => this.sendRelay({
        relayProtocolVersion: RELAY_PROTOCOL_VERSION,
        type: "relay.disconnect",
        connectionId: id,
      }),
      oversized: () => this.socket?.close(1009, "message too large"),
    });
    this.requests = new RemoteRequestDispatcher({
      runtime: options.runtime,
      data: () => this.requireData(),
      now: () => this.now(),
      persist: async () => await this.persist(),
      audit: (type, deviceId, detail) => this.audit(type, deviceId, detail),
      isCurrent: (session) => this.sessionRetainsAuthority(session),
      authorizePromptCommit: (session) =>
        !this.sessionAdmissions.isDeviceBlocked(session.device.id)
        && remoteSessionCanCommitPrompt(this.sessionAuthority(session)),
      respond: async (session, response) => await this.respond(session, response),
    });
  }

  static async create(
    options: RemoteAccessServiceOptions,
  ): Promise<RemoteAccessService> {
    const identity = await loadRemoteAccessIdentity(options.store);
    if (identity.kind === "ready") {
      const service = new RemoteAccessService(options, identity.data,
        identity.hostKeyPair);
      service.scheduleSweep();
      if (options.autoConnect !== false && identity.data.enabled) {
        service.connect();
      }
      return service;
    }
    const service = new RemoteAccessService(
      options, null, null, identity.kind !== "unavailable");
    if ("message" in identity) service.storeError = identity.message;
    return service;
  }

  state(): RemoteAccessState {
    return projectRemoteAccessState({
      data: this.data,
      storageAvailable: this.storageAvailable,
      storeError: this.storeError,
      connection: this.connection,
      connectionMessage: this.connectionMessage,
      activeSessions: this.sessions.size,
      pendingPairings: this.pendingPairings.values(),
      invitation: this.invitation,
      diagnostics: this.setup.current(),
    });
  }

  startConnections(): void {
    if (this.data?.enabled) this.connect();
  }

  async testSetup(
    relayUrl: string,
    companionUrl: string,
    setupMode: RemoteSetupMode,
    resetEndpoint = false,
  ): Promise<void> {
    await this.setup.test(relayUrl, companionUrl, setupMode, resetEndpoint);
  }

  async setEnabled(
    enabled: boolean,
    relayUrl?: string,
    setupMode?: RemoteSetupMode,
    companionUrl?: string,
  ): Promise<void> {
    const normalizedRelay = relayUrl === undefined
      ? undefined
      : validateRemoteRelayUrl(relayUrl);
    const normalizedMode = setupMode ?? this.data?.setupMode
      ?? "local-development";
    const normalizedCompanion = companionUrl === undefined
      ? this.data?.companionUrl ?? DEFAULT_REMOTE_COMPANION_URL
      : validateRemoteCompanionUrl(companionUrl, normalizedMode);
    this.setup.requireTested(
      enabled,
      effectiveSetupRelay(normalizedRelay, this.data),
      normalizedCompanion,
      normalizedMode,
      setupMode !== undefined || companionUrl !== undefined,
    );
    if (!enabled) {
      this.disableLiveRemoteAccess();
    }
    await this.serializeAuthorityMutation(async () => {
      if (!enabled && !this.data) return;
      const data = this.data ?? await this.initializeIdentity(
        normalizedRelay ?? DEFAULT_REMOTE_RELAY_URL,
      );
      if (!enabled) {
        this.disableLiveRemoteAccess();
        if (!data.enabled) {
          if (normalizedRelay !== undefined) data.relayUrl = normalizedRelay;
          await this.persist();
          this.emitState();
          return;
        }
        await this.persistAuthorityReduction(() => {
          this.disableLiveRemoteAccess();
          if (normalizedRelay !== undefined) data.relayUrl = normalizedRelay;
          data.enabled = false;
          this.audit(
            "remote.disabled",
            null,
            "Remote Companion disabled.",
          );
        });
        this.emitState();
        return;
      }
      if (normalizedRelay !== undefined) data.relayUrl = normalizedRelay;
      data.setupMode = normalizedMode;
      data.companionUrl = normalizedCompanion;
      if (data.enabled) {
        await this.persist();
        if (!this.socket) this.connect();
        return;
      }
      data.enabled = true;
      this.audit("remote.enabled", null, "Remote Companion enabled.");
      await this.persist();
      this.connect();
      this.emitState();
    });
  }

  async createInvitation(): Promise<RemotePairingInvitation> {
    const data = this.requireData();
    if (!data.enabled) throw new Error("Enable Remote Companion first.");
    if (this.connection !== "online" || !data.relayBinding) {
      throw new Error("The authenticated relay must be online before pairing.");
    }
    if (this.pendingPairings.size >= REMOTE_LIMITS.pendingPairings) {
      throw new Error("Too many pairing requests are pending.");
    }
    const invitation = createRemotePairingInvitation(data, this.now());
    this.invitation = invitation;
    this.audit("pairing.created", null, "A short-lived pairing invitation was created.");
    await this.persist();
    this.emitState();
    return invitation;
  }

  async approvePairing(
    requestId: string,
    scopes: RemoteScope[],
    projectIds: string[],
    grantMs = DEFAULT_REMOTE_GRANT_MS,
    grants?: RemoteConversationGrant[],
  ): Promise<void> {
    const data = this.requireData();
    const pending = this.pendingPairings.get(requestId);
    if (!pending) throw new Error("That pairing request is no longer pending.");
    if (!this.relayMessages.owns(
      pending.connectionId,
      pending.connectionEpoch,
    )) {
      this.pendingPairings.delete(requestId);
      throw new Error("That pairing request is no longer connected.");
    }
    if (Date.parse(pending.expiresAt) <= this.now().getTime()) {
      this.pendingPairings.delete(requestId);
      throw new Error("That pairing request expired.");
    }
    const releaseAdmissionBlock = this.sessionAdmissions.blockDevice(pending.payload.deviceId);
    try {
      const devicePublicKey = await importRemotePublicKey(pending.payload.devicePublicKey);
      if (!this.pairingIsCurrent(requestId, pending)) {
        throw new Error("That pairing request is no longer pending.");
      }
      const { device, replaced } = await this.serializeAuthorityMutation(
        async () => {
          if (!this.pairingIsCurrent(requestId, pending)) {
            throw new Error("That pairing request is no longer pending.");
          }
          const currentData = this.requireData();
          const replacing = currentData.devices.some(
            ({ id, revokedAt }) => id === pending.payload.deviceId && !revokedAt,
          );
          if (replacing) {
            return await this.persistAuthorityReduction(
              () => {
                const applied = applyRemotePairingGrant({
                  data: currentData,
                  pending,
                  scopes,
                  projectIds,
                  grants,
                  grantMs,
                  now: this.now(),
                });
                this.pendingPairings.delete(requestId);
                this.audit(
                  "pairing.accepted",
                  applied.device.id,
                  "A device was paired.",
                );
                return applied;
              },
              () => this.pairingIsCurrent(requestId, pending),
            );
          }
          const applied = applyRemotePairingGrant({
            data: currentData,
            pending,
            scopes,
            projectIds,
            grants,
            grantMs,
            now: this.now(),
          });
          this.pendingPairings.delete(requestId);
          this.audit(
            "pairing.accepted",
            applied.device.id,
            "A device was paired.",
          );
          await this.persist();
          return applied;
        },
      );
      if (replaced) await this.invalidateDeviceSessions(device.id);
      const frame = await sealPairingResponse(
        this.requireHostKeyPair(), devicePublicKey, requestId, {
          type: "pair.accepted",
          requestId,
          deviceId: device.id,
          hostId: data.hostId,
          scopes: device.scopes,
          projectIds: device.projectIds,
          expiresAt: device.expiresAt,
          grantVersion: device.grantVersion,
        },
      );
      if (this.relayMessages.owns(
        pending.connectionId,
        pending.connectionEpoch,
      )) {
        this.sendFrame(pending.connectionId, frame);
      }
      this.emitState();
    } finally { releaseAdmissionBlock(); }
  }

  async denyPairing(requestId: string): Promise<void> {
    const pending = this.pendingPairings.get(requestId);
    if (!pending) {
      if (this.invitation?.invitationId !== requestId) return;
      this.invitation = null;
      this.audit("pairing.denied", null, "A pairing invitation was cancelled.");
      await this.persist();
      this.emitState();
      return;
    }
    this.pendingPairings.delete(requestId);
    this.audit("pairing.denied", pending.payload.deviceId, "A pairing request was denied.");
    await this.persist();
    const frame = await sealPairingResponse(
      this.requireHostKeyPair(),
      await importRemotePublicKey(pending.payload.devicePublicKey),
      requestId,
      {
        type: "pair.rejected",
        requestId,
        reason: "denied",
      },
    );
    this.sendFrame(pending.connectionId, frame);
    this.emitState();
  }

  async revokeDevice(deviceId: string): Promise<void> {
    const data = this.requireData();
    const current = data.devices.find(({ id }) => id === deviceId);
    if (!current) throw new Error("That paired device was not found.");
    if (current.revokedAt) return;
    const releaseAdmissionBlock = this.sessionAdmissions.blockDevice(current.id);
    try {
      const revoked = await this.serializeAuthorityMutation(async () => {
        const durableDevice = this.requireData().devices.find(
          ({ id }) => id === deviceId,
        );
        if (!durableDevice) throw new Error("That paired device was not found.");
        if (durableDevice.revokedAt) return;
        return await this.persistAuthorityReduction(() => {
          const revoked = revokeRemoteDevice(
            this.requireData(),
            deviceId,
            this.now(),
          );
          if (!revoked) throw new Error("That paired device is already revoked.");
          this.audit("device.revoked", revoked.id, "A paired device was revoked.");
          return revoked;
        });
      });
      if (revoked) await this.invalidateDeviceSessions(revoked.id);
      this.emitState();
    } finally {
      releaseAdmissionBlock();
    }
  }
  async updateDevice(
    deviceId: string,
    scopes: RemoteScope[],
    projectIds: string[],
    expiresAt: string,
    grants?: RemoteConversationGrant[],
  ): Promise<void> {
    const data = this.requireData();
    const validated = updateRemoteDeviceGrant({
      data: structuredClone(data),
      deviceId,
      scopes,
      projectIds,
      grants,
      expiresAt,
      now: this.now(),
    });
    if (validated.revokedAt) {
      throw new Error("That paired device is already revoked.");
    }
    const releaseAdmissionBlock = this.sessionAdmissions.blockDevice(validated.id);
    try {
      const updated = await this.serializeAuthorityMutation(async () => {
        const current = updateRemoteDeviceGrant({
          data: structuredClone(this.requireData()),
          deviceId,
          scopes,
          projectIds,
          grants,
          expiresAt,
          now: this.now(),
        });
        if (current.revokedAt) {
          throw new Error("That paired device is already revoked.");
        }
        return await this.persistAuthorityReduction(() => {
          const device = updateRemoteDeviceGrant({
            data: this.requireData(),
            deviceId,
            scopes,
            projectIds,
            grants,
            expiresAt,
            now: this.now(),
          });
          this.audit("device.scope-changed", device.id, "Device permissions changed.");
          return device;
        });
      });
      await this.invalidateDeviceSessions(updated.id, "shutdown");
      this.emitState();
    } finally {
      releaseAdmissionBlock();
    }
  }
  setPrivacyLocked(
    locked: boolean,
    suspension: RemotePrivacySuspension | null = locked ? "locked" : null,
  ): void {
    const changed = this.privacyLocked !== locked
      || this.privacySuspension !== suspension;
    if (!changed) return;
    this.privacyLocked = locked;
    this.privacySuspension = locked ? suspension ?? "locked" : null;
    if (locked) this.disconnect("shutdown", true);
    else if (this.data?.enabled) this.connect();
    this.emitState();
  }
  private privacySuspensionMessage(): string | null {
    if (!this.privacyLocked) return null;
    return this.privacySuspension === "unverified"
      ? REMOTE_PRIVACY_UNVERIFIED_MESSAGE
      : REMOTE_PRIVACY_LOCKED_MESSAGE;
  }

  async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.clearReconnect();
    if (this.sweepTimer) this.clearTimer(this.sweepTimer);
    this.sweepTimer = null;
    const socket = this.disconnect("shutdown", false);
    await closeRemoteSocket(
      socket,
      this.setTimer,
      this.clearTimer,
      REMOTE_SHUTDOWN_TIMEOUT_MS,
    );
    await this.authorityMutationTail;
    await this.persistence.drain();
  }
  private connect(): void {
    const data = this.data;
    if (!data?.enabled || this.stopped || this.socket) return;
    if (this.privacyLocked) {
      this.connection = "offline";
      this.connectionMessage = this.privacySuspensionMessage();
      return;
    }
    this.connection = "connecting";
    this.connectionMessage = null;
    this.relayRegistration.reset();
    this.emitState();
    let socket: WebSocket;
    try {
      socket = this.createSocket(data.relayUrl);
    } catch {
      this.connection = "error";
      this.connectionMessage = "The relay URL could not be opened.";
      this.scheduleReconnect();
      this.emitState();
      return;
    }
    this.socket = socket;
    socket.once("open", () => {
      if (this.socket !== socket) return;
      this.clearRegistrationDeadline();
      this.registrationTimer = this.setTimer(() => {
        this.registrationTimer = null;
        if (this.socket !== socket || this.connection === "online") return;
        this.pendingConnectionMessage = "The relay did not accept the desktop.";
        terminateRemoteSocket(socket);
      }, RELAY_HANDSHAKE_TIMEOUT_MS);
    });
    socket.on("message", (raw, isBinary) => {
      if (this.socket !== socket) return;
      if (isBinary) {
        socket.close(1003, "relay messages must be text");
        return;
      }
      this.relayMessages.receive(raw);
    });
    socket.once("close", () => {
      if (this.socket !== socket) return;
      this.clearRegistrationDeadline();
      this.socket = null;
      this.connection = "offline";
      const closedMessage = this.pendingConnectionMessage;
      this.pendingConnectionMessage = null;
      this.connectionMessage = this.privacySuspensionMessage()
        ?? closedMessage ?? "The relay is offline.";
      this.relayMessages.reset();
      this.relayRegistration.reset();
      this.peerCompatibility.clear();
      this.dropAllSessions();
      this.scheduleReconnect();
      this.emitState();
    });
    socket.once("error", () => {
      if (this.socket !== socket) return;
      this.connection = "error";
      this.connectionMessage = "The relay connection failed.";
      this.emitState();
    });
  }
  private relayError(
    code: Parameters<typeof remoteRelayErrorMessage>[0],
  ): void {
    this.connectionMessage = remoteRelayErrorMessage(code);
    if (code === "capacity" && this.connection === "connecting") {
      terminateRemoteSocket(this.socket);
    }
    this.emitState();
  }
  private async handleFrame(
    connectionId: string,
    epoch: RemoteConnectionEpoch,
    frame: RemoteCipherFrame,
  ): Promise<void> {
    if (!this.peerIsCompatible(connectionId, epoch)) {
      this.relayMessages.invalidate(connectionId, epoch);
      return;
    }
    if (frame.kind === "pair.request") {
      return await this.handlePairingRequest(connectionId, epoch, frame);
    }
    if (frame.kind === "session.open") {
      return await this.handleSessionOpen(connectionId, epoch, frame);
    }
    if (frame.kind === "session.data") {
      return await this.handleSessionData(connectionId, epoch, frame);
    }
    if (frame.kind === "session.close") {
      this.relayMessages.invalidate(connectionId, epoch);
      this.dropConnection(connectionId, epoch);
    }
  }
  private async handlePairingRequest(
    connectionId: string,
    epoch: RemoteConnectionEpoch,
    frame: Extract<RemoteCipherFrame, { kind: "pair.request" }>,
  ): Promise<void> {
    const invitation = this.invitation;
    if (
      !invitation
      || invitation.invitationId !== frame.invitationId
      || Date.parse(invitation.expiresAt) <= this.now().getTime()
      || !this.takePairingAttempt()
    ) return;
    this.invitation = null;
    this.emitState();
    const payload = remotePairingRequestPayloadSchema.parse(
      await openPairingRequest(invitation, this.requireHostKeyPair(), frame),
    );
    if (!this.relayMessages.owns(connectionId, epoch)) return;
    if (
      payload.invitationId !== invitation.invitationId
      || Math.abs(Date.parse(payload.createdAt) - this.now().getTime())
        > REMOTE_LIMITS.pairingTtlMs
      || this.pairingRequestIds.has(payload.requestId)
      || this.pendingPairings.size >= REMOTE_LIMITS.pendingPairings
    ) return;
    const deviceLabel = sanitizeRemoteDeviceLabel(payload.deviceLabel);
    if (!deviceLabel) return;
    payload.deviceLabel = deviceLabel;
    this.pairingRequestIds.add(payload.requestId);
    trimRemoteSet(this.pairingRequestIds, 512);
    const pending: PendingRemotePairing = {
      connectionId,
      connectionEpoch: epoch,
      payload,
      receivedAt: this.now().toISOString(),
      expiresAt: invitation.expiresAt,
      comparisonCode: remotePairingComparisonCode(
        invitation.hostPublicKey,
        payload.devicePublicKey,
        invitation.invitationId,
      ),
    };
    this.pendingPairings.set(payload.requestId, pending);
    this.audit("pairing.requested", payload.deviceId, "A device requested pairing.");
    await this.persist();
    if (!this.relayMessages.owns(connectionId, epoch)) return;
    this.emitState();
  }
  private async handleSessionOpen(
    connectionId: string,
    epoch: RemoteConnectionEpoch,
    frame: Extract<RemoteCipherFrame, { kind: "session.open" }>,
  ): Promise<void> {
    await openRemoteSession({
      data: this.requireData(),
      admissions: this.sessionAdmissions,
      connectionId,
      epoch,
      frame,
      hostKeys: this.requireHostKeyPair(),
      sessions: this.sessions,
      sessionByConnection: this.sessionByConnection,
      now: () => this.now(),
      persist: async () => await this.persist(),
      sendFrame: (id, value) => this.sendFrame(id, value),
      audit: (deviceId, detail) => {
        this.audit("session.connected", deviceId, detail);
      },
      emit: () => this.emitState(),
    });
  }
  private async handleSessionData(
    connectionId: string,
    epoch: RemoteConnectionEpoch,
    frame: Extract<RemoteCipherFrame, { kind: "session.data" }>,
  ): Promise<void> {
    await handleRemoteSessionData({
      sessions: this.sessions,
      connectionId,
      epoch,
      frame,
      now: () => this.now(),
      owns: (id, connectionEpoch) =>
        this.relayMessages.owns(id, connectionEpoch),
      close: (session, reason) => this.closeSession(session, reason),
      respond: async (session, response) =>
        await this.respond(session, response),
      dispatch: async (session, request) =>
        await this.requests.dispatch(session, request),
      drop: (session) => {
        this.relayMessages.invalidate(
          session.connectionId,
          session.connectionEpoch,
        );
        this.dropConnection(session.connectionId, session.connectionEpoch);
      },
    });
  }
  private async respond(
    session: ActiveRemoteSession,
    response: RemoteResponse,
  ): Promise<void> {
    await sendSequencedRemoteResponse(
      session,
      response,
      () => this.sessionRetainsAuthority(session),
      (connectionId, frame) => this.sendFrame(connectionId, frame),
    );
  }
  private sessionAuthority(
    session: ActiveRemoteSession,
  ): RemoteSessionAuthorityInput {
    return {
      data: this.data,
      session,
      live: this.sessions.get(session.sessionId) === session,
      ownsRoute: this.relayMessages.owns(
        session.connectionId,
        session.connectionEpoch,
      ),
      privacyLocked: this.privacyLocked,
      stopped: this.stopped,
      storeFailed: this.storeError !== null,
      now: this.now().getTime(),
    };
  }
  private sessionRetainsAuthority(session: ActiveRemoteSession): boolean {
    return !this.sessionAdmissions.isDeviceBlocked(session.device.id)
      && remoteSessionRetainsAuthority(this.sessionAuthority(session));
  }
  private peerIsCompatible(
    connectionId: string,
    epoch: RemoteConnectionEpoch,
  ): boolean {
    const peer = this.peerCompatibility.get(connectionId);
    const hello = this.relayRegistration.hello();
    return peer !== undefined
      && hello !== null
      && peer.endpointEpoch === epoch
      && peer.relayIdentity === hello.relayIdentity
      && peer.selected.relayProtocol === RELAY_PROTOCOL_VERSION
      && peer.selected.remoteProtocol === REMOTE_PROTOCOL_VERSION
      && peer.versions.relay === hello.relayVersion
      && peer.versions.desktop === REMOTE_DESKTOP_COMPATIBILITY.version;
  }
  private sendFrame(connectionId: string, frame: RemoteCipherFrame): void {
    if (
      !remoteCipherFrameSchema.safeParse(frame).success
      || encodedRemoteFrameBytes(frame) > REMOTE_LIMITS.encryptedFrameBytes
    ) return;
    this.sendRelay({
      relayProtocolVersion: RELAY_PROTOCOL_VERSION,
      type: "relay.frame",
      connectionId,
      frame,
    });
  }
  private sendRelay(message: RelayClientMessage): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const serialized = JSON.stringify(message);
    const bytes = new TextEncoder().encode(serialized).byteLength;
    if (bytes > REMOTE_LIMITS.relayEnvelopeBytes) return;
    if (socket.bufferedAmount + bytes > REMOTE_MAX_BUFFERED_BYTES) {
      this.pendingConnectionMessage =
        "The relay stopped reading desktop traffic.";
      terminateRemoteSocket(socket);
      return;
    }
    socket.send(serialized);
  }
  private closeDeviceSessions(
    deviceId: string,
    reason: Extract<RemoteCipherFrame, { kind: "session.close" }>["reason"],
    persistChanges = true,
    legacyReason = reason,
  ): void {
    this.sessionAdmissions.dropDevice(deviceId);
    for (const session of this.sessions.values()) {
      if (session.device.id === deviceId) {
        this.closeSession(
          session,
          session.supportsAuthenticatedRejection ? reason : legacyReason,
          persistChanges,
        );
      }
    }
  }
  private async invalidateDeviceSessions(
    deviceId: string,
    legacyReason: Extract<RemoteCipherFrame, { kind: "session.close" }>["reason"] =
      "revoked",
  ): Promise<void> {
    await sendRemoteAuthorityInvalidation(
      this.sessions.values(), deviceId, this.now().toISOString(),
      (session) => this.sessions.get(session.sessionId) === session
        && this.relayMessages.owns(session.connectionId, session.connectionEpoch),
      (connectionId, frame) => this.sendFrame(connectionId, frame),
    ).catch(() => undefined);
    this.closeDeviceSessions(deviceId, "revoked", true, legacyReason);
  }
  private closeSession(
    session: ActiveRemoteSession,
    reason: Extract<RemoteCipherFrame, { kind: "session.close" }>["reason"],
    persistChanges = true,
  ): void {
    this.sendFrame(session.connectionId, {
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      kind: "session.close",
      sessionId: session.sessionId,
      reason,
    });
    this.relayMessages.invalidate(
      session.connectionId,
      session.connectionEpoch,
    );
    this.dropConnection(
      session.connectionId,
      session.connectionEpoch,
      persistChanges,
    );
  }
  private dropConnection(
    connectionId: string,
    epoch?: RemoteConnectionEpoch,
    persistChanges = true,
  ): void {
    this.sessionAdmissions.drop(connectionId, epoch);
    this.sessionAuthenticationBudget.drop(connectionId);
    this.peerCompatibility.delete(connectionId);
    for (const [requestId, pending] of this.pendingPairings) {
      if (
        pending.connectionId === connectionId
        && (epoch === undefined || pending.connectionEpoch === epoch)
      ) {
        this.pendingPairings.delete(requestId);
      }
    }
    const sessionId = this.sessionByConnection.get(connectionId);
    if (!sessionId) {
      this.emitState();
      return;
    }
    const session = this.sessions.get(sessionId);
    if (session && epoch !== undefined && session.connectionEpoch !== epoch) {
      this.emitState();
      return;
    }
    this.sessionByConnection.delete(connectionId);
    this.sessions.delete(sessionId);
    if (session && !this.storeError) {
      for (const request of session.inFlight.values()) {
        if (
          request.type === "prompt.send"
          && settleRemoteDeliveryOnDisconnect(
            this.requireData(),
            session.device.id,
            request,
            session.postedPromptDeliveries.has(request.deliveryId),
          ) === "uncertain"
        ) {
          this.audit(
            "prompt.uncertain",
            session.device.id,
            "A remote prompt has uncertain delivery.",
          );
        }
      }
      this.audit("session.disconnected", session.device.id, "A remote session disconnected.");
      if (persistChanges) void this.persist().catch(() => undefined);
    }
    this.emitState();
  }
  private dropAllSessions(persistChanges = true): void {
    this.relayMessages.reset();
    this.sessionAdmissions.clear();
    for (const connectionId of this.sessionByConnection.keys()) {
      this.dropConnection(connectionId, undefined, persistChanges);
    }
    this.pendingPairings.clear();
    this.peerCompatibility.clear();
  }
  private disconnect(
    reason: Extract<RemoteCipherFrame, { kind: "session.close" }>["reason"],
    reconnect: boolean,
    persistChanges = true,
  ): WebSocket | null {
    for (const session of this.sessions.values()) {
      this.sendFrame(session.connectionId, {
        protocolVersion: REMOTE_PROTOCOL_VERSION,
        kind: "session.close",
        sessionId: session.sessionId,
        reason,
      });
    }
    this.dropAllSessions(persistChanges);
    this.sessionAuthenticationBudget.clear();
    this.clearRegistrationDeadline();
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.close(1000, "desktop unavailable");
    } catch {
      socket?.terminate();
    }
    this.clearReconnect();
    this.connection = this.data?.enabled ? "offline" : "disabled";
    this.connectionMessage = this.privacySuspensionMessage();
    if (reconnect) this.scheduleReconnect();
    return socket;
  }
  private scheduleReconnect(): void {
    if (
      this.stopped
      || this.privacyLocked
      || !this.data?.enabled
      || this.reconnectTimer
    ) return;
    const delay = Math.min(
      500 * 2 ** Math.min(this.reconnectAttempt++, 10),
      REMOTE_LIMITS.reconnectMaximumMs,
    );
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
  private clearRegistrationDeadline(): void {
    if (!this.registrationTimer) return;
    this.clearTimer(this.registrationTimer);
    this.registrationTimer = null;
  }
  private clearReconnect(): void {
    if (!this.reconnectTimer) return;
    this.clearTimer(this.reconnectTimer);
    this.reconnectTimer = null;
  }
  private scheduleSweep(): void {
    if (this.stopped || this.sweepTimer) return;
    this.sweepTimer = this.setTimer(() => {
      this.sweepTimer = null;
      this.sweep();
      this.scheduleSweep();
    }, SESSION_SWEEP_MS);
  }
  private sweep(): void {
    const now = this.now().getTime();
    if (this.invitation && Date.parse(this.invitation.expiresAt) <= now) {
      this.invitation = null;
    }
    for (const [requestId, pending] of this.pendingPairings) {
      if (Date.parse(pending.expiresAt) <= now) {
        this.pendingPairings.delete(requestId);
      }
    }
    for (const session of this.sessions.values()) {
      if (!remoteDeviceIsCurrent(session.device, now)) {
        this.closeSession(session, "expired");
      } else if (
        now - session.lastActivityAt > REMOTE_LIMITS.sessionIdleTtlMs
      ) {
        this.closeSession(session, "expired");
      }
    }
    if (this.data && pruneRemoteDeviceTombstones(this.data, this.now())) {
      void this.persist().catch(() => undefined);
    }
    this.emitState();
  }
  private takePairingAttempt(): boolean {
    return takeRemoteRate(
      this.pairingAttemptTimes,
      REMOTE_LIMITS.pairingAttemptsPerMinute,
      this.now().getTime(),
    );
  }
  private async initializeIdentity(
    relayUrl: string,
  ): Promise<PersistedRemoteAccess> {
    if (this.storeError || !this.storageAvailable) return this.requireData();
    this.identityInitialization ??= createRemoteAccessIdentity(
      this.options.store,
      relayUrl,
    ).then(({ data, hostKeyPair }) => {
      if (this.stopped) return;
      this.data = data;
      this.hostKeyPair = hostKeyPair;
      this.scheduleSweep();
    }).catch((error: unknown) => {
      this.failClosedStore(
        "The encrypted Remote Companion store could not be created.",
      );
      throw error;
    }).finally(() => {
      this.identityInitialization = null;
    });
    await this.identityInitialization;
    return this.requireData();
  }
  private disableLiveRemoteAccess(): void {
    this.invitation = null;
    const socket = this.disconnect("disabled", false, false);
    terminateRemoteSocket(socket);
    this.forgetRemoteTranscripts();
  }
  private forgetRemoteTranscripts(): void {
    try {
      this.options.runtime.forgetRemoteTranscripts?.({ kind: "all" });
    } catch {
      return;
    }
  }
  private pairingIsCurrent(requestId: string, pending: PendingRemotePairing): boolean {
    return this.pendingPairings.get(requestId) === pending
      && this.relayMessages.owns(pending.connectionId, pending.connectionEpoch)
      && Date.parse(pending.expiresAt) > this.now().getTime();
  }
  private requireData(): PersistedRemoteAccess {
    if (!this.data || this.storeError) {
      throw new Error(
        this.storeError ?? "Remote Companion is unavailable.",
      );
    }
    return this.data;
  }
  private requireHostKeyPair(): RemoteImportedKeyPair {
    if (!this.hostKeyPair) {
      throw new Error("The Remote Companion identity is unavailable.");
    }
    return this.hostKeyPair;
  }
  private requireEndpointKeyPair(): NonNullable<
    PersistedRemoteAccess["endpointKeyPair"]
  > {
    const value = this.requireData().endpointKeyPair;
    if (!value) throw new Error("The relay endpoint identity is unavailable.");
    return value;
  }
  private persist(): Promise<void> {
    return this.persistence.save(this.requireData());
  }
  private async serializeAuthorityMutation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.stopped) throw new Error("Remote Companion is shutting down.");
    const pending = this.authorityMutationTail.then(operation);
    this.authorityMutationTail = pending.then(
      () => undefined,
      () => undefined,
    );
    return await pending;
  }
  private async persistAuthorityReduction<T>(mutate: () => T,
    remainsCurrent?: () => boolean): Promise<T> {
    await this.beginAuthorityReduction();
    if (remainsCurrent && !remainsCurrent()) {
      await this.completeAuthorityReduction();
      throw new Error("That pairing request is no longer pending.");
    }
    let result: T;
    try {
      result = mutate();
    } catch (error) {
      this.failClosedStore("Remote Companion could not safely apply its authority update.");
      throw error;
    }
    await this.persist();
    await this.completeAuthorityReduction();
    return result;
  }
  private async beginAuthorityReduction(): Promise<void> {
    try {
      await this.options.store.beginAuthorityReduction();
    } catch (error) {
      this.failClosedStore("Remote Companion could not durably reduce its authority.");
      throw error;
    }
  }
  private async completeAuthorityReduction(): Promise<void> {
    try {
      await this.options.store.completeAuthorityReduction();
    } catch (error) {
      this.failClosedStore("Remote Companion could not complete its authority update.");
      throw error;
    }
  }
  private failClosedStore(message: string): void {
    if (this.storeError) return;
    this.storeError = message;
    if (this.data) this.data.enabled = false;
    this.hostKeyPair = null;
    this.invitation = null;
    this.pendingPairings.clear();
    this.pairingRequestIds.clear();
    this.pairingAttemptTimes = [];
    this.sessionAuthenticationBudget.clear();
    this.relayMessages.reset();
    this.sessionAdmissions.clear();
    this.sessions.clear();
    this.sessionByConnection.clear();
    this.forgetRemoteTranscripts();
    this.clearReconnect();
    this.clearRegistrationDeadline();
    if (this.sweepTimer) this.clearTimer(this.sweepTimer);
    this.sweepTimer = null;
    const socket = this.socket;
    this.socket = null;
    terminateRemoteSocket(socket);
    this.connection = "disabled";
    this.connectionMessage = null;
    this.emitState();
  }
  private audit(
    type: RemoteAuditEvent["type"],
    deviceId: string | null,
    detail: string,
  ): void {
    appendRemoteAudit(
      this.requireData(),
      type,
      deviceId,
      detail,
      this.now(),
    );
  }
  private emitState(): void {
    this.options.onStateChange?.(this.state());
  }
}
