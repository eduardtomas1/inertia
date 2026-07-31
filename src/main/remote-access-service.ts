import WebSocket from "ws";
import {
  importRemotePublicKey,
  openPairingRequest, openSessionData,
  sealPairingResponse,
  type RemoteImportedKeyPair,
} from "../shared/remote-crypto";
import {
  REMOTE_LIMITS,
  REMOTE_PROTOCOL_VERSION,
  REMOTE_RELAY_VERSION,
  encodedRemoteFrameBytes,
  remoteCipherFrameSchema,
  remotePairingRequestPayloadSchema, remoteRequestSchema,
  type RelayClientMessage,
  type RemoteAccessState,
  type RemoteAuditEvent,
  type RemoteCipherFrame,
  type RemotePairingInvitation,
  type RemoteRequest,
  type RemoteResponse,
  type RemoteScope,
} from "../shared/remote-protocol";
import type { PersistedRemoteAccess } from "./remote-access-store";
import { settleRemoteDeliveryOnDisconnect } from "./remote-access-delivery";
import {
  createRemoteAccessIdentity,
  loadRemoteAccessIdentity,
} from "./remote-access-identity";
import {
  closeRemoteSocket,
  REMOTE_SHUTDOWN_TIMEOUT_MS,
  RemoteSessionAuthenticationBudget,
  sendSequencedRemoteResponse,
  terminateRemoteSocket,
} from "./remote-access-lifecycle";
import {
  DEFAULT_REMOTE_GRANT_MS, DEFAULT_REMOTE_RELAY_URL, projectRemoteAccessState,
  remoteDeviceIsCurrent, remotePairingComparisonCode,
  remoteRelayErrorMessage, takeRemoteRate, trimRemoteArray, trimRemoteSet,
  validateRemoteRelayUrl,
} from "./remote-access-policy";
import {
  applyRemotePairingGrant,
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
} from "./remote-access-session-admission";
import { authenticateRemoteSession } from "./remote-access-session-handshake";
import type {
  ActiveRemoteSession, PendingRemotePairing, RemoteAccessServiceOptions,
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
  private invitation: RemotePairingInvitation | null = null;
  private readonly pendingPairings = new Map<string, PendingRemotePairing>();
  private readonly sessions = new Map<string, ActiveRemoteSession>();
  private readonly sessionByConnection = new Map<string, string>();
  private readonly sessionAdmissions: RemoteSessionAdmissions;
  private readonly relayMessages: RemoteRelayDispatcher;
  private readonly requests: RemoteRequestDispatcher;
  private readonly pairingRequestIds = new Set<string>();
  private pairingAttemptTimes: number[] = [];
  private readonly sessionAuthenticationBudget =
    new RemoteSessionAuthenticationBudget();
  private reconnectAttempt = 0;
  private reconnectTimer: Timer | null = null;
  private sweepTimer: Timer | null = null;
  private privacyLocked = false;
  private stopped = false;
  private storeError: string | null = null;
  private identityInitialization: Promise<void> | null = null;
  private readonly persistence: RemoteAccessPersistenceQueue;

  private constructor(
    private readonly options: RemoteAccessServiceOptions,
    data: PersistedRemoteAccess | null,
    hostKeyPair: RemoteImportedKeyPair | null,
    private readonly storageAvailable = true,
  ) {
    this.data = data;
    this.hostKeyPair = hostKeyPair;
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
    this.sessionAdmissions = new RemoteSessionAdmissions({
      capacity: REMOTE_LIMITS.sessions,
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
      registered: () => this.relayRegistered(),
      error: (code) => this.relayError(code),
      frame: async (id, epoch, frame) => {
        if (!this.stopped) await this.handleFrame(id, epoch, frame);
      },
      invalidated: (id, epoch) => {
        this.sessionAdmissions.drop(id, epoch);
      },
      disconnected: (id, epoch) => this.dropConnection(id, epoch),
      oversized: () => this.socket?.close(1009, "message too large"),
    });
    this.requests = new RemoteRequestDispatcher({
      runtime: options.runtime,
      data: () => this.requireData(),
      now: () => this.now(),
      persist: async () => await this.persist(),
      audit: (type, deviceId, detail) => this.audit(type, deviceId, detail),
      isCurrent: (session) => this.sessions.get(session.sessionId) === session,
      authorizePromptCommit: (session) => remoteSessionCanCommitPrompt({
        data: this.data, session,
        live: this.sessions.get(session.sessionId) === session,
        ownsRoute: this.relayMessages.owns(
          session.connectionId, session.connectionEpoch),
        privacyLocked: this.privacyLocked, stopped: this.stopped,
        storeFailed: this.storeError !== null, now: this.now().getTime(),
      }),
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
    });
  }

  startConnections(): void {
    if (this.data?.enabled) this.connect();
  }

  async setEnabled(enabled: boolean, relayUrl?: string): Promise<void> {
    const normalizedRelay = relayUrl === undefined
      ? undefined
      : validateRemoteRelayUrl(relayUrl);
    if (!enabled && !this.data) return;
    const data = this.data ?? await this.initializeIdentity(
      normalizedRelay ?? DEFAULT_REMOTE_RELAY_URL,
    );
    if (normalizedRelay !== undefined) data.relayUrl = normalizedRelay;
    if (!enabled) {
      const changed = data.enabled;
      data.enabled = false;
      if (changed) {
        this.audit(
          "remote.disabled",
          null,
          "Remote Companion disabled.",
        );
      }
      this.invitation = null;
      const socket = this.disconnect("disabled", false, false);
      terminateRemoteSocket(socket);
      await this.persist();
      this.emitState();
      return;
    }
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
  }

  async createInvitation(): Promise<RemotePairingInvitation> {
    const data = this.requireData();
    if (!data.enabled) throw new Error("Enable Remote Companion first.");
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
    const devicePublicKey = await importRemotePublicKey(
      pending.payload.devicePublicKey,
    );
    if (
      this.pendingPairings.get(requestId) !== pending
      || !this.relayMessages.owns(
        pending.connectionId,
        pending.connectionEpoch,
      )
      || Date.parse(pending.expiresAt) <= this.now().getTime()
    ) {
      throw new Error("That pairing request is no longer pending.");
    }
    const { device, replaced } = applyRemotePairingGrant({
      data,
      pending,
      scopes,
      projectIds,
      grantMs,
      now: this.now(),
    });
    this.pendingPairings.delete(requestId);
    this.audit("pairing.accepted", device.id, "A device was paired.");
    await this.persist();
    if (replaced) this.closeDeviceSessions(device.id, "revoked", false);
    const frame = await sealPairingResponse(
      this.requireHostKeyPair(),
      devicePublicKey,
      requestId,
      {
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
    this.sendFrame(pending.connectionId, frame);
    this.emitState();
  }

  async denyPairing(requestId: string): Promise<void> {
    const pending = this.pendingPairings.get(requestId);
    if (!pending) return;
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
    const device = revokeRemoteDevice(
      this.requireData(),
      deviceId,
      this.now(),
    );
    if (!device) return;
    this.audit("device.revoked", device.id, "A paired device was revoked.");
    this.closeDeviceSessions(device.id, "revoked", false);
    await this.persist();
    this.emitState();
  }

  async updateDevice(
    deviceId: string,
    scopes: RemoteScope[],
    projectIds: string[],
    expiresAt: string,
  ): Promise<void> {
    const device = updateRemoteDeviceGrant({
      data: this.requireData(),
      deviceId,
      scopes,
      projectIds,
      expiresAt,
      now: this.now(),
    });
    this.audit("device.scope-changed", device.id, "Device permissions changed.");
    this.closeDeviceSessions(device.id, "revoked", false);
    await this.persist();
    this.emitState();
  }

  setPrivacyLocked(locked: boolean): void {
    if (this.privacyLocked === locked) return;
    this.privacyLocked = locked;
    if (locked) this.disconnect("shutdown", true);
    else if (this.data?.enabled) this.connect();
    this.emitState();
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
    await this.persistence.drain();
  }

  private connect(): void {
    const data = this.data;
    if (
      !data?.enabled
      || this.stopped
      || this.privacyLocked
      || this.socket
    ) return;
    this.connection = "connecting";
    this.connectionMessage = null;
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
      this.sendRelay({
        protocolVersion: REMOTE_PROTOCOL_VERSION,
        type: "relay.register",
        endpointId: data.endpointId,
        role: "desktop",
        relayVersion: REMOTE_RELAY_VERSION,
      });
    });
    socket.on("message", (raw, isBinary) => {
      if (this.socket !== socket || isBinary) return;
      this.relayMessages.receive(raw);
    });
    socket.once("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.connection = this.privacyLocked ? "offline" : "offline";
      this.connectionMessage = this.privacyLocked
        ? "Remote Companion is paused while the desktop is locked."
        : "The relay is offline.";
      this.relayMessages.reset();
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

  private relayRegistered(): void {
    this.connection = "online";
    this.connectionMessage = null;
    this.reconnectAttempt = 0;
    this.emitState();
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
    if (frame.kind === "pair.request") {
      await this.handlePairingRequest(connectionId, epoch, frame);
      return;
    }
    if (frame.kind === "session.open") {
      await this.handleSessionOpen(connectionId, epoch, frame);
      return;
    }
    if (frame.kind === "session.data") {
      await this.handleSessionData(connectionId, epoch, frame);
      return;
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
    const data = this.requireData();
    const admission = this.sessionAdmissions.reserve(
      connectionId,
      epoch,
      frame.sessionId,
    );
    if (!admission) return;
    try {
      const hostKeys = this.requireHostKeyPair();
      for (const device of data.devices) {
        if (!remoteDeviceIsCurrent(device, this.now().getTime())) continue;
        const authenticated = await authenticateRemoteSession({
          data,
          device,
          frame,
          hostKeys,
          now: () => this.now(),
          current: () => this.sessionAdmissions.owns(admission),
        });
        if (authenticated === "stale") return;
        if (!authenticated) continue;
        if (
          !data.devices.includes(device)
          || !remoteDeviceIsCurrent(device, this.now().getTime())
          || authenticated.subject.grantVersion !== device.grantVersion
          || !this.sessionAdmissions.bindDevice(admission, device.id)
        ) return;
        const now = this.now().getTime();
        data.usedSessions.push({
          id: frame.sessionId,
          createdAt: this.now().toISOString(),
        });
        trimRemoteArray(data.usedSessions, REMOTE_LIMITS.deliveryReceipts);
        const session: ActiveRemoteSession = {
          connectionId,
          connectionEpoch: epoch,
          sessionId: frame.sessionId,
          device,
          recipient: authenticated.recipient,
          sender: authenticated.sender,
          subject: authenticated.subject,
          createdAt: now,
          lastActivityAt: now,
          requestTimes: [],
          promptTimes: [],
          inFlight: new Map(),
          postedPromptDeliveries: new Set(),
          outboundTail: Promise.resolve(),
        };
        device.lastSeenAt = this.now().toISOString();
        this.audit("session.connected", device.id, "A remote session connected.");
        await this.persist();
        if (!this.sessionAdmissions.owns(admission)) return;
        this.sessions.set(frame.sessionId, session);
        this.sessionByConnection.set(connectionId, frame.sessionId);
        this.sendFrame(connectionId, {
          protocolVersion: REMOTE_PROTOCOL_VERSION,
          kind: "session.accept",
          sessionId: frame.sessionId,
          enc: authenticated.sender.enc,
          ciphertext: authenticated.ciphertext,
        });
        this.emitState();
        return;
      }
    } finally {
      this.sessionAdmissions.release(admission);
    }
  }

  private async handleSessionData(
    connectionId: string,
    epoch: RemoteConnectionEpoch,
    frame: Extract<RemoteCipherFrame, { kind: "session.data" }>,
  ): Promise<void> {
    const session = this.sessions.get(frame.sessionId);
    if (
      !session
      || session.connectionId !== connectionId
      || session.connectionEpoch !== epoch
    ) return;
    if (!remoteDeviceIsCurrent(session.device, this.now().getTime())) {
      this.closeSession(session, "expired");
      return;
    }
    if (!takeRemoteRate(
      session.requestTimes,
      REMOTE_LIMITS.requestsPerMinute,
      this.now().getTime(),
    )) {
      this.closeSession(session, "rate-limited");
      return;
    }
    let request: RemoteRequest;
    try {
      request = remoteRequestSchema.parse(
        await openSessionData(session.recipient, frame),
      );
    } catch {
      this.closeSession(session, "replay");
      return;
    }
    if (!this.relayMessages.owns(connectionId, epoch)) return;
    session.lastActivityAt = this.now().getTime();
    if (
      request.type === "prompt.send"
      && !takeRemoteRate(
        session.promptTimes,
        REMOTE_LIMITS.promptRequestsPerMinute,
        this.now().getTime(),
      )
    ) {
      await this.respond(session, {
        type: "response",
        requestId: request.requestId,
        ok: false,
        code: "rate-limited",
        message: "Remote prompting is temporarily rate limited.",
      });
      return;
    }
    if (
      session.inFlight.size >= REMOTE_LIMITS.inFlightRequestsPerSession
      || session.inFlight.has(request.requestId)
    ) {
      await this.respond(session, {
        type: "response",
        requestId: request.requestId,
        ok: false,
        code: "busy",
        message: "Too many remote requests are active.",
      });
      return;
    }
    session.inFlight.set(request.requestId, request);
    void this.requests.dispatch(session, request).catch(() => {
      this.relayMessages.invalidate(
        session.connectionId,
        session.connectionEpoch,
      );
      this.dropConnection(session.connectionId, session.connectionEpoch);
    });
  }

  private async respond(
    session: ActiveRemoteSession,
    response: RemoteResponse,
  ): Promise<void> {
    await sendSequencedRemoteResponse(
      session,
      response,
      () => this.sessions.get(session.sessionId) === session
        && this.relayMessages.owns(
          session.connectionId,
          session.connectionEpoch,
        ),
      (connectionId, frame) => this.sendFrame(connectionId, frame),
    );
  }

  private sendFrame(connectionId: string, frame: RemoteCipherFrame): void {
    if (!remoteCipherFrameSchema.safeParse(frame).success) return;
    if (encodedRemoteFrameBytes(frame) > REMOTE_LIMITS.encryptedFrameBytes) return;
    this.sendRelay({
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      type: "relay.frame",
      connectionId,
      frame,
    });
  }

  private sendRelay(message: RelayClientMessage): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const serialized = JSON.stringify(message);
    if (
      new TextEncoder().encode(serialized).byteLength
      > REMOTE_LIMITS.relayEnvelopeBytes
    ) return;
    socket.send(serialized);
  }

  private closeDeviceSessions(
    deviceId: string,
    reason: Extract<RemoteCipherFrame, { kind: "session.close" }>["reason"],
    persistChanges = true,
  ): void {
    this.sessionAdmissions.dropDevice(deviceId);
    for (const session of this.sessions.values()) {
      if (session.device.id === deviceId) {
        this.closeSession(session, reason, persistChanges);
      }
    }
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
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.close(1000, "desktop unavailable");
    } catch {
      socket?.terminate();
    }
    this.clearReconnect();
    this.connection = this.data?.enabled ? "offline" : "disabled";
    this.connectionMessage = this.privacyLocked
      ? "Remote Companion is paused while the desktop is locked."
      : null;
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

  private persist(): Promise<void> {
    return this.persistence.save(this.requireData());
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
    this.clearReconnect();
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
