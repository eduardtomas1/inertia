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
  RELAY_PROTOCOL_VERSION,
  REMOTE_BROWSER_COMPATIBILITY,
  REMOTE_BROWSER_SESSION_VERSION,
  REMOTE_BROWSER_VERSION,
  REMOTE_LIMITS,
  REMOTE_PROTOCOL_VERSION,
  relayServerMessageSchema,
  remotePairingInvitationSchema,
  remotePairingResponsePayloadSchema,
  remoteResponseSchema,
  remoteSessionAuthorityChangedPayloadSchema,
  remoteSessionResponsePayloadSchema,
  type RemotePairingInvitation,
  type RemoteCipherFrame,
  type RemoteProjectionValidator,
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
  profileAuthorizationChanged,
  REMOTE_INACTIVITY_EXPIRY_MS,
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
  authorizationInvalidated?(): void;
  forgetting?(value: boolean): void;
  profileClearing?(value: boolean): void;
  pairingCode(code: string): void;
  shell(shell: RemoteSafeShell): void;
  detail(detail: RemoteSafeConversationDetail | null): void;
  promptResult(
    message: string,
    uncertain: boolean,
    conversationId?: string,
  ): void;
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
  private endpointEpoch: number | null = null;
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
  private profileClear: Promise<void> | null = null;
  private forgetOperation: Promise<void> | null = null;
  private lastProfileActivityWriteAt = 0;
  private connectionGeneration = 0;
  private conditionalProjections = false;
  private shellValidator: RemoteProjectionValidator | null = null;
  private hasShellProjection = false;
  private detailValidator: RemoteProjectionValidator | null = null;
  private detailProjectionId: string | null = null;
  private stateReadOrdinal = 0;
  private detailReadOrdinal = 0;
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
      expiresAt: () => this.effectiveProfileExpiry(),
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
    await this.clearExpiredProfile();
    if (!this.ownsAttempt(epoch)) return;
    if (!this.profile) {
      this.callbacks.status("This device grant expired. Pair it again.", false);
    }
  }

  currentProfile(): SealedBrowserDeviceProfile | null {
    return this.profile;
  }

  forget(): Promise<void> {
    if (this.forgetOperation) return this.forgetOperation;
    this.callbacks.forgetting?.(true);
    this.supervisor.stop("This browser was forgotten.");
    this.callbacks.status("Disconnecting and forgetting this browser…", false);
    const operation = this.performForget().finally(() => {
      if (this.forgetOperation === operation) this.forgetOperation = null;
      this.callbacks.forgetting?.(false);
    });
    this.forgetOperation = operation;
    return operation;
  }
  private async performForget(): Promise<void> {
    await this.profileWriteTail.catch(() => undefined);
    // Revoke every attempt/lease again at the durable identity boundary. A
    // profile write that started before Forget cannot restore a live session.
    this.supervisor.stop("This browser was forgotten.");
    try {
      await clearDeviceProfile();
    } catch (error) {
      this.callbacks.status(
        "Remote Companion is disconnected, but this browser could not be forgotten. Try again.",
        false,
      );
      throw error;
    }
    this.profile = null;
    this.clearProjectionValidators();
    this.callbacks.invalidated?.();
    this.callbacks.status("This browser was forgotten.", false);
  }

  async pair(invitationText: string, deviceLabel: string): Promise<void> {
    if (this.forgetOperation) {
      throw new Error("Wait for this browser to finish being forgotten.");
    }
    if (this.profileClear) await this.profileClear;
    const epoch = this.beginAttempt("Starting pairing.");
    let pairingSocket: WebSocket | null = null;
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
        invitation.relayIdentity,
        invitation.desktop.version,
      );
      if (!tunnel) return;
      pairingSocket = tunnel.socket;
      this.socket = tunnel.socket;
      this.connectionId = tunnel.connectionId;
      this.endpointEpoch = tunnel.endpointEpoch;
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
        tunnel.endpointEpoch,
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
        relayIdentity: invitation.relayIdentity,
        desktop: invitation.desktop,
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
      this.endpointEpoch = null;
      await this.connect();
    } catch (error) {
      if (this.ownsAttempt(epoch)) throw error;
    } finally {
      if (
        pairingSocket
        && this.ownsAttempt(epoch)
        && this.socket === pairingSocket
      ) {
        pairingSocket.close(1000, "pairing attempt ended");
        this.socket = null;
        this.connectionId = null;
      }
    }
  }

  async connect(): Promise<void> {
    if (this.forgetOperation) return;
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
    if (!profile.relayIdentity || !profile.desktop) {
      throw terminalProtocolFailure(
        "This pairing predates endpoint-authenticated relay v2. Pair it again.",
        "pairing-migration-required",
      );
    }
    try {
      const tunnel = await this.openOwnedTunnel(
        epoch,
        profile.relayUrl,
        profile.endpointId,
        profile.relayIdentity,
        profile.desktop.version,
      );
      if (!tunnel) return;
      this.socket = tunnel.socket;
      this.connectionId = tunnel.connectionId;
      this.endpointEpoch = tunnel.endpointEpoch;
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
          browserVersion: REMOTE_BROWSER_SESSION_VERSION,
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
        tunnel.endpointEpoch,
      );
      if (!this.ownsAttempt(epoch)) return;
      if (acceptFrame.kind === "session.close") {
        throw transientFailureForSessionCloseHint(acceptFrame.reason);
      }
      if (acceptFrame.kind !== "session.accept") {
        throw terminalProtocolFailure("The session response was invalid.");
      }
      let recipient: RemoteRecipientState;
      let response: ReturnType<typeof remoteSessionResponsePayloadSchema.parse>;
      try {
        recipient = await createAuthenticatedSessionRecipient(
          profile.hostId,
          profile.deviceId,
          sessionId,
          deviceKeys,
          hostPublicKey,
          acceptFrame.enc,
        );
        response = remoteSessionResponsePayloadSchema.parse(
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
        response.sessionId !== sessionId
        || response.hostId !== profile.hostId
      ) {
        throw terminalProtocolFailure(
          "The authenticated session did not match this device.",
        );
      }
      if (response.type === "session.reject") {
        throw new RemoteConnectionFailure(
          response.reason === "revoked"
            ? "This browser was revoked on the desktop. Pair it again to continue."
            : "This device grant expired. Pair it again.",
          "terminal",
          response.reason === "revoked" ? "grant-revoked" : "grant-expired",
        );
      }
      const accepted = response;
      if (profileAuthorizationChanged(profile, accepted)) {
        this.clearProjectionValidators();
        this.callbacks.authorizationInvalidated?.();
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
      this.endpointEpoch = tunnel.endpointEpoch;
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
    this.detailValidator = null;
    this.detailProjectionId = null;
    this.detailReadOrdinal += 1;
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
      this.callbacks.promptResult(
        "Enter a prompt before sending.",
        false,
        conversationId,
      );
      return false;
    }
    if (conversationId !== this.selectedConversationId) {
      this.callbacks.promptResult(
        "The selected conversation changed. The prompt was not sent.",
        false,
        conversationId,
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
        this.callbacks.promptResult(
          "Prompt accepted by the desktop.",
          false,
          conversationId,
        );
        return true;
      }
      if (!response.ok) {
        this.callbacks.promptResult(
          response.message,
          response.code === "uncertain",
          conversationId,
        );
      }
      return false;
    } catch {
      this.callbacks.promptResult(
        "Delivery is uncertain. The prompt was not retried.",
        true,
        conversationId,
      );
      return false;
    }
  }
  private async refresh(epoch: number, generation: number): Promise<void> {
    if (!this.sender || !this.ownsPollingLoop(epoch, generation)) return;
    try {
      const stateReadOrdinal = ++this.stateReadOrdinal;
      const conditionalStateRead = this.conditionalProjections;
      const state = await this.request({
        type: "state.get",
        requestId: crypto.randomUUID(),
        ...(conditionalStateRead
          ? { ifNoneMatch: this.hasShellProjection ? this.shellValidator : null }
          : {}),
      });
      if (
        this.ownsPollingLoop(epoch, generation)
        && stateReadOrdinal === this.stateReadOrdinal
        && state.ok
      ) {
        if (state.result.kind === "state") {
          this.hasShellProjection = true;
          this.shellValidator = state.result.validator ?? null;
          this.conditionalProjections = state.result.validator !== undefined;
          this.callbacks.shell(state.result.state);
          void this.persistAuthenticatedActivity(epoch);
        } else if (
          state.result.kind === "not-modified"
          && state.result.resource.kind === "state"
          && this.hasShellProjection
          && this.shellValidator === state.result.validator
        ) {
          void this.persistAuthenticatedActivity(epoch);
        } else if (state.result.kind === "not-modified") {
          this.shellValidator = null;
          this.hasShellProjection = false;
        }
      } else if (
        this.ownsPollingLoop(epoch, generation)
        && stateReadOrdinal === this.stateReadOrdinal
        && !state.ok
        && state.code === "invalid"
        && conditionalStateRead
      ) {
        // A previously capable desktop may have been replaced by a compatible
        // legacy version. Retry legacy-shaped reads without discarding the
        // last explicitly stale projection.
        this.conditionalProjections = false;
      }
      if (
        this.selectedConversationId
        && this.ownsPollingLoop(epoch, generation)
      ) {
        const conversationId = this.selectedConversationId;
        const detailReadOrdinal = ++this.detailReadOrdinal;
        const detail = await this.request({
          type: "conversation.get",
          requestId: crypto.randomUUID(),
          conversationId,
          ...(this.conditionalProjections
            ? {
                ifNoneMatch: this.detailProjectionId === conversationId
                  ? this.detailValidator
                  : null,
              }
            : {}),
        });
        if (!(
          this.ownsPollingLoop(epoch, generation)
          && this.selectedConversationId === conversationId
          && detailReadOrdinal === this.detailReadOrdinal
        )) return;
        if (
          detail.ok
          && detail.result.kind === "conversation"
          && detail.result.detail.conversation.id === conversationId
        ) {
          this.detailProjectionId = conversationId;
          this.detailValidator = detail.result.validator ?? null;
          this.conditionalProjections = detail.result.validator !== undefined;
          this.callbacks.detail(detail.result.detail);
        } else if (
          detail.ok
          && detail.result.kind === "not-modified"
          && detail.result.resource.kind === "conversation"
          && detail.result.resource.conversationId === conversationId
          && this.detailProjectionId === conversationId
          && this.detailValidator === detail.result.validator
        ) {
          // The existing authorized detail remains current.
        } else {
          this.detailProjectionId = null;
          this.detailValidator = null;
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
      this.supervisor.transportClosed(
        generation,
        terminalProtocolFailure(bounded.message, "relay-envelope-invalid"),
      );
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
    if (message.data.type === "relay.peer-disconnected") {
      this.supervisor.transportClosed(
        generation,
        transientConnectionFailure("The desktop is offline."),
      );
      return;
    }
    if (message.data.type === "relay.error") {
      this.supervisor.transportClosed(
        generation,
        failureForRelayError(message.data.code),
      );
      return;
    }
    if (
      message.data.type !== "relay.frame"
      || message.data.connectionId !== this.connectionId
      || (this.endpointEpoch !== null
        && message.data.endpointEpoch !== this.endpointEpoch)
    ) return;
    const frame = message.data.frame;
    if (frame.kind === "session.close") {
      this.supervisor.transportClosed(
        generation,
        transientFailureForSessionCloseHint(frame.reason),
      );
      return;
    }
    if (
      frame.kind !== "session.data"
      || frame.sessionId !== this.sessionId
      || !this.recipient
    ) return;
    const sessionId = this.sessionId;
    const recipient = this.recipient;
    const plaintext = await openSessionData(recipient, frame);
    if (!this.ownsInboundSession(
      generation,
      socket,
      sessionId,
      recipient,
    )) return;
    const authorityChange = remoteSessionAuthorityChangedPayloadSchema
      .safeParse(plaintext);
    if (authorityChange.success) {
      this.clearProjectionValidators();
      this.callbacks.authorizationInvalidated?.();
      return;
    }
    const response = remoteResponseSchema.parse(plaintext);
    const pending = this.pending.get(response.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(response.requestId);
    pending.resolve(response);
  }
  private ownsInboundSession(
    generation: number,
    socket: WebSocket,
    sessionId: string,
    recipient: RemoteRecipientState,
  ): boolean {
    return generation === this.connectionGeneration
      && socket === this.socket
      && sessionId === this.sessionId
      && recipient === this.recipient;
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
    relayIdentity: string,
    desktopVersion: string,
  ): Promise<{
    socket: WebSocket;
    connectionId: string;
    endpointEpoch: number;
  } | null> {
    let opening: WebSocket | null = null;
    try {
      const tunnel = await openTunnel(
        relayUrl,
        endpointId,
        relayIdentity,
        desktopVersion,
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
        this.supervisor.grantUpdated();
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
  private clearExpiredProfile(): Promise<void> {
    if (this.profileClear) return this.profileClear;
    if (!this.profile) return Promise.resolve();
    const profile = this.profile;
    this.callbacks.profileClearing?.(true);
    this.profile = null;
    this.clearProjectionValidators();
    this.callbacks.invalidated?.();
    const clearing = this.profileWriteTail
      .catch(() => undefined)
      .then(async () => {
        try {
          await clearDeviceProfile();
        } catch {
          if (!this.profile) this.profile = profile;
          this.callbacks.status(
            "Remote Companion is disconnected, but its saved pairing could not be cleared. Use Forget this browser and try again.",
            false,
          );
        }
      });
    this.profileWriteTail = clearing;
    const ownedClearing = clearing.finally(() => {
      if (this.profileClear === ownedClearing) this.profileClear = null;
      this.callbacks.profileClearing?.(false);
    });
    this.profileClear = ownedClearing;
    return ownedClearing;
  }
  private effectiveProfileExpiry(): string | null {
    const profile = this.profile;
    if (!profile) return null;
    const grantExpiry = Date.parse(profile.expiresAt);
    const lastUsedAt = Date.parse(profile.lastUsedAt);
    if (!Number.isFinite(grantExpiry) || !Number.isFinite(lastUsedAt)) {
      return new Date(0).toISOString();
    }
    return new Date(Math.min(
      grantExpiry,
      lastUsedAt + REMOTE_INACTIVITY_EXPIRY_MS + 1,
    )).toISOString();
  }
  private disconnectTransport(message: string): void {
    this.replacePollingLoop();
    const socket = this.socket;
    this.socket = null;
    this.connectionId = null;
    this.endpointEpoch = null;
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

  private clearProjectionValidators(): void {
    this.conditionalProjections = false;
    this.shellValidator = null;
    this.hasShellProjection = false;
    this.detailValidator = null;
    this.detailProjectionId = null;
    this.stateReadOrdinal += 1;
    this.detailReadOrdinal += 1;
  }
}

async function openTunnel(
  relayUrl: string,
  endpointId: string,
  relayIdentity: string,
  desktopVersion: string,
  onCreate?: (socket: WebSocket) => void,
): Promise<{
  socket: WebSocket;
  connectionId: string;
  endpointEpoch: number;
}> {
  const socket = new WebSocket(relayUrl);
  onCreate?.(socket);
  try {
    await waitForRemoteWebSocketOpen(socket);
    const hello = await waitForRemoteRelayMessage(
      socket,
      (message) => message.type === "relay.hello",
      REQUEST_TIMEOUT_MS,
    );
    if (
      hello.type !== "relay.hello"
      || hello.relayIdentity !== relayIdentity
      || hello.endpointAuthentication !== "required"
      || !rangeSupports(hello.relayProtocol, RELAY_PROTOCOL_VERSION)
      || !rangeSupports(hello.remoteProtocol, REMOTE_PROTOCOL_VERSION)
    ) {
      throw terminalProtocolFailure(
        "The invitation and relay are incompatible.",
        "relay-incompatible",
      );
    }
    socket.send(JSON.stringify({
      relayProtocolVersion: RELAY_PROTOCOL_VERSION,
      type: "relay.connect",
      endpointId,
      browser: REMOTE_BROWSER_COMPATIBILITY,
    }));
    const response = await waitForRemoteRelayMessage(
      socket,
      (message) =>
        message.type === "relay.connected"
        || message.type === "relay.error"
        || message.type === "relay.incompatible",
      REQUEST_TIMEOUT_MS,
    );
    if (response.type === "relay.incompatible") {
      throw failureForIncompatibility(response);
    }
    if (response.type === "relay.error") {
      throw failureForRelayError(response.code);
    }
    if (response.type !== "relay.connected") {
      throw terminalProtocolFailure("The relay response was invalid.");
    }
    if (
      response.relayIdentity !== relayIdentity
      || response.versions.relay !== hello.relayVersion
      || response.versions.desktop !== desktopVersion
      || response.versions.browser !== REMOTE_BROWSER_VERSION
      || response.selected.relayProtocol !== RELAY_PROTOCOL_VERSION
      || response.selected.remoteProtocol !== REMOTE_PROTOCOL_VERSION
    ) {
      throw terminalProtocolFailure(
        "The relay selected an incompatible component set.",
        "relay-incompatible",
      );
    }
    return {
      socket,
      connectionId: response.connectionId,
      endpointEpoch: response.endpointEpoch,
    };
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
        reject(terminalProtocolFailure(
          bounded.message,
          "relay-envelope-invalid",
        ));
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
  endpointEpoch?: number,
): Promise<Extract<
  ReturnType<typeof relayServerMessageSchema.parse>,
  { type: "relay.frame" }
>["frame"]> {
  const message = await waitForRemoteRelayMessage(
    socket,
    (candidate) =>
      candidate.type === "relay.error"
      || candidate.type === "relay.peer-disconnected"
      || (candidate.type === "relay.frame"
        && (endpointEpoch === undefined
          || candidate.endpointEpoch === endpointEpoch)
        && accept(candidate.frame)),
    timeoutMs,
  );
  if (message.type === "relay.error") {
    throw failureForRelayError(message.code);
  }
  if (message.type === "relay.peer-disconnected") {
    throw transientConnectionFailure("The desktop is offline.");
  }
  if (message.type !== "relay.frame") throw new Error("Missing relay frame.");
  return message.frame;
}

function sendFrame(
  socket: WebSocket,
  connectionId: string,
  frame: unknown,
): void {
  socket.send(JSON.stringify({
    relayProtocolVersion: RELAY_PROTOCOL_VERSION,
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

function transientFailureForSessionCloseHint(
  reason: Extract<RemoteCipherFrame, { kind: "session.close" }>["reason"],
): RemoteConnectionFailure {
  switch (reason) {
    case "expired":
    case "revoked":
      return transientConnectionFailure(
        "The desktop requested a fresh authenticated session.",
        reason,
      );
    case "protocol-error":
    case "replay":
      return transientConnectionFailure(
        "The desktop closed the unauthenticated relay session.",
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

function failureForRelayError(
  code: Extract<
    ReturnType<typeof relayServerMessageSchema.parse>,
    { type: "relay.error" }
  >["code"],
): RemoteConnectionFailure {
  if (
    code === "desktop-offline"
    || code === "connection-missing"
    || code === "capacity"
    || code === "rate-limited"
  ) {
    return transientConnectionFailure(
      code === "desktop-offline"
        ? "The desktop is offline."
        : "The relay is temporarily unavailable.",
      code,
    );
  }
  return terminalProtocolFailure(
    "The relay refused this Remote Companion protocol.",
    code,
  );
}

function hasUnsupportedProtocolVersion(value: unknown): boolean {
  return typeof value === "object"
    && value !== null
    && "relayProtocolVersion" in value
    && typeof value.relayProtocolVersion === "number"
    && value.relayProtocolVersion !== RELAY_PROTOCOL_VERSION;
}

function rangeSupports(
  range: { minimum: number; maximum: number },
  version: number,
): boolean {
  return range.minimum <= version && range.maximum >= version;
}

function failureForIncompatibility(
  incompatibility: Extract<
    ReturnType<typeof relayServerMessageSchema.parse>,
    { type: "relay.incompatible" }
  >,
): RemoteConnectionFailure {
  const upgrade = incompatibility.guidance.find(
    ({ action }) => action === "upgrade",
  );
  return terminalProtocolFailure(
    upgrade
      ? `Remote Companion versions are incompatible. Upgrade the ${upgrade.component}.`
      : "Remote Companion versions are incompatible.",
    "relay-incompatible",
  );
}

export function parseRemoteInvitation(value: string): RemotePairingInvitation {
  return remotePairingInvitationSchema.parse(JSON.parse(value) as unknown);
}
