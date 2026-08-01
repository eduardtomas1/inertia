import {
  createAuthenticatedSessionRecipient,
  createAuthenticatedSessionSender,
  importRemotePublicKey,
  openPairingResponse,
  openSessionData,
  openSessionHandshake,
  remotePairingComparisonCode,
  sealPairingRequest,
  sealSessionData,
  sealSessionHandshake,
  type RemoteRecipientState,
  type RemoteSenderState,
} from "../../../src/shared/remote-crypto";
import {
  REMOTE_BROWSER_VERSION,
  REMOTE_LIMITS,
  REMOTE_PROTOCOL_VERSION,
  relayServerMessageSchema,
  remotePairingInvitationSchema,
  remotePairingResponsePayloadSchema,
  remoteResponseSchema,
  remoteSessionAcceptPayloadSchema,
  type RemotePairingInvitation,
  type RemoteCipherFrame,
  type RemoteRequest,
  type RemoteResponse,
  type RemoteSafeConversationDetail,
  type RemoteSafeShell,
} from "../../../src/shared/remote-protocol";
import {
  generateNonExtractableDeviceKeys,
  importDevicePublicKey,
} from "./device-keys";
import {
  clearDeviceProfile,
  loadSealedDeviceProfile,
  sealedProfileHasExpired,
  saveSealedDeviceProfile,
  validateBrowserRelayUrl,
  type SealedBrowserDeviceProfile,
} from "./device-store";
import {
  BrowserConnectionSupervisor,
  RemoteConnectionFailure,
  type RemoteConnectionSnapshot,
} from "./connection-supervisor";

const REQUEST_TIMEOUT_MS = 10_000;
const PROFILE_ACTIVITY_WRITE_INTERVAL_MS = 60 * 60 * 1_000;
const REMOTE_TEXT_ENCODER = new TextEncoder();

type BoundedRemoteRelayText =
  | { ok: true; value: string }
  | {
    ok: false;
    closeCode: 1003 | 1009;
    closeReason: string;
    message: string;
  };

export interface RemoteClientCallbacks {
  status(message: string, online: boolean): void;
  connection?(state: RemoteConnectionSnapshot): void;
  invalidated?(): void;
  pairingCode(code: string): void;
  shell(shell: RemoteSafeShell): void;
  detail(detail: RemoteSafeConversationDetail | null): void;
  promptResult(message: string, uncertain: boolean): void;
}

interface PendingRequest {
  request: RemoteRequest;
  timer: ReturnType<typeof setTimeout>;
  resolve(response: RemoteResponse): void;
  reject(error: Error): void;
}

export class RemoteCompanionClient {
  private profile: SealedBrowserDeviceProfile | null = null;
  private socket: WebSocket | null = null;
  private connectionId: string | null = null;
  private sessionId: string | null = null;
  private sender: RemoteSenderState | null = null;
  private recipient: RemoteRecipientState | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly openingSockets = new Set<WebSocket>();
  private inboundTail: Promise<void> = Promise.resolve();
  private outboundTail: Promise<void> = Promise.resolve();
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private pollGeneration = 0;
  private selectedConversationId: string | null = null;
  private attemptEpoch = 0;
  private profileWriteTail: Promise<void> = Promise.resolve();
  private lastProfileActivityWriteAt = 0;
  private connectionGeneration = 0;
  private readonly supervisor: BrowserConnectionSupervisor;

  constructor(private readonly callbacks: RemoteClientCallbacks) {
    this.supervisor = new BrowserConnectionSupervisor({
      attempt: async (generation) => await this.connectOnce(generation),
      invalidate: (message) => {
        this.attemptEpoch += 1;
        this.disconnectTransport(message);
      },
      foreground: (generation) => {
        if (generation !== this.connectionGeneration || !this.sender) return;
        this.refreshOrDisconnect(
          this.attemptEpoch,
          this.replacePollingLoop(),
        );
      },
      expiresAt: () => this.profile?.expiresAt ?? null,
      expired: async () => await this.clearExpiredProfile(),
      state: (state) => this.publishConnectionState(state),
    });
  }

  async initialize(): Promise<SealedBrowserDeviceProfile | null> {
    const epoch = ++this.attemptEpoch;
    const profile = await loadSealedDeviceProfile();
    if (!this.ownsAttempt(epoch)) return this.profile;
    this.profile = profile;
    if (this.profile && Date.parse(this.profile.expiresAt) > Date.now()) {
      void this.supervisor.start();
    } else if (this.profile) {
      await this.forgetExpiredProfile(epoch);
    } else {
      this.callbacks.status("Paste a short-lived invitation from the desktop.", false);
    }
    return this.profile;
  }

  private async forgetExpiredProfile(epoch: number): Promise<void> {
    this.profile = null;
    await this.profileWriteTail.catch(() => undefined);
    if (!this.ownsAttempt(epoch)) return;
    await clearDeviceProfile().catch(() => undefined);
    if (!this.ownsAttempt(epoch)) return;
    this.callbacks.status("This device grant expired. Pair it again.", false);
  }

  currentProfile(): SealedBrowserDeviceProfile | null {
    return this.profile;
  }

  async forget(): Promise<void> {
    this.supervisor.stop("This browser was forgotten.");
    await this.profileWriteTail.catch(() => undefined);
    await clearDeviceProfile();
    this.profile = null;
  }

  async pair(invitationText: string, deviceLabel: string): Promise<void> {
    const epoch = this.beginAttempt("Starting pairing.");
    try {
      const invitation = remotePairingInvitationSchema.parse(
        JSON.parse(invitationText) as unknown,
      );
      const relayUrl = validateBrowserRelayUrl(invitation.relayUrl);
      if (Date.parse(invitation.expiresAt) <= Date.now()) {
        throw new Error("That pairing invitation expired.");
      }
      const label = deviceLabel.trim().slice(0, 80);
      if (!label) throw new Error("Enter a name for this browser.");
      const deviceKeys = await generateNonExtractableDeviceKeys();
      if (!this.ownsAttempt(epoch)) return;
      const deviceId = crypto.randomUUID();
      const requestId = crypto.randomUUID();
      const tunnel = await this.openOwnedTunnel(
        epoch,
        relayUrl,
        invitation.endpointId,
      );
      if (!tunnel) return;
      this.socket = tunnel.socket;
      this.connectionId = tunnel.connectionId;
      const code = await remotePairingComparisonCode(
        invitation.hostPublicKey,
        deviceKeys.publicKey,
        invitation.invitationId,
      );
      if (!this.ownsAttempt(epoch)) return;
      this.callbacks.pairingCode(code);
      const frame = await sealPairingRequest(invitation, {
        type: "pair.request",
        requestId,
        invitationId: invitation.invitationId,
        deviceId,
        deviceLabel: label,
        devicePublicKey: deviceKeys.publicKey,
        createdAt: new Date().toISOString(),
        browserVersion: REMOTE_BROWSER_VERSION,
      });
      if (!this.ownsAttempt(epoch)) return;
      sendFrame(tunnel.socket, tunnel.connectionId, frame);
      this.callbacks.status(
        "Compare the code on both devices, then approve on the desktop.",
        false,
      );
      const responseFrame = await waitForRelayFrame(
        tunnel.socket,
        (candidate) =>
          candidate.kind === "pair.response"
          && candidate.requestId === requestId,
        Math.max(1, Date.parse(invitation.expiresAt) - Date.now()),
      );
      if (!this.ownsAttempt(epoch)) return;
      if (responseFrame.kind !== "pair.response") {
        throw new Error("The pairing response was invalid.");
      }
      const response = remotePairingResponsePayloadSchema.parse(
        await openPairingResponse(
          deviceKeys.keyPair,
          await importRemotePublicKey(invitation.hostPublicKey),
          responseFrame,
        ),
      );
      if (!this.ownsAttempt(epoch)) return;
      if (response.requestId !== requestId) {
        throw new Error("The pairing response did not match this request.");
      }
      if (response.type !== "pair.accepted") {
        throw new Error("The desktop did not approve this browser.");
      }
      if (response.deviceId !== deviceId) {
        throw new Error("The pairing response did not match this browser.");
      }
      const profile: SealedBrowserDeviceProfile = {
        version: 2,
        deviceId,
        deviceLabel: label,
        publicKey: deviceKeys.publicKey,
        privateKey: deviceKeys.keyPair.privateKey,
        lastUsedAt: new Date().toISOString(),
        hostId: invitation.hostId,
        hostPublicKey: invitation.hostPublicKey,
        relayUrl,
        endpointId: invitation.endpointId,
        scopes: response.scopes,
        projectIds: response.projectIds,
        grantVersion: response.grantVersion,
        expiresAt: response.expiresAt,
      };
      if (!await this.saveOwnedProfile(epoch, profile)) return;
      this.profile = profile;
      this.lastProfileActivityWriteAt = Date.parse(profile.lastUsedAt);
      tunnel.socket.close(1000, "pairing complete");
      this.socket = null;
      this.connectionId = null;
      await this.connect();
    } catch (error) {
      if (this.ownsAttempt(epoch)) throw error;
    }
  }

  async connect(): Promise<void> {
    await this.supervisor.retryNow();
  }

  private async connectOnce(generation: number): Promise<void> {
    const profile = this.profile;
    if (!profile) return;
    const epoch = ++this.attemptEpoch;
    this.disconnectTransport("Connecting.");
    if (sealedProfileHasExpired(profile)) {
      throw new RemoteConnectionFailure(
        "This device grant expired. Pair it again.",
        "terminal",
        "grant-expired",
      );
    }
    try {
      const tunnel = await this.openOwnedTunnel(
        epoch,
        profile.relayUrl,
        profile.endpointId,
      );
      if (!tunnel) return;
      this.socket = tunnel.socket;
      this.connectionId = tunnel.connectionId;
      const sessionId = crypto.randomUUID();
      let deviceKeys: {
        privateKey: CryptoKey;
        publicKey: CryptoKey;
      };
      let hostPublicKey: CryptoKey;
      let sender: RemoteSenderState & { enc: string };
      try {
        deviceKeys = {
          privateKey: profile.privateKey,
          publicKey: await importDevicePublicKey(profile.publicKey),
        };
        hostPublicKey = await importRemotePublicKey(profile.hostPublicKey);
        sender = await createAuthenticatedSessionSender(
          profile.hostId,
          profile.deviceId,
          sessionId,
          deviceKeys,
          hostPublicKey,
        );
      } catch {
        throw terminalProtocolFailure(
          "This browser's sealed device identity is invalid. Pair it again.",
          "device-identity-invalid",
        );
      }
      if (!this.ownsAttempt(epoch)) return;
      const ciphertext = await sealSessionHandshake(
        sender,
        "session.open",
        sessionId,
        {
          type: "session.open",
          sessionId,
          deviceId: profile.deviceId,
          grantVersion: profile.grantVersion,
          createdAt: new Date().toISOString(),
          browserVersion: REMOTE_BROWSER_VERSION,
        },
      );
      sendFrame(tunnel.socket, tunnel.connectionId, {
        protocolVersion: REMOTE_PROTOCOL_VERSION,
        kind: "session.open",
        sessionId,
        enc: sender.enc,
        ciphertext,
      });
      const acceptFrame = await waitForRelayFrame(
        tunnel.socket,
        (candidate) =>
          (candidate.kind === "session.accept"
            || candidate.kind === "session.close")
          && candidate.sessionId === sessionId,
        REMOTE_LIMITS.sessionHandshakeTtlMs,
      );
      if (!this.ownsAttempt(epoch)) return;
      if (acceptFrame.kind === "session.close") {
        throw failureForSessionClose(acceptFrame.reason);
      }
      if (acceptFrame.kind !== "session.accept") {
        throw terminalProtocolFailure("The session response was invalid.");
      }
      let recipient: RemoteRecipientState;
      let accepted: ReturnType<typeof remoteSessionAcceptPayloadSchema.parse>;
      try {
        recipient = await createAuthenticatedSessionRecipient(
          profile.hostId,
          profile.deviceId,
          sessionId,
          deviceKeys,
          hostPublicKey,
          acceptFrame.enc,
        );
        accepted = remoteSessionAcceptPayloadSchema.parse(
          await openSessionHandshake(
            recipient,
            "session.accept",
            sessionId,
            acceptFrame.ciphertext,
          ),
        );
      } catch {
        throw terminalProtocolFailure(
          "The desktop sent an incompatible authenticated session.",
          "session-auth-invalid",
        );
      }
      if (!this.ownsAttempt(epoch)) return;
      if (
        accepted.sessionId !== sessionId
        || accepted.hostId !== profile.hostId
      ) {
        throw terminalProtocolFailure(
          "The authenticated session did not match this device.",
        );
      }
      const updatedProfile: SealedBrowserDeviceProfile = {
        ...profile,
        scopes: accepted.scopes,
        projectIds: accepted.projectIds,
        grantVersion: accepted.grantVersion,
        expiresAt: accepted.expiresAt,
        lastUsedAt: new Date().toISOString(),
      };
      if (!await this.saveOwnedProfile(epoch, updatedProfile)) return;
      this.profile = updatedProfile;
      this.supervisor.grantUpdated();
      this.lastProfileActivityWriteAt = Date.parse(
        updatedProfile.lastUsedAt,
      );
      this.socket = tunnel.socket;
      this.connectionId = tunnel.connectionId;
      this.sessionId = sessionId;
      this.sender = sender;
      this.recipient = recipient;
      this.connectionGeneration = generation;
      tunnel.socket.addEventListener("message", (event) => {
        if (!this.ownsAttempt(epoch)) return;
        this.inboundTail = this.inboundTail
          .then(async () => {
            if (this.ownsAttempt(epoch)) {
              await this.handleMessage(
                generation,
                tunnel.socket,
                event.data,
              );
            }
          })
          .catch(() => {
            if (this.ownsAttempt(epoch)) {
              this.supervisor.transportClosed(
                generation,
                terminalProtocolFailure("The encrypted session failed."),
              );
            }
          });
      });
      tunnel.socket.addEventListener("close", () => {
        if (this.socket === tunnel.socket) {
          this.supervisor.transportClosed(
            generation,
            transientConnectionFailure("The desktop is offline."),
          );
        }
      });
      await this.refresh(epoch, this.replacePollingLoop());
    } catch (error) {
      if (!this.ownsAttempt(epoch)) return;
      throw classifyConnectionFailure(error);
    }
  }

  selectConversation(conversationId: string): void {
    this.selectedConversationId = conversationId;
    this.callbacks.detail(null);
    this.refreshOrDisconnect(
      this.attemptEpoch,
      this.replacePollingLoop(),
    );
  }

  async sendPrompt(
    conversationId: string,
    content: string,
  ): Promise<boolean> {
    const text = content.trim();
    if (!text) {
      this.callbacks.promptResult("Enter a prompt before sending.", false);
      return false;
    }
    if (conversationId !== this.selectedConversationId) {
      this.callbacks.promptResult(
        "The selected conversation changed. The prompt was not sent.",
        false,
      );
      return false;
    }
    const request: Extract<RemoteRequest, { type: "prompt.send" }> = {
      type: "prompt.send",
      requestId: crypto.randomUUID(),
      deliveryId: crypto.randomUUID(),
      conversationId,
      content: text.slice(0, REMOTE_LIMITS.promptCharacters),
    };
    try {
      const response = await this.request(request);
      if (response.ok && response.result.kind === "prompt.accepted") {
        this.callbacks.promptResult("Prompt accepted by the desktop.", false);
        return true;
      }
      if (!response.ok) {
        this.callbacks.promptResult(
          response.message,
          response.code === "uncertain",
        );
      }
      return false;
    } catch {
      this.callbacks.promptResult(
        "Delivery is uncertain. The prompt was not retried.",
        true,
      );
      return false;
    }
  }

  private async refresh(epoch: number, generation: number): Promise<void> {
    if (!this.sender || !this.ownsPollingLoop(epoch, generation)) return;
    try {
      const state = await this.request({
        type: "state.get",
        requestId: crypto.randomUUID(),
      });
      if (
        this.ownsPollingLoop(epoch, generation)
        && state.ok
        && state.result.kind === "state"
      ) {
        this.callbacks.shell(state.result.state);
        void this.persistAuthenticatedActivity(epoch);
      }
      if (
        this.selectedConversationId
        && this.ownsPollingLoop(epoch, generation)
      ) {
        const conversationId = this.selectedConversationId;
        const detail = await this.request({
          type: "conversation.get",
          requestId: crypto.randomUUID(),
          conversationId,
        });
        if (!(
          this.ownsPollingLoop(epoch, generation)
          && this.selectedConversationId === conversationId
        )) return;
        if (detail.ok && detail.result.kind === "conversation") {
          this.callbacks.detail(detail.result.detail);
        } else {
          this.callbacks.detail(null);
        }
      }
    } finally {
      if (this.sender && this.ownsPollingLoop(epoch, generation)) {
        this.pollTimer = setTimeout(() => {
          this.pollTimer = null;
          this.refreshOrDisconnect(epoch, generation);
        }, 2_000);
      }
    }
  }

  private refreshOrDisconnect(epoch: number, generation: number): void {
    void this.refresh(epoch, generation).catch(() => {
      if (this.ownsPollingLoop(epoch, generation)) {
        this.disconnect("The desktop is offline.");
      }
    });
  }

  private replacePollingLoop(): number {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.pollGeneration += 1;
    return this.pollGeneration;
  }

  private ownsPollingLoop(epoch: number, generation: number): boolean {
    return this.ownsAttempt(epoch) && generation === this.pollGeneration;
  }

  private ownsQueuedSend(
    epoch: number,
    sender: RemoteSenderState,
    sessionId: string,
  ): boolean {
    return this.ownsAttempt(epoch)
      && this.sender === sender
      && this.sessionId === sessionId
      && this.connectionId !== null
      && this.socket !== null;
  }

  private request(request: RemoteRequest): Promise<RemoteResponse> {
    const epoch = this.attemptEpoch;
    const sender = this.sender;
    const sessionId = this.sessionId;
    if (!sender || !sessionId) {
      return Promise.reject(new Error("The desktop is offline."));
    }
    const promise = new Promise<RemoteResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.requestId);
        reject(new Error("The desktop did not acknowledge the request."));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(request.requestId, { request, timer, resolve, reject });
    });
    this.outboundTail = this.outboundTail.then(async () => {
      if (!this.ownsQueuedSend(epoch, sender, sessionId)) {
        throw new Error("The desktop is offline.");
      }
      const frame = await sealSessionData(sender, sessionId, request);
      if (!this.ownsQueuedSend(epoch, sender, sessionId)) {
        throw new Error("The desktop is offline.");
      }
      sendFrame(this.socket!, this.connectionId!, frame);
    }).catch(() => {
      const pending = this.pending.get(request.requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(request.requestId);
        pending.reject(new Error("The desktop is offline."));
      }
    });
    return promise;
  }

  private async handleMessage(
    generation: number,
    socket: WebSocket,
    raw: unknown,
  ): Promise<void> {
    const bounded = boundedRemoteRelayText(raw);
    if (!bounded.ok) {
      socket.close(bounded.closeCode, bounded.closeReason);
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(bounded.value) as unknown;
    } catch {
      return;
    }
    const message = relayServerMessageSchema.safeParse(value);
    if (!message.success) {
      if (hasUnsupportedProtocolVersion(value)) {
        this.supervisor.transportClosed(
          generation,
          terminalProtocolFailure(
            "The relay uses an incompatible Remote Companion protocol.",
          ),
        );
      }
      return;
    }
    if (
      message.data.type === "relay.peer-disconnected"
      || (
        message.data.type === "relay.error"
        && message.data.code === "desktop-offline"
      )
    ) {
      this.supervisor.transportClosed(
        generation,
        transientConnectionFailure("The desktop is offline."),
      );
      return;
    }
    if (
      message.data.type !== "relay.frame"
      || message.data.connectionId !== this.connectionId
    ) return;
    const frame = message.data.frame;
    if (frame.kind === "session.close") {
      this.supervisor.transportClosed(
        generation,
        failureForSessionClose(frame.reason),
      );
      return;
    }
    if (
      frame.kind !== "session.data"
      || frame.sessionId !== this.sessionId
      || !this.recipient
    ) return;
    const response = remoteResponseSchema.parse(
      await openSessionData(this.recipient, frame),
    );
    const pending = this.pending.get(response.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(response.requestId);
    pending.resolve(response);
  }

  private disconnect(message: string): void {
    if (this.supervisor.current().phase === "idle") {
      this.attemptEpoch += 1;
      this.disconnectTransport(message);
      this.callbacks.status(message, false);
      return;
    }
    this.supervisor.transportClosed(
      this.connectionGeneration,
      transientConnectionFailure(message),
    );
  }

  private beginAttempt(message: string): number {
    this.supervisor.stop(message);
    this.callbacks.status(message, false);
    return this.attemptEpoch;
  }

  private ownsAttempt(epoch: number): boolean {
    return epoch === this.attemptEpoch;
  }

  private async openOwnedTunnel(
    epoch: number,
    relayUrl: string,
    endpointId: string,
  ): Promise<{ socket: WebSocket; connectionId: string } | null> {
    let opening: WebSocket | null = null;
    try {
      const tunnel = await openTunnel(
        relayUrl,
        endpointId,
        (socket) => {
          opening = socket;
          this.openingSockets.add(socket);
        },
      );
      if (!this.ownsAttempt(epoch)) {
        tunnel.socket.close(1000, "stale connection");
        return null;
      }
      return tunnel;
    } finally {
      if (opening) this.openingSockets.delete(opening);
    }
  }

  private async saveOwnedProfile(
    epoch: number,
    profile: SealedBrowserDeviceProfile,
  ): Promise<boolean> {
    let saved = false;
    const previousProfile = this.profile;
    const write = this.profileWriteTail
      .catch(() => undefined)
      .then(async () => {
        if (!this.ownsAttempt(epoch)) return;
        await saveSealedDeviceProfile(profile);
        if (this.ownsAttempt(epoch)) {
          saved = true;
          return;
        }
        if (previousProfile) await saveSealedDeviceProfile(previousProfile);
        else await clearDeviceProfile();
      });
    this.profileWriteTail = write;
    await write;
    return saved;
  }

  private async persistAuthenticatedActivity(epoch: number): Promise<void> {
    const profile = this.profile;
    if (!profile || !this.ownsAttempt(epoch)) return;
    const now = Date.now();
    const persistedAt = Date.parse(profile.lastUsedAt);
    const previousActivityAt = Math.max(
      Number.isFinite(persistedAt) ? persistedAt : 0,
      this.lastProfileActivityWriteAt,
    );
    if (now - previousActivityAt < PROFILE_ACTIVITY_WRITE_INTERVAL_MS) return;
    this.lastProfileActivityWriteAt = now;
    const next = {
      ...profile,
      lastUsedAt: new Date(now).toISOString(),
    };
    try {
      if (await this.saveOwnedProfile(epoch, next)) {
        this.profile = next;
        return;
      }
    } catch {
      // A later authenticated poll can retry without disconnecting the session.
    }
    if (this.lastProfileActivityWriteAt === now) {
      this.lastProfileActivityWriteAt = Number.isFinite(persistedAt)
        ? persistedAt
        : 0;
    }
  }

  private publishConnectionState(state: RemoteConnectionSnapshot): void {
    this.callbacks.connection?.(state);
    switch (state.phase) {
      case "connecting":
        this.callbacks.status("Connecting to the desktop…", false);
        break;
      case "online":
        this.callbacks.status(
          "Connected. The desktop remains authoritative.",
          true,
        );
        break;
      case "offline":
        this.callbacks.status(
          state.failure?.message
            ?? "This browser is offline. Cached data may be stale.",
          false,
        );
        break;
      case "backoff":
        this.callbacks.status(
          `${state.failure?.message ?? "The desktop is offline."} Retrying automatically…`,
          false,
        );
        break;
      case "terminal":
        this.callbacks.status(
          state.failure?.message ?? "Remote Companion needs attention.",
          false,
        );
        if (
          state.failure?.code === "grant-revoked"
          || state.failure?.code === "grant-expired"
        ) {
          void this.clearExpiredProfile();
        }
        break;
      case "idle":
        break;
    }
  }

  private async clearExpiredProfile(): Promise<void> {
    this.profile = null;
    this.callbacks.invalidated?.();
    await this.profileWriteTail.catch(() => undefined);
    await clearDeviceProfile().catch(() => undefined);
  }

  private disconnectTransport(message: string): void {
    this.replacePollingLoop();
    const socket = this.socket;
    this.socket = null;
    this.connectionId = null;
    this.sessionId = null;
    this.sender = null;
    this.recipient = null;
    this.inboundTail = Promise.resolve();
    this.outboundTail = Promise.resolve();
    for (const opening of this.openingSockets) {
      opening.close(1000, "superseded connection");
    }
    this.openingSockets.clear();
    socket?.close(1000, "browser disconnect");
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pending.clear();
  }
}

async function openTunnel(
  relayUrl: string,
  endpointId: string,
  onCreate?: (socket: WebSocket) => void,
): Promise<{ socket: WebSocket; connectionId: string }> {
  const socket = new WebSocket(relayUrl);
  onCreate?.(socket);
  try {
    await waitForRemoteWebSocketOpen(socket);
    socket.send(JSON.stringify({
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      type: "relay.connect",
      endpointId,
      browserVersion: REMOTE_BROWSER_VERSION,
    }));
    const response = await waitForRemoteRelayMessage(
      socket,
      (message) =>
        message.type === "relay.connected" || message.type === "relay.error",
      REQUEST_TIMEOUT_MS,
    );
    if (response.type !== "relay.connected") {
      if (response.type !== "relay.error") {
        throw terminalProtocolFailure("The relay response was invalid.");
      }
      if (
        response.code === "desktop-offline"
        || response.code === "connection-missing"
        || response.code === "capacity"
        || response.code === "rate-limited"
      ) {
        throw transientConnectionFailure(
          response.code === "desktop-offline"
            ? "The desktop is offline."
            : "The relay is temporarily unavailable.",
          response.code,
        );
      }
      throw terminalProtocolFailure(
        "The relay refused this Remote Companion protocol.",
        response.code,
      );
    }
    return { socket, connectionId: response.connectionId };
  } catch (error) {
    socket.close(1000, "connection failed");
    throw error;
  }
}

export function waitForRemoteWebSocketOpen(
  socket: WebSocket,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
    };
    const onOpen = (): void => {
      cleanup();
      resolve();
    };
    const onError = (): void => {
      cleanup();
      reject(new Error("Relay connection failed."));
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error("Relay connection closed."));
    };
    const timer = setTimeout(() => {
      cleanup();
      socket.close(1000, "connection timeout");
      reject(new Error("Relay connection timed out."));
    }, REQUEST_TIMEOUT_MS);
    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
  });
}

export function waitForRemoteRelayMessage(
  socket: WebSocket,
  accept: (message: ReturnType<typeof relayServerMessageSchema.parse>) => boolean,
  timeoutMs: number,
): Promise<ReturnType<typeof relayServerMessageSchema.parse>> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
    };
    const timer = setTimeout(() => {
      cleanup();
      socket.close(1000, "relay response timeout");
      reject(new Error("The relay response timed out."));
    }, Math.max(1, Math.min(timeoutMs, REMOTE_LIMITS.pairingTtlMs)));
    const onMessage = (event: MessageEvent) => {
      const bounded = boundedRemoteRelayText(event.data);
      if (!bounded.ok) {
        cleanup();
        socket.close(bounded.closeCode, bounded.closeReason);
        reject(new Error(bounded.message));
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(bounded.value) as unknown;
      } catch {
        return;
      }
      const parsed = relayServerMessageSchema.safeParse(value);
      if (!parsed.success) {
        if (hasUnsupportedProtocolVersion(value)) {
          cleanup();
          reject(terminalProtocolFailure(
            "The relay uses an incompatible Remote Companion protocol.",
            "protocol-mismatch",
          ));
        }
        return;
      }
      if (!accept(parsed.data)) return;
      cleanup();
      resolve(parsed.data);
    };
    const onError = (): void => {
      cleanup();
      reject(new Error("The relay connection failed."));
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error("The relay connection closed."));
    };
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
  });
}

function boundedRemoteRelayText(value: unknown): BoundedRemoteRelayText {
  if (typeof value !== "string") {
    return {
      ok: false,
      closeCode: 1003,
      closeReason: "relay messages must be text",
      message: "The relay sent an unsupported message.",
    };
  }
  if (
    value.length > REMOTE_LIMITS.relayEnvelopeBytes
    || REMOTE_TEXT_ENCODER.encode(value).byteLength
      > REMOTE_LIMITS.relayEnvelopeBytes
  ) {
    return {
      ok: false,
      closeCode: 1009,
      closeReason: "relay message too large",
      message: "The relay response exceeded the protocol limit.",
    };
  }
  return { ok: true, value };
}

async function waitForRelayFrame(
  socket: WebSocket,
  accept: (
    frame: Extract<
      ReturnType<typeof relayServerMessageSchema.parse>,
      { type: "relay.frame" }
    >["frame"],
  ) => boolean,
  timeoutMs: number,
): Promise<Extract<
  ReturnType<typeof relayServerMessageSchema.parse>,
  { type: "relay.frame" }
>["frame"]> {
  const message = await waitForRemoteRelayMessage(
    socket,
    (candidate) =>
      candidate.type === "relay.frame" && accept(candidate.frame),
    timeoutMs,
  );
  if (message.type !== "relay.frame") throw new Error("Missing relay frame.");
  return message.frame;
}

function sendFrame(
  socket: WebSocket,
  connectionId: string,
  frame: unknown,
): void {
  socket.send(JSON.stringify({
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    type: "relay.frame",
    connectionId,
    frame,
  }));
}

function transientConnectionFailure(
  message: string,
  code = "transport",
): RemoteConnectionFailure {
  return new RemoteConnectionFailure(message, "transient", code);
}

function terminalProtocolFailure(
  message: string,
  code = "protocol-error",
): RemoteConnectionFailure {
  return new RemoteConnectionFailure(message, "terminal", code);
}

function classifyConnectionFailure(error: unknown): RemoteConnectionFailure {
  if (error instanceof RemoteConnectionFailure) return error;
  const message = error instanceof Error && error.message.trim()
    ? error.message.trim().slice(0, 240)
    : "The desktop is offline.";
  if (
    error instanceof Error
    && (
      error.name === "ZodError"
      || /invalid|incompatible|did not match|unsupported|decrypt/iu.test(message)
    )
  ) {
    return terminalProtocolFailure(
      "The desktop uses an incompatible Remote Companion protocol.",
    );
  }
  return transientConnectionFailure(message);
}

function failureForSessionClose(
  reason: Extract<RemoteCipherFrame, { kind: "session.close" }>["reason"],
): RemoteConnectionFailure {
  switch (reason) {
    case "expired":
      return new RemoteConnectionFailure(
        "This device grant expired. Pair it again.",
        "terminal",
        "grant-expired",
      );
    case "revoked":
      return new RemoteConnectionFailure(
        "This browser was revoked on the desktop. Pair it again to continue.",
        "terminal",
        "grant-revoked",
      );
    case "protocol-error":
    case "replay":
      return terminalProtocolFailure(
        "The desktop rejected this Remote Companion protocol.",
        reason,
      );
    case "permissions-changed":
      return transientConnectionFailure(
        "Device permissions changed on the desktop.",
        reason,
      );
    case "rate-limited":
      return transientConnectionFailure(
        "Remote Companion is temporarily rate limited.",
        reason,
      );
    case "disabled":
      return transientConnectionFailure(
        "Remote Companion is disabled on the desktop.",
        reason,
      );
    case "shutdown":
      return transientConnectionFailure(
        "The desktop is unavailable.",
        reason,
      );
  }
}

function hasUnsupportedProtocolVersion(value: unknown): boolean {
  return typeof value === "object"
    && value !== null
    && "protocolVersion" in value
    && typeof value.protocolVersion === "number"
    && value.protocolVersion !== REMOTE_PROTOCOL_VERSION;
}

export function parseRemoteInvitation(value: string): RemotePairingInvitation {
  return remotePairingInvitationSchema.parse(JSON.parse(value) as unknown);
}
