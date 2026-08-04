import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  PRIVATE_CONNECT_LIMITS,
  privateConnectRequestSchema,
  type PrivateConnectInvitation,
  type PrivateConnectRequest,
  type PrivateConnectResponse,
  type PrivateConnectStateView,
  type PrivateConnectDeviceView,
  type PrivateConnectPendingPairingView,
} from "../../shared/private-connect/protocol";
import {
  createPrivateConnectInvitation,
  createPrivateConnectPairingLink,
} from "../../shared/private-connect/pairing-link";
import {
  normalizePrivateConnectGrants,
  privateConnectGrantedProjectIds,
  privateConnectGrantsFromProjectIds,
  type PrivateConnectConversationGrant,
} from "../../shared/private-connect/grants";
import {
  hasPrivateConnectScope,
  presetForScopes,
  scopesForPreset,
  type PrivateConnectPreset,
  type PrivateConnectScope,
} from "../../shared/private-connect/scopes";
import type { PrivateConnectRuntimeGrant } from "../../shared/private-connect/runtime-grants";
import type {
  PrivateConnectRuntimeAuthorization,
  PrivateConnectRuntimeRequest,
  PrivateConnectRuntimeResponse,
  PrivateConnectRuntimeConversation,
} from "../../shared/private-connect/runtime-contract";
import type { RuntimeSupervisor } from "../runtime-supervisor";
import {
  PrivateConnectGatewayServer,
  sessionCookie as createSessionCookie,
  type PrivateConnectGatewayHost,
  type PrivateConnectGatewayServerOptions,
  type PrivateConnectPairStartRequest,
  type PrivateConnectPairStatus,
  type PrivateConnectSession,
} from "./gateway-server";
import {
  PrivateConnectTailscaleController,
  PrivateConnectTailscaleError,
} from "./tailscale-controller";
import type { PrivateConnectStore, PersistedPrivateConnect, PrivateConnectDevice, PrivateConnectAuditEvent, PrivateConnectSessionRecord, PrivateConnectDeliveryReceipt } from "./store";

export interface PrivateConnectServiceOptions {
  store: PrivateConnectStore;
  runtime: Pick<RuntimeSupervisor, "privateConnectRequest"> & Partial<Pick<RuntimeSupervisor, "preparePrivateConnectPrompt" | "commitPrivateConnectPrompt">>;
  staticRoot: string;
  buildVersion: string;
  tailscale?: PrivateConnectTailscaleController;
  onStateChange?: (state: PrivateConnectStateView) => void;
  now?: () => Date;
}

interface PendingPairing {
  requestId: string;
  invitationId: string;
  deviceId: string;
  deviceLabel: string;
  receivedAt: string;
  expiresAt: string;
  comparisonCode: string;
  tailnetLabel: string | null;
  status: "pending" | "approved" | "denied" | "expired";
  cookie: string | null;
}

interface WebSocketTicket {
  value: string;
  sessionId: string;
  expiresAt: number;
}

type AuthorityReductionMarker = NonNullable<
  PersistedPrivateConnect["pendingAuthorityReduction"]
>;

const AUTHORITY_REDUCTION_DRAIN_TIMEOUT_MS = 30_000;

export class PrivateConnectService implements PrivateConnectGatewayHost {
  private data: PersistedPrivateConnect | null;
  private readonly now: () => Date;
  private readonly tailscale: PrivateConnectTailscaleController;
  private gateway: PrivateConnectGatewayServer;
  private readonly sessions = new Map<string, PrivateConnectSession>();
  private readonly tickets = new Map<string, WebSocketTicket>();
  private readonly pending = new Map<string, PendingPairing>();
  private readonly deliveries = new Map<string, PrivateConnectDeliveryReceipt>();
  private readonly activeMutations = new Set<Promise<unknown>>();
  private invitation: PrivateConnectInvitation | null = null;
  private status: PrivateConnectStateView["status"] = "off";
  private statusMessage: string | null = null;
  private notice: string | null = null;
  private externalUrl: string | null = null;
  private privacyLocked = false;
  private resumeAfterUnlock = false;
  private enableOperation = 0;
  private lifecycle: Promise<void> = Promise.resolve();
  private diagnostics: PrivateConnectStateView["diagnostics"] = {
    tailscale: "unknown",
    magicDns: "unknown",
    gatewayPort: null,
    servePort: null,
    externalUrl: null,
    mappingOwnership: "unknown",
    errorClass: null,
    setupUrl: null,
  };
  private stopped = false;

  private constructor(private readonly options: PrivateConnectServiceOptions, data: PersistedPrivateConnect | null) {
    this.data = data;
    this.now = options.now ?? (() => new Date());
    this.tailscale = options.tailscale ?? new PrivateConnectTailscaleController();
    this.gateway = this.createGateway();
    for (const session of data?.sessions ?? []) this.restoreSession(session);
    for (const receipt of data?.deliveryReceipts ?? []) this.deliveries.set(receipt.deliveryId, receipt);
  }

  static async create(options: PrivateConnectServiceOptions): Promise<PrivateConnectService> {
    const data = await options.store.load();
    const service = new PrivateConnectService(options, data);
    await service.recoverInterruptedAuthorityReduction();
    return service;
  }

  state(): PrivateConnectStateView {
    const data = this.data;
    return {
      available: this.options.store.available(),
      enabled: data?.enabled ?? false,
      status: data?.enabled || this.status !== "off" ? this.status : "off",
      statusMessage: this.statusMessage,
      externalUrl: this.externalUrl,
      activeSessions: this.gateway.activeSessionCount(),
      devices: (data?.devices ?? []).map((device) => this.deviceView(device)),
      pendingPairings: [...this.pending.values()]
        .filter(({ status }) => status === "pending")
        .map((pending) => this.pendingView(pending)),
      invitation: this.invitation && this.externalUrl
        ? { url: createPrivateConnectPairingLink(this.externalUrl, this.invitation), expiresAt: this.invitation.expiresAt }
        : null,
      notice: this.notice,
      diagnostics: {
        ...this.diagnostics,
        buildVersion: this.options.buildVersion,
        protocolVersion: 1,
      },
      audit: (data?.audit ?? []).slice(-50).map((event) => ({ ...event })),
    };
  }

  wellKnown(): Record<string, unknown> {
    return {
      hostId: this.data?.hostId ?? null,
      pairingAvailable: Boolean(this.data?.enabled && this.status === "ready" && !this.invitation),
      locked: this.status !== "ready",
    };
  }

  async setEnabled(enabled: boolean): Promise<PrivateConnectStateView> {
    return await this.enqueueLifecycle(async () => {
      if (enabled) await this.enable();
      else await this.disable();
      this.emit();
      return this.state();
    });
  }

  async startIfEnabled(): Promise<void> {
    await this.enqueueLifecycle(async () => {
      if (this.data?.enabled) await this.enable();
    });
  }

  setNotice(notice: string | null): void {
    this.notice = notice;
    this.emit();
  }

  validHost(host: string | undefined): boolean {
    if (!host || host.length > 255 || /[\s\\/]/u.test(host)) return false;
    const expected = new Set<string>();
    const gatewayPort = this.diagnostics.gatewayPort;
    if (gatewayPort) {
      expected.add(`127.0.0.1:${gatewayPort}`);
      expected.add(`localhost:${gatewayPort}`);
    }
    if (this.externalUrl) {
      try { expected.add(new URL(this.externalUrl).host); } catch { return false; }
    }
    return expected.has(host.toLowerCase());
  }

  async setPrivacyLocked(locked: boolean): Promise<void> {
    if (this.stopped) return;
    await this.enqueueLifecycle(async () => {
      if (this.privacyLocked === locked || this.stopped) return;
      this.privacyLocked = locked;
      if (locked) {
        this.enableOperation += 1;
        this.resumeAfterUnlock = this.data?.enabled === true && this.status === "ready";
        this.tickets.clear();
        this.gateway.closeAllSessions(1012, "Private Connect is paused while the desktop is locked");
        this.status = this.data?.enabled || this.status === "starting" ? "error" : "off";
        this.statusMessage = this.data?.enabled || this.status === "error" ? "Private Connect is paused while the desktop is locked." : null;
        await this.stopOwnedServeAndGateway();
        await this.persist();
        this.emit();
        return;
      }
      if (this.resumeAfterUnlock && this.data?.enabled) {
        this.resumeAfterUnlock = false;
        try { await this.enable(); }
        catch (error: unknown) { this.statusMessage = error instanceof Error ? error.message : "Private Connect could not resume safely."; }
        this.emit();
      }
    });
  }

  async createInvitation(): Promise<{ url: string; expiresAt: string }> {
    this.requireReady();
    if (!this.data?.hostId || !this.externalUrl) throw new Error("Private Connect is not ready.");
    this.prunePendingPairings();
    if (this.pending.size > 0) throw new Error("Finish or deny the current pairing before creating another link.");
    this.invitation = createPrivateConnectInvitation(this.data.hostId, this.now());
    this.audit("pairing.created", null, "A short-lived Private Connect pairing link was created.");
    this.emit();
    return {
      url: createPrivateConnectPairingLink(this.externalUrl, this.invitation),
      expiresAt: this.invitation.expiresAt,
    };
  }

  async pairStart(request: PrivateConnectPairStartRequest, networkLabel: string | null): Promise<{ requestId: string; expiresAt: string; comparisonCode: string }> {
    this.requireReady();
    this.prunePendingPairings();
    const invitation = this.invitation;
    if (!invitation || invitation.invitationId !== request.invitation.invitationId || invitation.pairingSecret !== request.invitation.pairingSecret) {
      throw new Error("That Private Connect invitation is invalid or has expired.");
    }
    if (Date.parse(invitation.expiresAt) <= this.now().getTime()) {
      this.invitation = null;
      throw new Error("That Private Connect invitation has expired.");
    }
    if (this.pending.size > 0) throw new Error("A pairing request is already waiting for approval.");
    const deviceLabel = sanitizeDeviceLabel(request.deviceLabel);
    if (!deviceLabel || !isUuid(request.deviceId)) throw new Error("The browser identity is invalid.");
    const requestId = randomUUID();
    const comparisonCode = comparisonCodeFor(this.data!.hostId, request.deviceId, invitation.invitationId);
    const pending: PendingPairing = {
      requestId,
      invitationId: invitation.invitationId,
      deviceId: request.deviceId,
      deviceLabel,
      receivedAt: this.now().toISOString(),
      expiresAt: invitation.expiresAt,
      comparisonCode,
      tailnetLabel: networkLabel,
      status: "pending",
      cookie: null,
    };
    this.pending.set(requestId, pending);
    this.invitation = null;
    this.audit("pairing.requested", request.deviceId, "A browser requested Private Connect pairing.");
    this.emit();
    return { requestId, expiresAt: pending.expiresAt, comparisonCode };
  }

  async pairStatus(requestId: string): Promise<PrivateConnectPairStatus> {
    const pending = this.pending.get(requestId);
    if (!pending) throw new Error("That pairing request is no longer available.");
    if (pending.status === "pending" && Date.parse(pending.expiresAt) <= this.now().getTime()) {
      pending.status = "expired";
    }
    if (pending.status === "approved" && pending.cookie) {
      const result: PrivateConnectPairStatus = {
        status: "approved",
        requestId,
        expiresAt: pending.expiresAt,
        cookie: pending.cookie,
      };
      this.pending.delete(requestId);
      return result;
    }
    if (pending.status === "expired" || pending.status === "denied") {
      const result = { status: pending.status, requestId } as const;
      this.pending.delete(requestId);
      return result;
    }
    return { status: "pending", requestId, expiresAt: pending.expiresAt, comparisonCode: pending.comparisonCode };
  }

  async approvePairing(
    requestId: string,
    preset: PrivateConnectPreset,
    projectIds: string[],
    grantDays = 30,
    grants?: PrivateConnectConversationGrant[],
  ): Promise<void> {
    const pending = this.pending.get(requestId);
    if (!pending || pending.status !== "pending") throw new Error("That pairing request is no longer pending.");
    if (Date.parse(pending.expiresAt) <= this.now().getTime()) {
      pending.status = "expired";
      throw new Error("That pairing request expired.");
    }
    if (!this.data) throw new Error("Private Connect storage is unavailable.");
    const normalizedProjects = [...new Set(projectIds.map((id) => id.trim()))].filter((id) => isUuid(id)).slice(0, PRIVATE_CONNECT_LIMITS.projectIds);
    if (normalizedProjects.length === 0) throw new Error("Choose at least one project.");
    const scopes = scopesForPreset(preset);
    const normalizedGrants = normalizePrivateConnectGrants(grants ?? privateConnectGrantsFromProjectIds(normalizedProjects));
    const maximumDays = preset === "collaborate" ? 30 : 90;
    const expiresAt = new Date(this.now().getTime() + Math.min(Math.max(1, grantDays), maximumDays) * 24 * 60 * 60 * 1_000).toISOString();
    const existing = this.data.devices.find((device) => device.id === pending.deviceId);
    const authorityReduction = existing
      ? await this.beginAuthorityReduction()
      : null;
    const device: PrivateConnectDevice = {
      id: pending.deviceId,
      label: pending.deviceLabel,
      scopes,
      projectIds: privateConnectGrantedProjectIds(normalizedGrants),
      grants: normalizedGrants,
      createdAt: existing?.createdAt ?? this.now().toISOString(),
      expiresAt,
      lastSeenAt: null,
      revokedAt: null,
      grantVersion: (existing?.grantVersion ?? 0) + 1,
    };
    if (!existing && this.data.devices.filter((candidate) => this.deviceCurrent(candidate)).length >= 16) throw new Error("The paired-device limit has been reached.");
    if (existing) {
      for (const session of this.sessions.values()) {
        if (session.deviceId === existing.id) this.sessions.delete(session.id);
      }
      this.data.sessions = this.data.sessions.filter((session) => session.deviceId !== existing.id);
    }
    this.data.devices = [...this.data.devices.filter((candidate) => candidate.id !== device.id), device];
    this.data.grantGeneration = authorityReduction?.generation
      ?? this.data.grantGeneration + 1;
    const session = this.createSession(device);
    pending.status = "approved";
    pending.cookie = createSessionCookie(sessionCookieValue(session), session.expiresAt);
    this.audit("pairing.accepted", device.id, `Paired browser with ${preset === "collaborate" ? "Collaborate" : "Monitor"} access.`);
    try {
      if (authorityReduction) await this.finishAuthorityReduction(authorityReduction);
      else await this.persist();
    } finally {
      if (existing) this.gateway.closeSessionsForDevice(existing.id);
    }
    this.emit();
  }

  async denyPairing(requestId: string): Promise<void> {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    pending.status = "denied";
    this.audit("pairing.denied", pending.deviceId, "A Private Connect pairing request was denied.");
    this.emit();
  }

  async revokeDevice(deviceId: string): Promise<void> {
    const device = this.requireDevice(deviceId);
    if (device.revokedAt) return;
    const authorityReduction = await this.beginAuthorityReduction();
    device.revokedAt = this.now().toISOString();
    device.grantVersion += 1;
    this.data!.grantGeneration = authorityReduction.generation;
    for (const session of this.sessions.values()) if (session.deviceId === deviceId) this.sessions.delete(session.id);
    this.data!.sessions = this.data!.sessions.filter((session) => session.deviceId !== deviceId);
    this.audit("device.revoked", deviceId, "A Private Connect device was revoked.");
    try {
      await this.finishAuthorityReduction(authorityReduction);
    } finally {
      this.gateway.closeSessionsForDevice(deviceId);
    }
    this.emit();
  }

  async updateDevice(deviceId: string, preset: PrivateConnectPreset, projectIds: string[], expiresAt: string, grants?: PrivateConnectConversationGrant[]): Promise<void> {
    const device = this.requireDevice(deviceId);
    const expiry = Date.parse(expiresAt);
    const maximum = this.now().getTime() + (preset === "collaborate" ? 30 : 90) * 24 * 60 * 60 * 1_000;
    if (!Number.isFinite(expiry) || expiry <= this.now().getTime() || expiry > maximum) throw new Error("The device expiry is outside the allowed range.");
    const normalizedGrants = normalizePrivateConnectGrants(grants ?? privateConnectGrantsFromProjectIds(projectIds));
    if (normalizedGrants.length === 0) throw new Error("Choose at least one project.");
    const authorityReduction = await this.beginAuthorityReduction();
    device.scopes = scopesForPreset(preset);
    device.projectIds = privateConnectGrantedProjectIds(normalizedGrants);
    device.grants = normalizedGrants;
    device.expiresAt = new Date(expiry).toISOString();
    device.grantVersion += 1;
    this.data!.grantGeneration = authorityReduction.generation;
    for (const session of this.sessions.values()) {
      if (session.deviceId === deviceId) session.expiresAt = device.expiresAt;
    }
    this.data!.sessions = this.data!.sessions.map((session) =>
      session.deviceId === deviceId
        ? { ...session, expiresAt: device.expiresAt, grantVersion: device.grantVersion }
        : session
    );
    this.audit("device.scope-changed", deviceId, "A Private Connect device grant was changed.");
    try {
      await this.finishAuthorityReduction(authorityReduction);
    } finally {
      this.gateway.closeSessionsForDevice(deviceId);
    }
    this.emit();
  }

  session(cookie: string | null): PrivateConnectSession | null {
    if (!cookie || !this.data || this.data.pendingAuthorityReduction || !this.data.enabled || this.privacyLocked || this.status !== "ready") return null;
    const cookieDigest = digest(cookie);
    const record = this.data.sessions.find((candidate) => candidate.tokenDigest === cookieDigest);
    if (!record) return null;
    const device = this.data.devices.find((candidate) => candidate.id === record.deviceId);
    if (!device || !this.deviceCurrent(device) || device.grantVersion !== record.grantVersion || Date.parse(record.expiresAt) <= this.now().getTime()) return null;
    let session = this.sessions.get(record.id);
    if (!session) {
      session = { id: record.id, csrf: randomBytes(32).toString("base64url"), expiresAt: record.expiresAt, deviceId: record.deviceId };
      this.sessions.set(record.id, session);
    }
    device.lastSeenAt = this.now().toISOString();
    return session;
  }

  csrf(session: PrivateConnectSession): string { return session.csrf; }

  issueWebSocketTicket(session: PrivateConnectSession): string {
    this.requireCurrentSession(session);
    const now = this.now().getTime();
    for (const [key, ticket] of this.tickets) if (ticket.expiresAt <= now) this.tickets.delete(key);
    while (this.tickets.size >= PRIVATE_CONNECT_LIMITS.websocketTickets) this.tickets.delete(this.tickets.keys().next().value!);
    const value = randomBytes(32).toString("base64url");
    this.tickets.set(value, { value, sessionId: session.id, expiresAt: this.now().getTime() + PRIVATE_CONNECT_LIMITS.websocketTicketTtlMs });
    return value;
  }

  consumeWebSocketTicket(ticket: string): PrivateConnectSession | null {
    const value = this.tickets.get(ticket);
    if (!value || value.expiresAt <= this.now().getTime()) {
      this.tickets.delete(ticket);
      return null;
    }
    this.tickets.delete(ticket);
    const session = [...this.sessions.values()].find((candidate) => candidate.id === value.sessionId);
    if (!session) return null;
    try { this.requireCurrentSession(session); return session; } catch { return null; }
  }

  async handleRequest(session: PrivateConnectSession, request: PrivateConnectRequest): Promise<PrivateConnectResponse> {
    const parsed = privateConnectRequestSchema.safeParse(request);
    if (!parsed.success) return failure(request.requestId, "invalid", "The Private Connect request is invalid.");
    try {
      this.requireCurrentSession(session);
      const device = this.requireDevice(session.deviceId);
      if (parsed.data.type === "session.logout") {
        await this.logout(session);
        return success(request.requestId, { kind: "logged-out" });
      }
      if (parsed.data.type === "client.ping") return success(request.requestId, { kind: "pong", at: this.now().toISOString() });
      if (!hasPrivateConnectScope(device.scopes, requiredScope(parsed.data.type))) return failure(request.requestId, "forbidden", "This device does not have permission for that action.");
      if (parsed.data.type === "input.respond" || parsed.data.type === "run.stop") {
        return await this.trackMutation(async () => {
          const response = await this.options.runtime.privateConnectRequest(
            this.legacyAuthorization(session, device),
            parsed.data as Exclude<PrivateConnectRuntimeRequest, { type: "prompt.send" }>,
          );
          return adaptPrivateConnectRuntimeResponse(response, device);
        });
      }
      if (parsed.data.type === "prompt.send") {
        const promptRequest = parsed.data;
        const prior = this.deliveries.get(promptRequest.deliveryId);
        if (prior) {
          if (prior.conversationId !== promptRequest.conversationId || prior.contentDigest !== contentDigest(promptRequest.content)) return failure(request.requestId, "invalid", "That delivery identifier was already used.");
          return { ...prior.response, requestId: promptRequest.requestId };
        }
        return await this.trackMutation(async () => {
          const response = await this.dispatchPrompt(session, device, promptRequest);
          if (response.ok && response.result && typeof response.result === "object" && (response.result as { kind?: unknown }).kind === "prompt.accepted") {
            const receipt: PrivateConnectDeliveryReceipt = {
              deliveryId: promptRequest.deliveryId,
              conversationId: promptRequest.conversationId,
              contentDigest: contentDigest(promptRequest.content),
              response: response as PrivateConnectDeliveryReceipt["response"],
            };
            this.deliveries.set(receipt.deliveryId, receipt);
            while (this.deliveries.size > 512) this.deliveries.delete(this.deliveries.keys().next().value!);
            if (this.data) {
              this.data.deliveryReceipts = [...this.deliveries.values()];
              await this.persist();
            }
          }
          return response;
        });
      }
      const legacySubject = this.legacyAuthorization(session, device);
      const legacyRequest = parsed.data.type === "state.get"
        ? { type: "state.get", requestId: parsed.data.requestId, ...(parsed.data.ifNoneMatch === undefined ? {} : { ifNoneMatch: parsed.data.ifNoneMatch }) }
        : { type: "conversation.get", requestId: parsed.data.requestId, conversationId: parsed.data.conversationId, ...(parsed.data.ifNoneMatch === undefined ? {} : { ifNoneMatch: parsed.data.ifNoneMatch }) };
      const response = await this.options.runtime.privateConnectRequest(legacySubject, legacyRequest as Exclude<PrivateConnectRuntimeRequest, { type: "prompt.send" }>);
      return adaptPrivateConnectRuntimeResponse(response, device);
    } catch (error) {
      const message = error instanceof Error ? sanitizeError(error.message) : "The request was rejected.";
      return failure(request.requestId, /uncertain/iu.test(message) ? "uncertain" : "forbidden", message);
    }
  }

  async logout(session: PrivateConnectSession): Promise<void> {
    this.sessions.delete(session.id);
    this.gateway.closeSession(session.id);
    if (this.data) {
      this.data.sessions = this.data.sessions.filter((candidate) => candidate.id !== session.id);
      await this.persist();
    }
  }

  async openSession(session: PrivateConnectSession): Promise<void> {
    if (this.sessions.get(session.id) !== session) return;
    this.audit("session.connected", session.deviceId, "A Private Connect browser connected.");
    this.emit();
  }

  async closeSession(session: PrivateConnectSession): Promise<void> {
    if (this.sessions.has(session.id)) {
      this.audit("session.disconnected", session.deviceId, "A Private Connect browser disconnected.");
      this.emit();
    }
  }

  async shutdown(): Promise<void> {
    await this.enqueueLifecycle(async () => {
      if (this.stopped) return;
      this.stopped = true;
      this.enableOperation += 1;
      this.pending.clear();
      this.tickets.clear();
      this.externalUrl = null;
      this.diagnostics = { ...this.diagnostics, gatewayPort: null, externalUrl: null };
      await this.gateway.stop().catch(() => undefined);
    });
  }

  private async enable(): Promise<void> {
    if (this.privacyLocked) throw new Error("Private Connect is paused while the desktop is locked.");
    if (this.data?.enabled && this.status === "ready") return;
    if (!this.options.store.available()) throw new Error("Secure platform storage is unavailable; Private Connect remains disabled.");
    const operation = ++this.enableOperation;
    this.status = "starting";
    this.statusMessage = "Starting the Private Connect gateway…";
    this.data ??= {
      version: 1,
      enabled: false,
      hostId: randomUUID(),
      servePort: null,
      serveTarget: null,
      grantGeneration: 1,
      pendingAuthorityReduction: null,
      devices: [],
      sessions: [],
      deliveryReceipts: [],
      audit: [],
      migrationNoticeShown: false,
    };
    const gateway = this.createGateway();
    this.gateway = gateway;
    await this.persist();
    const address = await gateway.start();
    this.diagnostics.gatewayPort = address.port;
    try {
      if (operation !== this.enableOperation || this.privacyLocked || this.stopped) {
        await gateway.stop().catch(() => undefined);
        return;
      }
      const ready = await this.tailscale.ensurePrivateServe(address.port, this.data.servePort, this.data.serveTarget, { hostId: this.data.hostId, buildVersion: this.options.buildVersion });
      if (operation !== this.enableOperation || this.privacyLocked || this.stopped) {
        await this.tailscale.disableOwnedServe(address.port).catch(() => undefined);
        await gateway.stop().catch(() => undefined);
        return;
      }
      this.data.enabled = true;
      this.data.servePort = ready.servePort;
      this.data.serveTarget = ready.ownership.target;
      this.externalUrl = ready.externalUrl;
      this.status = "ready";
      this.statusMessage = null;
      this.diagnostics = { ...this.diagnostics, tailscale: "connected", magicDns: "available", servePort: ready.servePort, externalUrl: ready.externalUrl, mappingOwnership: "owned", errorClass: null, setupUrl: null };
      this.audit("enabled", null, "Private Connect enabled through private Tailscale HTTPS.");
      await this.persist();
    } catch (error) {
      await this.tailscale.disableOwnedServe(address.port).catch(() => undefined);
      await gateway.stop().catch(() => undefined);
      if (operation !== this.enableOperation || this.privacyLocked || this.stopped) return;
      this.status = "error";
      this.statusMessage = error instanceof PrivateConnectTailscaleError ? error.message : "Private Connect could not be established safely.";
      this.diagnostics.errorClass = error instanceof PrivateConnectTailscaleError ? error.classification : "unknown";
      this.diagnostics.setupUrl = error instanceof PrivateConnectTailscaleError ? error.consentUrl : null;
      this.emit();
      throw error;
    }
  }

  private async disable(): Promise<void> {
    if (!this.data) return;
    const authorityReduction = await this.beginAuthorityReduction();
    this.enableOperation += 1;
    this.data.enabled = false;
    this.data.grantGeneration = authorityReduction.generation;
    this.sessions.clear();
    this.tickets.clear();
    this.pending.clear();
    this.data.sessions = [];
    try {
      await this.finishAuthorityReduction(authorityReduction);
    } finally {
      await this.stopOwnedServeAndGateway(true);
    }
    this.status = "off";
    this.externalUrl = null;
    this.diagnostics = { ...this.diagnostics, setupUrl: null };
    this.audit("disabled", null, "Private Connect disabled.");
    await this.persist();
  }

  private async stopOwnedServeAndGateway(clearPersistedProof = false): Promise<void> {
    const gateway = this.gateway;
    const gatewayPort = this.diagnostics.gatewayPort;
    const persistedProof = this.data?.servePort && this.data.serveTarget ? { port: this.data.servePort, target: this.data.serveTarget } : null;
    this.externalUrl = null;
    this.diagnostics = { ...this.diagnostics, gatewayPort: null, servePort: null, externalUrl: null, mappingOwnership: "missing" };
    let removed = false;
    try {
      await this.tailscale.disableOwnedServe(gatewayPort, persistedProof);
      removed = true;
    } catch (error) {
      this.notice = error instanceof PrivateConnectTailscaleError && error.classification === "mapping-ownership-lost"
        ? "Private Connect is off, but the Tailscale Serve mapping changed outside Inertia and was left untouched. Review it in Tailscale before re-enabling."
        : "Private Connect is off, but Inertia could not confirm removal of its Tailscale Serve mapping. Review Tailscale Serve before re-enabling.";
      this.diagnostics = { ...this.diagnostics, mappingOwnership: "unrelated" };
    }
    if (clearPersistedProof && removed && this.data) {
      this.data.servePort = null;
      this.data.serveTarget = null;
    }
    this.gateway.closeAllSessions();
    await gateway.stop().catch(() => undefined);
  }

  private prunePendingPairings(): void {
    const now = this.now().getTime();
    for (const [requestId, pending] of this.pending) {
      if (pending.status === "pending" && Date.parse(pending.expiresAt) <= now) pending.status = "expired";
      if (pending.status === "expired" || pending.status === "denied") this.pending.delete(requestId);
    }
  }

  private async dispatchPrompt(session: PrivateConnectSession, device: PrivateConnectDevice, request: Extract<PrivateConnectRequest, { type: "prompt.send" }>): Promise<PrivateConnectResponse> {
    const subject = this.legacyAuthorization(session, device);
    const legacyRequest: Extract<PrivateConnectRuntimeRequest, { type: "prompt.send" }> = {
      type: "prompt.send",
      requestId: request.requestId,
      deliveryId: request.deliveryId,
      conversationId: request.conversationId,
      content: request.content,
    };
    const prepare = this.options.runtime.preparePrivateConnectPrompt;
    const commit = this.options.runtime.commitPrivateConnectPrompt;
    if (!prepare || !commit) return failure(request.requestId, "unavailable", "The supervised runtime is not ready.");
    const prepared = await prepare(subject, legacyRequest);
    if (!("preparationId" in prepared)) return prepared;
    this.requireCurrentSession(session);
    this.requireDevice(device.id);
    if (!hasPrivateConnectScope(device.scopes, "private:prompt")) return failure(request.requestId, "forbidden", "Prompt permission changed before delivery.");
    const response = await commit(subject, legacyRequest, prepared.preparationId);
    return response;
  }

  private legacyAuthorization(session: PrivateConnectSession, device: PrivateConnectDevice): PrivateConnectRuntimeAuthorization {
    const scopes: ("view" | "prompt")[] = device.scopes.includes("private:prompt") ? ["view", "prompt"] : ["view"];
    const grants: PrivateConnectRuntimeGrant[] = device.grants.map((grant) => ({ ...grant, legacyProjectWide: grant.includeFutureConversations }));
    return {
      deviceId: device.id,
      sessionId: session.id,
      scopes,
      projectIds: device.projectIds,
      grants,
      grantVersion: device.grantVersion,
      expiresAt: device.expiresAt,
    };
  }

  private createSession(device: PrivateConnectDevice): PrivateConnectSession {
    const token = randomBytes(32).toString("base64url");
    const session: PrivateConnectSession = {
      id: randomUUID(),
      csrf: randomBytes(32).toString("base64url"),
      expiresAt: device.expiresAt,
      deviceId: device.id,
    };
    this.sessions.set(session.id, session);
    this.data!.sessions = [...this.data!.sessions.filter((candidate) => candidate.deviceId !== device.id), {
      id: session.id,
      tokenDigest: digest(token),
      deviceId: device.id,
      expiresAt: device.expiresAt,
      grantVersion: device.grantVersion,
    }].slice(-PRIVATE_CONNECT_LIMITS.sessions);
    Object.defineProperty(session, "__token", { value: token, enumerable: false });
    return session;
  }

  private restoreSession(record: PrivateConnectSessionRecord): void {
    const device = this.data?.devices.find((candidate) => candidate.id === record.deviceId);
    if (!device || !this.deviceCurrent(device) || device.grantVersion !== record.grantVersion) return;
    this.sessions.set(record.id, { id: record.id, csrf: randomBytes(32).toString("base64url"), expiresAt: record.expiresAt, deviceId: record.deviceId });
  }

  private requireCurrentSession(session: PrivateConnectSession): void {
    if (this.privacyLocked || this.data?.pendingAuthorityReduction || this.sessions.get(session.id) !== session || !this.data?.enabled) throw new Error("The Private Connect session is no longer active.");
    const device = this.requireDevice(session.deviceId);
    if (!this.deviceCurrent(device)) throw new Error("The device grant has expired or was revoked.");
  }

  private requireReady(): void {
    if (this.stopped || this.privacyLocked || this.data?.pendingAuthorityReduction || !this.data?.enabled || this.status !== "ready") throw new Error(this.statusMessage ?? "Private Connect is not ready.");
  }

  private requireDevice(deviceId: string): PrivateConnectDevice {
    const device = this.data?.devices.find((candidate) => candidate.id === deviceId);
    if (!device) throw new Error("That Private Connect device was not found.");
    return device;
  }

  private deviceCurrent(device: PrivateConnectDevice): boolean {
    return device.revokedAt === null && Date.parse(device.expiresAt) > this.now().getTime();
  }

  private deviceView(device: PrivateConnectDevice): PrivateConnectDeviceView {
    return { id: device.id, label: device.label, preset: presetForScopes(device.scopes), scopes: [...device.scopes], projectIds: [...device.projectIds], grants: structuredClone(device.grants), createdAt: device.createdAt, expiresAt: device.expiresAt, lastSeenAt: device.lastSeenAt, revokedAt: device.revokedAt };
  }

  private pendingView(pending: PendingPairing): PrivateConnectPendingPairingView {
    return { requestId: pending.requestId, deviceLabel: pending.deviceLabel, comparisonCode: pending.comparisonCode, receivedAt: pending.receivedAt, expiresAt: pending.expiresAt, tailnetLabel: pending.tailnetLabel };
  }

  private audit(type: PrivateConnectAuditEvent["type"], deviceId: string | null, detail: string): void {
    if (!this.data) return;
    this.data.audit.push({ id: randomUUID(), type, deviceId, detail: sanitizeError(detail), createdAt: this.now().toISOString() });
    if (this.data.audit.length > PRIVATE_CONNECT_LIMITS.auditEvents) this.data.audit.splice(0, this.data.audit.length - PRIVATE_CONNECT_LIMITS.auditEvents);
  }

  private async beginAuthorityReduction(): Promise<AuthorityReductionMarker> {
    if (!this.data) throw new Error("Private Connect storage is unavailable.");
    if (this.data.pendingAuthorityReduction) {
      throw new Error("Another Private Connect authority change is already in progress.");
    }
    const marker: AuthorityReductionMarker = {
      generation: this.data.grantGeneration + 1,
      createdAt: this.now().toISOString(),
    };
    this.data.pendingAuthorityReduction = marker;
    try {
      await this.persist();
    } catch (error) {
      this.status = "error";
      this.statusMessage = "Private Connect authority could not be persisted safely. Restart Inertia before reconnecting a browser.";
      this.tickets.clear();
      this.gateway.closeAllSessions();
      this.emit();
      throw error;
    }
    try {
      await withDeadline(
        Promise.allSettled(this.activeMutations),
        AUTHORITY_REDUCTION_DRAIN_TIMEOUT_MS,
      );
    } catch (error) {
      this.status = "error";
      this.statusMessage = "Private Connect could not safely finish an authority change. Restart Inertia before reconnecting a browser.";
      this.tickets.clear();
      this.gateway.closeAllSessions();
      this.emit();
      throw error;
    }
    return marker;
  }

  private async trackMutation<T>(operation: () => Promise<T>): Promise<T> {
    const pending = operation();
    this.activeMutations.add(pending);
    try {
      return await pending;
    } finally {
      this.activeMutations.delete(pending);
    }
  }

  private async finishAuthorityReduction(
    marker: AuthorityReductionMarker,
  ): Promise<void> {
    if (!this.data || this.data.pendingAuthorityReduction !== marker) {
      throw new Error("Private Connect authority reduction is no longer current.");
    }
    await this.persist();
    this.data.pendingAuthorityReduction = null;
    try {
      await this.persist();
    } catch (error) {
      this.data.pendingAuthorityReduction = marker;
      throw error;
    }
  }

  private async recoverInterruptedAuthorityReduction(): Promise<void> {
    const data = this.data;
    const marker = data?.pendingAuthorityReduction;
    if (!data || !marker) return;
    const revokedAt = this.now().toISOString();
    data.enabled = false;
    data.grantGeneration = Math.max(
      data.grantGeneration + 1,
      marker.generation + 1,
    );
    data.sessions = [];
    for (const device of data.devices) {
      if (device.revokedAt === null) device.revokedAt = revokedAt;
      device.grantVersion += 1;
    }
    this.sessions.clear();
    this.tickets.clear();
    this.audit(
      "authority.recovered",
      null,
      "Interrupted Private Connect authority reduction recovered fail closed.",
    );
    await this.persist();

    const proof = data.servePort && data.serveTarget
      ? { port: data.servePort, target: data.serveTarget }
      : null;
    try {
      await this.tailscale.disableOwnedServe(null, proof);
      data.servePort = null;
      data.serveTarget = null;
    } catch {
      this.notice = "Private Connect recovered fail closed, but Inertia could not confirm removal of its prior Tailscale Serve mapping. Review Tailscale Serve before re-enabling.";
    }
    data.pendingAuthorityReduction = null;
    await this.persist();
    this.status = "off";
    this.statusMessage = null;
  }

  private async persist(): Promise<void> {
    if (this.data) await this.options.store.save(this.data);
  }

  private emit(): void { this.options.onStateChange?.(this.state()); }

  private enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.lifecycle.then(operation, operation);
    this.lifecycle = next.then(() => undefined, () => undefined);
    return next;
  }

  private createGateway(): PrivateConnectGatewayServer {
    const gatewayOptions: PrivateConnectGatewayServerOptions = {
      host: this,
      staticRoot: this.options.staticRoot,
      buildVersion: this.options.buildVersion,
      now: this.now,
    };
    return new PrivateConnectGatewayServer(gatewayOptions);
  }
}

function requiredScope(type: PrivateConnectRequest["type"]): PrivateConnectScope {
  if (type === "state.get" || type === "conversation.get" || type === "client.ping" || type === "session.logout") return "private:read";
  if (type === "prompt.send") return "private:prompt";
  if (type === "input.respond") return "private:input";
  return "private:stop";
}

function adaptPrivateConnectRuntimeResponse(
  response: PrivateConnectRuntimeResponse,
  device: PrivateConnectDevice,
): PrivateConnectResponse {
  if (!response.ok) return response;
  const capabilities = {
    scopes: [...device.scopes],
    preset: presetForScopes(device.scopes),
    expiresAt: device.expiresAt,
  };
  if (response.result.kind === "state") {
    return {
      ...response,
      result: {
        kind: "state",
        state: {
          generatedAt: response.result.state.generatedAt,
          projects: response.result.state.projects,
          conversations: response.result.state.conversations.map((conversation) => publicConversation(conversation)),
          capabilities,
        },
      },
    };
  }
  if (response.result.kind === "conversation") {
    const detail = response.result.detail;
    return {
      ...response,
      result: {
        kind: "conversation",
        detail: {
          generatedAt: detail.generatedAt,
          conversation: publicConversation(detail.conversation, detail.waitingForLocalAction),
          messages: detail.messages,
          activities: detail.activities,
          subagents: detail.subagents,
          plan: detail.plan ?? null,
          questions: detail.questions ?? [],
          inputRequestId: detail.inputRequestId ?? null,
          waitingForLocalAction: detail.waitingForLocalAction,
        },
      },
    };
  }
  return response;
}

function publicConversation(
  conversation: PrivateConnectRuntimeConversation,
  pendingLocalAction = false,
): Pick<PrivateConnectRuntimeConversation, "id" | "projectId" | "title" | "providerLabel" | "runId" | "status" | "pendingLocalApproval" | "updatedAt"> & { pendingLocalAction: boolean } {
  return {
    id: conversation.id,
    projectId: conversation.projectId,
    title: conversation.title,
    providerLabel: conversation.providerLabel,
    runId: conversation.runId,
    status: conversation.status,
    pendingLocalApproval: conversation.pendingLocalApproval,
    pendingLocalAction: pendingLocalAction || conversation.pendingLocalApproval || conversation.status === "needs-input",
    updatedAt: conversation.updatedAt,
  };
}

function success(requestId: string, result: unknown): PrivateConnectResponse { return { type: "response", requestId, ok: true, result }; }
function failure(requestId: string, code: Extract<PrivateConnectResponse, { ok: false }>["code"], message: string): PrivateConnectResponse { return { type: "response", requestId, ok: false, code, message: sanitizeError(message) }; }

function sanitizeDeviceLabel(value: string): string | null {
  const normalized = value.trim().replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, PRIVATE_CONNECT_LIMITS.deviceLabelCharacters);
  return normalized || null;
}

function sanitizeError(value: string): string { return value.replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, 300) || "The request was rejected."; }
function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Private Connect authority change timed out safely.")), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}
function contentDigest(value: string): string { return createHash("sha256").update("inertia-private-connect-delivery\0").update(value).digest("hex"); }
function isUuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value); }
function digest(value: string): string { return createHash("sha256").update("inertia-private-connect-cookie\0").update(value).digest("hex"); }
function sessionCookieValue(session: PrivateConnectSession): string { return (session as PrivateConnectSession & { __token?: string }).__token ?? ""; }
function comparisonCodeFor(hostId: string, deviceId: string, invitationId: string): string { return (createHash("sha256").update("inertia-private-connect-pairing\0").update(hostId).update("\0").update(deviceId).update("\0").update(invitationId).digest().readUInt32BE(0) % 1_000_000).toString().padStart(6, "0"); }
