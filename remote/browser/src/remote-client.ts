import {
  createAuthenticatedSessionRecipient,
  createAuthenticatedSessionSender,
  generateRemoteKeyPair,
  importRemoteKeyPair,
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
  type RemoteRequest,
  type RemoteResponse,
  type RemoteSafeConversationDetail,
  type RemoteSafeShell,
} from "../../../src/shared/remote-protocol";
import {
  clearDeviceProfile,
  loadDeviceProfile,
  saveDeviceProfile,
  validateBrowserRelayUrl,
  type BrowserDeviceProfile,
} from "./device-store";

const REQUEST_TIMEOUT_MS = 10_000;
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
  private profile: BrowserDeviceProfile | null = null;
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

  constructor(private readonly callbacks: RemoteClientCallbacks) {}

  async initialize(): Promise<BrowserDeviceProfile | null> {
    const epoch = ++this.attemptEpoch;
    const profile = await loadDeviceProfile();
    if (!this.ownsAttempt(epoch)) return this.profile;
    this.profile = profile;
    if (this.profile && Date.parse(this.profile.expiresAt) > Date.now()) {
      void this.connect();
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

  currentProfile(): BrowserDeviceProfile | null {
    return this.profile;
  }

  async forget(): Promise<void> {
    this.attemptEpoch += 1;
    this.disconnectTransport("This browser was forgotten.");
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
      const keyPair = await generateRemoteKeyPair();
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
        keyPair.publicKey,
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
        devicePublicKey: keyPair.publicKey,
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
          await importRemoteKeyPair(keyPair),
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
      const profile: BrowserDeviceProfile = {
        version: 1,
        deviceId,
        deviceLabel: label,
        keyPair,
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
      tunnel.socket.close(1000, "pairing complete");
      this.socket = null;
      this.connectionId = null;
      await this.connect();
    } catch (error) {
      if (this.ownsAttempt(epoch)) throw error;
    }
  }

  async connect(): Promise<void> {
    const profile = this.profile;
    if (!profile) return;
    const epoch = this.beginAttempt("Connecting.");
    if (Date.parse(profile.expiresAt) <= Date.now()) {
      await this.forgetExpiredProfile(epoch);
      return;
    }
    this.callbacks.status("Connecting to the desktop…", false);
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
      const deviceKeys = await importRemoteKeyPair(profile.keyPair);
      const hostPublicKey = await importRemotePublicKey(profile.hostPublicKey);
      const sender = await createAuthenticatedSessionSender(
        profile.hostId,
        profile.deviceId,
        sessionId,
        deviceKeys,
        hostPublicKey,
      );
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
          candidate.kind === "session.accept"
          && candidate.sessionId === sessionId,
        REMOTE_LIMITS.sessionHandshakeTtlMs,
      );
      if (!this.ownsAttempt(epoch)) return;
      if (acceptFrame.kind !== "session.accept") {
        throw new Error("The session response was invalid.");
      }
      const recipient = await createAuthenticatedSessionRecipient(
        profile.hostId,
        profile.deviceId,
        sessionId,
        deviceKeys,
        hostPublicKey,
        acceptFrame.enc,
      );
      const accepted = remoteSessionAcceptPayloadSchema.parse(
        await openSessionHandshake(
          recipient,
          "session.accept",
          sessionId,
          acceptFrame.ciphertext,
        ),
      );
      if (!this.ownsAttempt(epoch)) return;
      if (
        accepted.sessionId !== sessionId
        || accepted.hostId !== profile.hostId
      ) throw new Error("The authenticated session did not match this device.");
      const updatedProfile: BrowserDeviceProfile = {
        ...profile,
        scopes: accepted.scopes,
        projectIds: accepted.projectIds,
        grantVersion: accepted.grantVersion,
        expiresAt: accepted.expiresAt,
      };
      if (!await this.saveOwnedProfile(epoch, updatedProfile)) return;
      this.profile = updatedProfile;
      this.socket = tunnel.socket;
      this.connectionId = tunnel.connectionId;
      this.sessionId = sessionId;
      this.sender = sender;
      this.recipient = recipient;
      tunnel.socket.addEventListener("message", (event) => {
        if (!this.ownsAttempt(epoch)) return;
        this.inboundTail = this.inboundTail
          .then(async () => {
            if (this.ownsAttempt(epoch)) {
              await this.handleMessage(tunnel.socket, event.data);
            }
          })
          .catch(() => {
            if (this.ownsAttempt(epoch)) {
              this.disconnect("The encrypted session failed.");
            }
          });
      });
      tunnel.socket.addEventListener("close", () => {
        if (this.socket === tunnel.socket) {
          this.disconnect("The desktop is offline.");
        }
      });
      this.callbacks.status("Connected. The desktop remains authoritative.", true);
      await this.refresh(epoch, this.replacePollingLoop());
    } catch (error) {
      if (this.ownsAttempt(epoch)) {
        this.disconnect(publicError(error, "The desktop is offline."));
      }
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
    if (!message.success) return;
    if (
      message.data.type === "relay.peer-disconnected"
      || (
        message.data.type === "relay.error"
        && message.data.code === "desktop-offline"
      )
    ) {
      this.disconnect("The desktop is offline.");
      return;
    }
    if (
      message.data.type !== "relay.frame"
      || message.data.connectionId !== this.connectionId
    ) return;
    const frame = message.data.frame;
    if (frame.kind === "session.close") {
      this.disconnect(`The desktop closed the session (${frame.reason}).`);
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
    this.attemptEpoch += 1;
    this.disconnectTransport(message);
  }

  private beginAttempt(message: string): number {
    this.attemptEpoch += 1;
    this.disconnectTransport(message);
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
    profile: BrowserDeviceProfile,
  ): Promise<boolean> {
    let saved = false;
    const previousProfile = this.profile;
    const write = this.profileWriteTail
      .catch(() => undefined)
      .then(async () => {
        if (!this.ownsAttempt(epoch)) return;
        await saveDeviceProfile(profile);
        if (this.ownsAttempt(epoch)) {
          saved = true;
          return;
        }
        if (previousProfile) await saveDeviceProfile(previousProfile);
        else await clearDeviceProfile();
      });
    this.profileWriteTail = write;
    await write;
    return saved;
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
    this.callbacks.detail(null);
    this.callbacks.status(message, false);
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
      throw new Error(
        response.type === "relay.error" && response.code === "desktop-offline"
          ? "The desktop is offline."
          : "The relay refused the connection.",
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
      if (!parsed.success || !accept(parsed.data)) return;
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

function publicError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim()
    ? error.message.trim().slice(0, 240)
    : fallback;
}

export function parseRemoteInvitation(value: string): RemotePairingInvitation {
  return remotePairingInvitationSchema.parse(JSON.parse(value) as unknown);
}
