import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import {
  createAuthenticatedSessionRecipient, createAuthenticatedSessionSender,
  importRemotePublicKey,
  openPairingRequest, openSessionData, openSessionHandshake, remoteRandomSecret,
  sealPairingResponse, sealSessionData, sealSessionHandshake,
  type RemoteImportedKeyPair,
} from "../shared/remote-crypto";
import {
  REMOTE_LIMITS,
  REMOTE_PROTOCOL_VERSION,
  REMOTE_RELAY_VERSION,
  encodedRemoteFrameBytes,
  relayServerMessageSchema,
  remoteCipherFrameSchema,
  remotePairingRequestPayloadSchema,
  remoteRequestSchema,
  remoteSessionOpenPayloadSchema,
  type RelayClientMessage,
  type RemoteAccessState,
  type RemoteAuditEvent,
  type RemoteAuthorizationSubject,
  type RemoteCipherFrame,
  type RemotePairingInvitation,
  type RemoteRequest,
  type RemoteResponse,
  type RemoteScope,
} from "../shared/remote-protocol";
import { sanitizeRemoteLabel } from "../shared/remote-sanitizer";
import type {
  PersistedRemoteAccess, PersistedRemoteDevice,
} from "./remote-access-store";
import {
  acceptRemoteDelivery,
  markRemoteDeliveryUncertain,
  prepareRemoteDelivery,
} from "./remote-access-delivery";
import {
  createRemoteAccessIdentity,
  loadRemoteAccessIdentity,
} from "./remote-access-identity";
import {
  closeRemoteSocket,
  REMOTE_SHUTDOWN_TIMEOUT_MS,
  RemoteSessionAuthenticationBudget,
} from "./remote-access-lifecycle";
import {
  DEFAULT_REMOTE_GRANT_MS, MAX_REMOTE_GRANT_MS, MINUTE_MS,
  normalizeRemoteProjectIds, normalizeRemoteScopes, projectRemoteAccessState,
  remoteDeviceIsCurrent, remotePairingComparisonCode,
  remoteRawDataByteLength, remoteRawDataText, remoteRelayErrorMessage,
  takeRemoteRate, trimRemoteArray, trimRemoteSet, validateRemoteRelayUrl,
} from "./remote-access-policy";
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
  private persistQueue: Promise<void> = Promise.resolve();

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
      maxPayload: REMOTE_LIMITS.encryptedFrameBytes + 4_096,
      handshakeTimeout: RELAY_HANDSHAKE_TIMEOUT_MS,
    }));
  }

  static async create(
    options: RemoteAccessServiceOptions,
  ): Promise<RemoteAccessService> {
    const identity = await loadRemoteAccessIdentity(options.store);
    if (identity.kind === "ready") {
      const service = new RemoteAccessService(options, identity.data,
        identity.hostKeyPair);
      service.scheduleSweep();
      if (identity.data.enabled) service.connect();
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

  async setEnabled(enabled: boolean, relayUrl?: string): Promise<void> {
    const normalizedRelay = relayUrl === undefined
      ? undefined
      : validateRemoteRelayUrl(relayUrl);
    if (!enabled && !this.data) return;
    const data = this.data ?? await this.initializeIdentity(
      normalizedRelay ?? "ws://127.0.0.1:8787",
    );
    if (normalizedRelay !== undefined) data.relayUrl = normalizedRelay;
    if (enabled === data.enabled) {
      if (enabled && !this.socket) this.connect();
      await this.persist();
      return;
    }
    data.enabled = enabled;
    this.audit(enabled ? "remote.enabled" : "remote.disabled", null,
      enabled ? "Remote Companion enabled." : "Remote Companion disabled.");
    await this.persist();
    if (enabled) this.connect();
    else this.disconnect("disabled", false);
    this.emitState();
  }

  async createInvitation(): Promise<RemotePairingInvitation> {
    const data = this.requireData();
    if (!data.enabled) throw new Error("Enable Remote Companion first.");
    if (this.pendingPairings.size >= REMOTE_LIMITS.pendingPairings) {
      throw new Error("Too many pairing requests are pending.");
    }
    const invitation: RemotePairingInvitation = {
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      relayUrl: data.relayUrl,
      endpointId: data.endpointId,
      hostId: data.hostId,
      hostPublicKey: data.keyPair.publicKey,
      invitationId: randomUUID(),
      pairingSecret: remoteRandomSecret(),
      expiresAt: new Date(
        this.now().getTime() + REMOTE_LIMITS.pairingTtlMs,
      ).toISOString(),
    };
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
    if (Date.parse(pending.expiresAt) <= this.now().getTime()) {
      this.pendingPairings.delete(requestId);
      throw new Error("That pairing request expired.");
    }
    const normalizedScopes = normalizeRemoteScopes(scopes);
    const normalizedProjects = normalizeRemoteProjectIds(projectIds);
    if (
      data.devices.filter(({ revokedAt }) => revokedAt === null).length
      >= REMOTE_LIMITS.devices
    ) throw new Error("The paired-device limit has been reached.");
    const expiresAt = new Date(
      this.now().getTime() + Math.max(
        MINUTE_MS,
        Math.min(Math.trunc(grantMs), MAX_REMOTE_GRANT_MS),
      ),
    ).toISOString();
    const device: PersistedRemoteDevice = {
      id: pending.payload.deviceId,
      label: pending.payload.deviceLabel,
      publicKey: pending.payload.devicePublicKey,
      scopes: normalizedScopes,
      projectIds: normalizedProjects,
      createdAt: this.now().toISOString(),
      expiresAt,
      lastSeenAt: null,
      revokedAt: null,
      grantVersion: 1,
    };
    const existing = data.devices.findIndex(({ id }) => id === device.id);
    if (existing >= 0) {
      const previous = data.devices[existing]!;
      device.createdAt = previous.createdAt;
      device.grantVersion = previous.grantVersion + 1;
      data.devices[existing] = device;
    } else {
      data.devices.push(device);
    }
    this.pendingPairings.delete(requestId);
    this.invitation = null;
    this.audit("pairing.accepted", device.id, "A device was paired.");
    await this.persist();
    const frame = await sealPairingResponse(
      this.requireHostKeyPair(),
      await importRemotePublicKey(device.publicKey),
      requestId,
      {
        type: "pair.accepted",
        requestId,
        deviceId: device.id,
        hostId: data.hostId,
        scopes: device.scopes,
        projectIds: device.projectIds,
        expiresAt,
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
    this.invitation = null;
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
    const device = this.requireDevice(deviceId);
    if (device.revokedAt) return;
    device.revokedAt = this.now().toISOString();
    device.grantVersion += 1;
    this.audit("device.revoked", device.id, "A paired device was revoked.");
    this.closeDeviceSessions(device.id, "revoked");
    await this.persist();
    this.emitState();
  }

  async updateDevice(
    deviceId: string,
    scopes: RemoteScope[],
    projectIds: string[],
    expiresAt: string,
  ): Promise<void> {
    const device = this.requireDevice(deviceId);
    const expiry = Date.parse(expiresAt);
    if (
      !Number.isFinite(expiry)
      || expiry <= this.now().getTime()
      || expiry > this.now().getTime() + MAX_REMOTE_GRANT_MS
    ) throw new Error("Choose an expiry within 90 days.");
    device.scopes = normalizeRemoteScopes(scopes);
    device.projectIds = normalizeRemoteProjectIds(projectIds);
    device.expiresAt = new Date(expiry).toISOString();
    device.grantVersion += 1;
    this.audit("device.scope-changed", device.id, "Device permissions changed.");
    this.closeDeviceSessions(device.id, "revoked");
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
    await this.persistQueue.catch(() => undefined);
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
      this.handleRelayMessage(raw);
    });
    socket.once("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.connection = this.privacyLocked ? "offline" : "offline";
      this.connectionMessage = this.privacyLocked
        ? "Remote Companion is paused while the desktop is locked."
        : "The relay is offline.";
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

  private handleRelayMessage(raw: import("ws").RawData): void {
    if (remoteRawDataByteLength(raw) > REMOTE_LIMITS.encryptedFrameBytes + 4_096) {
      this.socket?.close(1009, "message too large");
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
    if (message.type === "relay.registered") {
      this.connection = "online";
      this.connectionMessage = null;
      this.reconnectAttempt = 0;
      this.emitState();
      return;
    }
    if (message.type === "relay.error") {
      this.connectionMessage = remoteRelayErrorMessage(message.code);
      this.emitState();
      return;
    }
    if (message.type === "relay.peer-disconnected") {
      this.dropConnection(message.connectionId);
      return;
    }
    if (message.type !== "relay.frame") return;
    if (encodedRemoteFrameBytes(message.frame) > REMOTE_LIMITS.encryptedFrameBytes) {
      this.dropConnection(message.connectionId);
      return;
    }
    void this.handleFrame(message.connectionId, message.frame).catch(() => {
      this.dropConnection(message.connectionId);
    });
  }

  private async handleFrame(
    connectionId: string,
    frame: RemoteCipherFrame,
  ): Promise<void> {
    if (frame.kind === "pair.request") {
      await this.handlePairingRequest(connectionId, frame);
      return;
    }
    if (frame.kind === "session.open") {
      await this.handleSessionOpen(connectionId, frame);
      return;
    }
    if (frame.kind === "session.data") {
      await this.handleSessionData(connectionId, frame);
      return;
    }
    if (frame.kind === "session.close") {
      this.dropConnection(connectionId);
    }
  }

  private async handlePairingRequest(
    connectionId: string,
    frame: Extract<RemoteCipherFrame, { kind: "pair.request" }>,
  ): Promise<void> {
    const invitation = this.invitation;
    if (
      !invitation
      || invitation.invitationId !== frame.invitationId
      || Date.parse(invitation.expiresAt) <= this.now().getTime()
      || !this.takePairingAttempt()
    ) return;
    const payload = remotePairingRequestPayloadSchema.parse(
      await openPairingRequest(
        invitation,
        this.requireHostKeyPair(),
        frame,
      ),
    );
    if (
      payload.invitationId !== invitation.invitationId
      || Math.abs(Date.parse(payload.createdAt) - this.now().getTime())
        > REMOTE_LIMITS.pairingTtlMs
      || this.pairingRequestIds.has(payload.requestId)
    ) return;
    const deviceLabel = sanitizeRemoteLabel(payload.deviceLabel, 80);
    if (!deviceLabel) return;
    payload.deviceLabel = deviceLabel;
    this.pairingRequestIds.add(payload.requestId);
    trimRemoteSet(this.pairingRequestIds, 512);
    this.pendingPairings.set(payload.requestId, {
      connectionId,
      payload,
      receivedAt: this.now().toISOString(),
      expiresAt: invitation.expiresAt,
      comparisonCode: remotePairingComparisonCode(
        invitation.hostPublicKey,
        payload.devicePublicKey,
        invitation.invitationId,
      ),
    });
    this.invitation = null;
    this.audit("pairing.requested", payload.deviceId, "A device requested pairing.");
    await this.persist();
    this.emitState();
  }

  private async handleSessionOpen(
    connectionId: string,
    frame: Extract<RemoteCipherFrame, { kind: "session.open" }>,
  ): Promise<void> {
    const data = this.requireData();
    if (
      this.sessions.size >= REMOTE_LIMITS.sessions
      || this.sessions.has(frame.sessionId)
      || data.usedSessions.some(({ id }) => id === frame.sessionId)
      || this.sessionByConnection.has(connectionId)
      || !this.sessionAuthenticationBudget.take(
        connectionId,
        this.now().getTime(),
      )
    ) return;
    const hostKeys = this.requireHostKeyPair();
    for (const device of data.devices) {
      if (!remoteDeviceIsCurrent(device, this.now().getTime())) continue;
      try {
        const recipient = await createAuthenticatedSessionRecipient(
          data.hostId,
          device.id,
          frame.sessionId,
          hostKeys,
          await importRemotePublicKey(device.publicKey),
          frame.enc,
        );
        const payload = remoteSessionOpenPayloadSchema.parse(
          await openSessionHandshake(
            recipient,
            "session.open",
            frame.sessionId,
            frame.ciphertext,
          ),
        );
        if (
          payload.sessionId !== frame.sessionId
          || payload.deviceId !== device.id
          || Math.abs(Date.parse(payload.createdAt) - this.now().getTime())
            > REMOTE_LIMITS.sessionHandshakeTtlMs
        ) continue;
        const sender = await createAuthenticatedSessionSender(
          data.hostId,
          device.id,
          frame.sessionId,
          hostKeys,
          await importRemotePublicKey(device.publicKey),
        );
        const subject: RemoteAuthorizationSubject = {
          deviceId: device.id,
          sessionId: frame.sessionId,
          scopes: [...device.scopes],
          projectIds: [...device.projectIds],
          grantVersion: device.grantVersion,
          expiresAt: device.expiresAt,
        };
        const ciphertext = await sealSessionHandshake(
          sender,
          "session.accept",
          frame.sessionId,
          {
            type: "session.accept",
            sessionId: frame.sessionId,
            hostId: data.hostId,
            grantVersion: device.grantVersion,
            scopes: device.scopes,
            projectIds: device.projectIds,
            expiresAt: device.expiresAt,
            serverTime: this.now().toISOString(),
          },
        );
        const now = this.now().getTime();
        data.usedSessions.push({
          id: frame.sessionId,
          createdAt: this.now().toISOString(),
        });
        trimRemoteArray(data.usedSessions, REMOTE_LIMITS.deliveryReceipts);
        this.sessions.set(frame.sessionId, {
          connectionId,
          sessionId: frame.sessionId,
          device,
          recipient,
          sender,
          subject,
          createdAt: now,
          lastActivityAt: now,
          requestTimes: [],
          promptTimes: [],
          inFlight: new Map(),
        });
        this.sessionByConnection.set(connectionId, frame.sessionId);
        device.lastSeenAt = this.now().toISOString();
        this.audit("session.connected", device.id, "A remote session connected.");
        await this.persist();
        this.sendFrame(connectionId, {
          protocolVersion: REMOTE_PROTOCOL_VERSION,
          kind: "session.accept",
          sessionId: frame.sessionId,
          enc: sender.enc,
          ciphertext,
        });
        this.emitState();
        return;
      } catch (error) {
        if (this.sessions.has(frame.sessionId)) throw error;
        // Try the next bounded paired-device key without revealing which failed.
      }
    }
  }

  private async handleSessionData(
    connectionId: string,
    frame: Extract<RemoteCipherFrame, { kind: "session.data" }>,
  ): Promise<void> {
    const session = this.sessions.get(frame.sessionId);
    if (!session || session.connectionId !== connectionId) return;
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
    try {
      const receiptResponse = request.type === "prompt.send"
        ? await this.prepareDelivery(session, request)
        : null;
      const response = receiptResponse
        ?? await this.options.runtime.remoteRequest(session.subject, request);
      if (request.type === "prompt.send" && response.ok) {
        await this.acceptDelivery(session, request, response);
      }
      if (this.sessions.get(session.sessionId) === session) {
        await this.respond(session, response);
      }
    } catch {
      if (request.type === "prompt.send") {
        await this.markDeliveryUncertain(session, request);
      }
      if (this.sessions.get(session.sessionId) === session) {
        await this.respond(session, {
          type: "response",
          requestId: request.requestId,
          ok: false,
          code: request.type === "prompt.send" ? "uncertain" : "unavailable",
          message: request.type === "prompt.send"
            ? "Prompt delivery is uncertain. Do not retry automatically."
            : "The local runtime is unavailable.",
        });
      }
    } finally {
      session.inFlight.delete(request.requestId);
    }
  }

  private async prepareDelivery(
    session: ActiveRemoteSession,
    request: Extract<RemoteRequest, { type: "prompt.send" }>,
  ): Promise<RemoteResponse | null> {
    const data = this.requireData();
    const prepared = prepareRemoteDelivery(
      data,
      session.device.id,
      request,
      this.now().toISOString(),
    );
    if (prepared.changed) await this.persist();
    return prepared.response;
  }

  private async acceptDelivery(
    session: ActiveRemoteSession,
    request: Extract<RemoteRequest, { type: "prompt.send" }>,
    response: RemoteResponse,
  ): Promise<void> {
    if (!acceptRemoteDelivery(this.requireData(), request, response)) return;
    this.audit("prompt.accepted", session.device.id, "A remote text prompt was accepted.");
    await this.persist();
  }

  private async markDeliveryUncertain(
    session: ActiveRemoteSession,
    request: Extract<RemoteRequest, { type: "prompt.send" }>,
  ): Promise<void> {
    if (!markRemoteDeliveryUncertain(
      this.requireData(),
      request.deliveryId,
    )) return;
    this.audit("prompt.uncertain", session.device.id, "A remote prompt has uncertain delivery.");
    await this.persist();
  }

  private async respond(
    session: ActiveRemoteSession,
    response: RemoteResponse,
  ): Promise<void> {
    const frame = await sealSessionData(
      session.sender,
      session.sessionId,
      response,
    );
    this.sendFrame(session.connectionId, frame);
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
      > REMOTE_LIMITS.encryptedFrameBytes + 4_096
    ) return;
    socket.send(serialized);
  }

  private closeDeviceSessions(
    deviceId: string,
    reason: Extract<RemoteCipherFrame, { kind: "session.close" }>["reason"],
  ): void {
    for (const session of this.sessions.values()) {
      if (session.device.id === deviceId) this.closeSession(session, reason);
    }
  }

  private closeSession(
    session: ActiveRemoteSession,
    reason: Extract<RemoteCipherFrame, { kind: "session.close" }>["reason"],
  ): void {
    this.sendFrame(session.connectionId, {
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      kind: "session.close",
      sessionId: session.sessionId,
      reason,
    });
    this.dropConnection(session.connectionId);
  }

  private dropConnection(connectionId: string): void {
    this.sessionAuthenticationBudget.drop(connectionId);
    for (const [requestId, pending] of this.pendingPairings) {
      if (pending.connectionId === connectionId) {
        this.pendingPairings.delete(requestId);
      }
    }
    const sessionId = this.sessionByConnection.get(connectionId);
    if (!sessionId) {
      this.emitState();
      return;
    }
    const session = this.sessions.get(sessionId);
    this.sessionByConnection.delete(connectionId);
    this.sessions.delete(sessionId);
    if (session) {
      for (const request of session.inFlight.values()) {
        if (request.type === "prompt.send") {
          if (markRemoteDeliveryUncertain(
            this.requireData(),
            request.deliveryId,
          )) {
            this.audit(
              "prompt.uncertain",
              session.device.id,
              "A remote prompt has uncertain delivery.",
            );
          }
        }
      }
      this.audit("session.disconnected", session.device.id, "A remote session disconnected.");
      void this.persist().catch(() => undefined);
    }
    this.emitState();
  }

  private dropAllSessions(): void {
    for (const connectionId of this.sessionByConnection.keys()) {
      this.dropConnection(connectionId);
    }
    this.pendingPairings.clear();
  }

  private disconnect(
    reason: Extract<RemoteCipherFrame, { kind: "session.close" }>["reason"],
    reconnect: boolean,
  ): WebSocket | null {
    for (const session of this.sessions.values()) {
      this.sendFrame(session.connectionId, {
        protocolVersion: REMOTE_PROTOCOL_VERSION,
        kind: "session.close",
        sessionId: session.sessionId,
        reason,
      });
    }
    this.dropAllSessions();
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
    }).catch(() => {
      this.storeError = "The encrypted Remote Companion store could not be created.";
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

  private requireDevice(deviceId: string): PersistedRemoteDevice {
    const device = this.requireData().devices.find(({ id }) => id === deviceId);
    if (!device) throw new Error("That paired device was not found.");
    return device;
  }

  private persist(): Promise<void> {
    const data = this.requireData();
    trimRemoteArray(data.audit, REMOTE_LIMITS.auditEvents);
    trimRemoteArray(data.receipts, REMOTE_LIMITS.deliveryReceipts);
    const snapshot = structuredClone(data);
    const pending = this.persistQueue
      .catch(() => undefined)
      .then(async () => {
        await this.options.store.save(snapshot);
      });
    this.persistQueue = pending;
    return pending;
  }

  private audit(
    type: RemoteAuditEvent["type"],
    deviceId: string | null,
    detail: string,
  ): void {
    const data = this.requireData();
    data.audit.push({
      id: randomUUID(),
      type,
      deviceId,
      detail: sanitizeRemoteLabel(detail, 240) ?? "Remote event.",
      createdAt: this.now().toISOString(),
    });
    trimRemoteArray(data.audit, REMOTE_LIMITS.auditEvents);
  }

  private emitState(): void {
    this.options.onStateChange?.(this.state());
  }
}
