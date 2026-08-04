import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, join, relative, sep } from "node:path";
import WebSocket, { WebSocketServer } from "ws";

import {
  PRIVATE_CONNECT_LIMITS,
  PRIVATE_CONNECT_SOCKET_CLOSE,
  privateConnectInvitationSchema,
  privateConnectRequestSchema,
  type PrivateConnectRequest,
  type PrivateConnectResponse,
} from "../../shared/private-connect/protocol";
import type { PrivateConnectInvitation } from "../../shared/private-connect/protocol";

const SESSION_COOKIE = "__Host-inertia-private-connect";
const CSRF_HEADER = "x-inertia-private-connect-csrf";
const MAX_CONNECTIONS = 8;
const REQUEST_TIMEOUT_MS = 15_000;
const RATE_WINDOW_MS = 60_000;

export interface PrivateConnectSession {
  id: string;
  csrf: string;
  expiresAt: string;
  deviceId: string;
}

export interface PrivateConnectPairStartRequest {
  invitation: PrivateConnectInvitation;
  deviceLabel: string;
  deviceId: string;
}

export type PrivateConnectPairStatus =
  | { status: "pending"; requestId: string; expiresAt: string; comparisonCode: string }
  | { status: "approved"; requestId: string; expiresAt: string; cookie: string }
  | { status: "denied" | "expired"; requestId: string };

export interface PrivateConnectGatewayHost {
  wellKnown(): Record<string, unknown>;
  validHost?(host: string | undefined): boolean;
  pairStart(request: PrivateConnectPairStartRequest, networkLabel: string | null): Promise<{ requestId: string; expiresAt: string; comparisonCode: string }>;
  pairStatus(requestId: string): Promise<PrivateConnectPairStatus>;
  session(cookie: string | null): PrivateConnectSession | null;
  consumeWebSocketTicket(ticket: string): PrivateConnectSession | null;
  csrf(session: PrivateConnectSession): string;
  issueWebSocketTicket(session: PrivateConnectSession): string;
  handleRequest(session: PrivateConnectSession, request: PrivateConnectRequest): Promise<PrivateConnectResponse>;
  openSession?(session: PrivateConnectSession): Promise<void> | void;
  logout(session: PrivateConnectSession): Promise<void>;
  closeSession(session: PrivateConnectSession): Promise<void>;
}

export interface PrivateConnectGatewayServerOptions {
  host: PrivateConnectGatewayHost;
  staticRoot: string;
  buildVersion: string;
  maxBodyBytes?: number;
  requestTimeoutMs?: number;
  now?: () => Date;
}

export class PrivateConnectGatewayServer {
  private readonly server: Server;
  private readonly sockets = new Set<WebSocket>();
  private readonly websocketServer: WebSocketServer;
  private readonly host: PrivateConnectGatewayHost;
  private readonly staticRoot: string;
  private readonly buildVersion: string;
  private readonly maxBodyBytes: number;
  private readonly requestTimeoutMs: number;
  private readonly now: () => Date;
  private addressValue: { port: number; host: string } | null = null;
  private stopped = false;
  private readonly socketSessions = new Map<WebSocket, PrivateConnectSession>();
  private readonly admissions = new Map<string, number[]>();
  private readonly inFlightBySession = new Map<string, number>();

  constructor(options: PrivateConnectGatewayServerOptions) {
    this.host = options.host;
    this.staticRoot = options.staticRoot;
    this.buildVersion = options.buildVersion;
    this.maxBodyBytes = Math.max(1_024, Math.min(options.maxBodyBytes ?? PRIVATE_CONNECT_LIMITS.bodyBytes, PRIVATE_CONNECT_LIMITS.bodyBytes));
    this.requestTimeoutMs = Math.max(25, Math.min(options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS, REQUEST_TIMEOUT_MS));
    this.now = options.now ?? (() => new Date());
    this.server = createServer((request, response) => {
      void this.handleHttp(request, response).catch(() => {
        if (!response.headersSent) {
          writeJson(response, 500, { error: "unavailable", message: "Private Connect could not complete the request." });
        } else if (!response.writableEnded) {
          response.destroy();
        }
      });
    });
    this.websocketServer = new WebSocketServer({
      noServer: true,
      clientTracking: false,
      maxPayload: PRIVATE_CONNECT_LIMITS.websocketFrameBytes,
      perMessageDeflate: false,
    });
    this.server.on("upgrade", (request, socket, head) => {
      void this.handleUpgrade(request, socket, head);
    });
    this.websocketServer.on("connection", (socket: WebSocket, request: IncomingMessage, session: PrivateConnectSession) => {
      this.attachSocket(socket, request, session);
    });
  }

  async start(): Promise<{ port: number; host: string }> {
    if (this.addressValue) return this.addressValue;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        this.server.off("error", onError);
        const address = this.server.address();
        if (!address || typeof address === "string") {
          reject(new Error("The Private Connect gateway did not receive a TCP address."));
          return;
        }
        this.addressValue = { port: address.port, host: address.address };
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen({ host: "127.0.0.1", port: 0 });
    });
    if (!this.addressValue) throw new Error("The Private Connect gateway did not start.");
    return this.addressValue;
  }

  address(): { port: number; host: string } | null {
    return this.addressValue;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const socket of this.sockets) socket.close(1001, "Private Connect is stopping");
    this.sockets.clear();
    this.socketSessions.clear();
    this.inFlightBySession.clear();
    this.websocketServer.close();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.addressValue = null;
  }

  closeSessionsForDevice(
    deviceId: string,
    code: number = PRIVATE_CONNECT_SOCKET_CLOSE.accessRevoked,
    reason = "Private Connect access revoked",
  ): void {
    for (const [socket, session] of this.socketSessions) {
      if (session.deviceId === deviceId) socket.close(code, reason);
    }
  }

  closeAllSessions(
    code: number = PRIVATE_CONNECT_SOCKET_CLOSE.accessRevoked,
    reason = "Private Connect access changed",
  ): void {
    for (const socket of this.sockets) socket.close(code, reason);
  }

  activeSessionCount(): number {
    return new Set(
      [...this.socketSessions.values()].map((session) => session.id),
    ).size;
  }

  closeSession(sessionId: string): void {
    for (const [socket, session] of this.socketSessions) if (session.id === sessionId) socket.close(1008, "Private Connect session ended");
  }

  private async handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const parsedRequestUrl = parseUrl(request);
    const headers = securityHeaders(parsedRequestUrl?.pathname === "/" || parsedRequestUrl?.pathname.endsWith(".html") === true);
    for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
    if (this.stopped) {
      writeJson(response, 503, { error: "unavailable", message: "Private Connect is shutting down." });
      return;
    }
    const url = parsedRequestUrl;
    if (!url || !this.validHost(request.headers.host)) {
      writeJson(response, 400, { error: "invalid", message: "The request host is invalid." });
      return;
    }
    if (request.method === "GET" && url.pathname === "/.well-known/inertia/private-connect") {
      writeJson(response, 200, {
        product: "Inertia Private Connect",
        protocol: { minimum: 1, maximum: 1 },
        buildVersion: this.buildVersion,
        ...this.host.wellKnown(),
      });
      return;
    }
    if (request.method === "GET" && (url.pathname === "/" || !url.pathname.startsWith("/api/"))) {
      await this.serveStatic(url.pathname, response);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/session/csrf") {
      const session = this.host.session(readCookie(request.headers.cookie, SESSION_COOKIE));
      if (!session) {
        writeJson(response, 401, { error: "forbidden", message: "Pair this browser before using Private Connect." });
        return;
      }
      writeJson(response, 200, { csrf: this.host.csrf(session) });
      return;
    }
    if (!isJsonMutation(request, url)) {
      writeJson(response, 405, { error: "invalid", message: "Use the documented Private Connect JSON API." });
      return;
    }
    if (!this.validOrigin(request.headers.origin, request.headers.host)) {
      writeJson(response, 403, { error: "forbidden", message: "The request origin is not allowed." });
      return;
    }
    let body: unknown;
    try {
      body = await readJsonBody(request, this.maxBodyBytes);
    } catch (error) {
      writeJson(response, 400, { error: "invalid", message: error instanceof Error ? error.message : "The request body is invalid." });
      return;
    }
    const session = this.host.session(readCookie(request.headers.cookie, SESSION_COOKIE));
    if (url.pathname === "/api/pair/start") {
      if (!this.admit(`pair-start:${this.clientKey(request)}`, PRIVATE_CONNECT_LIMITS.pairingAttemptsPerMinute)) {
        writeJson(response, 429, { error: "rate-limited", message: "Pairing attempts are temporarily limited." });
        return;
      }
      await this.handlePairStart(body, request, response);
      return;
    }
    if (url.pathname === "/api/pair/status") {
      if (!this.admit(`pair-status:${this.clientKey(request)}`, PRIVATE_CONNECT_LIMITS.requestsPerMinute)) {
        writeJson(response, 429, { error: "rate-limited", message: "Pairing status checks are temporarily limited." });
        return;
      }
      await this.handlePairStatus(body, response);
      return;
    }
    if (!session) {
      writeJson(response, 401, { error: "forbidden", message: "Pair this browser before using Private Connect." });
      return;
    }
    if (!this.validCsrf(request, session)) {
      writeJson(response, 403, { error: "forbidden", message: "The Private Connect request could not be verified." });
      return;
    }
    if (url.pathname === "/api/session/ws-ticket") {
      if (!this.admit(`ticket:${session.deviceId}`, PRIVATE_CONNECT_LIMITS.requestsPerMinute)) {
        writeJson(response, 429, { error: "rate-limited", message: "Live connection requests are temporarily limited." });
        return;
      }
      writeJson(response, 200, { ticket: this.host.issueWebSocketTicket(session), expiresInMs: PRIVATE_CONNECT_LIMITS.websocketTicketTtlMs });
      return;
    }
    if (url.pathname === "/api/session/logout") {
      await this.host.logout(session);
      clearSessionCookie(response);
      writeJson(response, 200, { ok: true });
      return;
    }
    if (url.pathname === "/api/request") {
      if (!this.admit(`request:${session.deviceId}`, PRIVATE_CONNECT_LIMITS.requestsPerMinute)) {
        writeJson(response, 429, { type: "response", requestId: requestIdFromBody(body), ok: false, code: "rate-limited", message: "Private Connect requests are temporarily limited." } satisfies PrivateConnectResponse);
        return;
      }
      const parsed = privateConnectRequestSchema.safeParse(body);
      if (!parsed.success) {
        writeJson(response, 400, { error: "invalid", message: "The Private Connect request schema is invalid." });
        return;
      }
      const release = this.beginSessionRequest(session);
      if (!release) {
        writeJson(response, 200, busyResponse(parsed.data.requestId));
        return;
      }
      const operation = Promise.resolve().then(async () =>
        await this.host.handleRequest(session, parsed.data)
      );
      void operation.then(release, release);
      await this.respondWithRequest(response, parsed.data, operation);
      return;
    }
    writeJson(response, 404, { error: "not-found", message: "The Private Connect endpoint was not found." });
  }

  private async handlePairStart(body: unknown, request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!plainObject(body) || typeof body.deviceLabel !== "string" || typeof body.deviceId !== "string") {
      writeJson(response, 400, { error: "invalid", message: "The pairing request is invalid." });
      return;
    }
    const invitation = privateConnectInvitationSchema.safeParse(body.invitation);
    if (!invitation.success) {
      writeJson(response, 400, { error: "invalid", message: "The pairing invitation is invalid." });
      return;
    }
    try {
      const result = await this.host.pairStart({
        invitation: invitation.data,
        deviceLabel: body.deviceLabel,
        deviceId: body.deviceId,
      }, normalizeNetworkLabel(request.headers["tailscale-user-login"]));
      writeJson(response, 202, result);
    } catch (error) {
      writeJson(response, 400, { error: "invalid", message: error instanceof Error ? error.message : "Pairing was rejected." });
    }
  }

  private async handlePairStatus(body: unknown, response: ServerResponse): Promise<void> {
    if (!plainObject(body) || typeof body.requestId !== "string") {
      writeJson(response, 400, { error: "invalid", message: "The pairing status request is invalid." });
      return;
    }
    try {
      const status = await this.host.pairStatus(body.requestId);
      if (status.status === "approved") {
        response.setHeader("Set-Cookie", status.cookie);
        writeJson(response, 200, { status: "approved", requestId: status.requestId, expiresAt: status.expiresAt });
      } else writeJson(response, 200, status);
    } catch (error) {
      writeJson(response, 400, { error: "invalid", message: error instanceof Error ? error.message : "Pairing status is unavailable." });
    }
  }

  private async respondWithRequest(
    response: ServerResponse,
    request: PrivateConnectRequest,
    operation: Promise<PrivateConnectResponse>,
  ): Promise<void> {
    try {
      const result = await withTimeout(operation, this.requestTimeoutMs);
      writeJson(response, 200, result);
    } catch {
      const promptMayHaveCommitted = request.type === "prompt.send";
      writeJson(response, promptMayHaveCommitted ? 200 : 503, {
        type: "response",
        requestId: request.requestId,
        ok: false,
        code: promptMayHaveCommitted ? "uncertain" : "unavailable",
        message: promptMayHaveCommitted
          ? "Prompt delivery is uncertain. Check the desktop before retrying."
          : "The local runtime is unavailable.",
      });
    }
  }

  private async handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const url = parseUrl(request);
    if (!url || url.pathname !== "/api/ws" || !this.validHost(request.headers.host) || !this.validOrigin(request.headers.origin, request.headers.host)) {
      socket.destroy();
      return;
    }
    const ticket = url.searchParams.get("ticket");
    if (!ticket || this.sockets.size >= MAX_CONNECTIONS) {
      socket.destroy();
      return;
    }
    const session = this.host.consumeWebSocketTicket(ticket);
    if (!session) {
      socket.destroy();
      return;
    }
    this.websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      this.websocketServer.emit("connection", websocket, request, session);
    });
  }

  private attachSocket(socket: WebSocket, request: IncomingMessage, session: PrivateConnectSession): void {
    this.sockets.add(socket);
    this.socketSessions.set(socket, session);
    void Promise.resolve(this.host.openSession?.(session)).catch(() => undefined);
    const requestTimes: number[] = [];
    let lastActivity = this.now().getTime();
    const heartbeat = setInterval(() => {
      if (this.now().getTime() - lastActivity > 15 * 60_000) socket.terminate();
      else if (socket.readyState === WebSocket.OPEN) socket.ping();
    }, 30_000);
    heartbeat.unref?.();
    socket.on("message", (raw, isBinary) => {
      lastActivity = this.now().getTime();
      const cutoff = lastActivity - RATE_WINDOW_MS;
      while (requestTimes[0] !== undefined && requestTimes[0] <= cutoff) requestTimes.shift();
      if (requestTimes.length >= PRIVATE_CONNECT_LIMITS.requestsPerMinute) {
        socket.send(JSON.stringify({ type: "response", requestId: requestIdFromRaw(raw), ok: false, code: "rate-limited", message: "Private Connect requests are temporarily limited." } satisfies PrivateConnectResponse));
        return;
      }
      requestTimes.push(lastActivity);
      if (isBinary || Buffer.byteLength(raw.toString("utf8"), "utf8") > PRIVATE_CONNECT_LIMITS.websocketFrameBytes) {
        socket.close(1009, "Message too large");
        return;
      }
      let parsed: unknown;
      try { parsed = JSON.parse(raw.toString("utf8")) as unknown; } catch {
        socket.close(1003, "Invalid JSON");
        return;
      }
      const requestValue = privateConnectRequestSchema.safeParse(parsed);
      if (!requestValue.success) {
        socket.close(1008, "Invalid request");
        return;
      }
      const release = this.beginSessionRequest(session);
      if (!release) {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(busyResponse(requestValue.data.requestId)));
        return;
      }
      void this.host.handleRequest(session, requestValue.data).then((result) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(result));
      }).catch(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "response", requestId: requestValue.data.requestId, ok: false, code: "unavailable", message: "The local runtime is unavailable." } satisfies PrivateConnectResponse));
      }).finally(release);
    });
    socket.once("close", () => {
      clearInterval(heartbeat);
      this.sockets.delete(socket);
      this.socketSessions.delete(socket);
      void this.host.closeSession(session);
    });
    socket.once("error", () => socket.terminate());
    if (request.headers.origin) socket.send(JSON.stringify({ type: "connected", protocolVersion: 1 }));
  }

  private async serveStatic(pathname: string, response: ServerResponse): Promise<void> {
    let requested: string;
    try {
      requested = pathname === "/" ? "index.html" : decodeURIComponent(pathname.replace(/^\/+/, ""));
    } catch {
      writeJson(response, 400, { error: "invalid", message: "The asset path is invalid." });
      return;
    }
    if (requested.includes("\0") || requested.split(/[\\/]/u).includes("..")) {
      writeJson(response, 404, { error: "not-found", message: "The asset was not found." });
      return;
    }
    const root = await realpath(this.staticRoot).catch(() => null);
    if (!root) {
      writeJson(response, 503, { error: "unavailable", message: "The Private Connect browser is not packaged." });
      return;
    }
    const file = join(root, requested);
    const relativePath = relative(root, file);
    if (relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
      writeJson(response, 404, { error: "not-found", message: "The asset was not found." });
      return;
    }
    const resolvedFile = await realpath(file).catch(() => null);
    if (!resolvedFile) {
      writeJson(response, 404, { error: "not-found", message: "The asset was not found." });
      return;
    }
    const resolvedRelativePath = relative(root, resolvedFile);
    if (resolvedRelativePath === ".." || resolvedRelativePath.startsWith(`..${sep}`)) {
      writeJson(response, 404, { error: "not-found", message: "The asset was not found." });
      return;
    }
    const metadata = await stat(resolvedFile).catch(() => null);
    if (!metadata?.isFile()) {
      writeJson(response, 404, { error: "not-found", message: "The asset was not found." });
      return;
    }
    const body = await readFile(resolvedFile);
    response.setHeader("Content-Type", contentType(resolvedFile));
    response.setHeader("Cache-Control", extname(resolvedFile) === ".html" || !/[.-][a-f0-9]{8,}\./iu.test(basename(resolvedFile)) ? "no-store" : "public, max-age=31536000, immutable");
    response.statusCode = 200;
    response.end(body);
  }

  private validOrigin(origin: string | undefined, host: string | undefined): boolean {
    if (!origin) return false;
    try {
      const url = new URL(origin);
      return Boolean(host)
        && url.host.toLowerCase() === host!.toLowerCase()
        && (url.protocol === "https:" || url.hostname === "127.0.0.1" || url.hostname === "localhost")
        && !url.username && !url.password && !url.search && !url.hash;
    } catch {
      return false;
    }
  }

  private validHost(host: string | undefined): boolean {
    if (this.host.validHost) return this.host.validHost(host);
    const address = this.addressValue;
    return Boolean(address && host && (host === `127.0.0.1:${address.port}` || host === `localhost:${address.port}`));
  }

  private validCsrf(request: IncomingMessage, session: PrivateConnectSession): boolean {
    return request.headers[CSRF_HEADER] === this.host.csrf(session);
  }

  private clientKey(request: IncomingMessage): string {
    const address = request.socket.remoteAddress?.trim();
    return address && address.length <= 64 ? address : "unknown";
  }

  private admit(key: string, limit: number): boolean {
    const now = this.now().getTime();
    const cutoff = now - RATE_WINDOW_MS;
    const values = (this.admissions.get(key) ?? []).filter((value) => value > cutoff);
    if (values.length >= limit) {
      this.admissions.set(key, values);
      return false;
    }
    values.push(now);
    this.admissions.set(key, values);
    if (this.admissions.size > 128) {
      const oldest = this.admissions.keys().next().value;
      if (typeof oldest === "string") this.admissions.delete(oldest);
    }
    return true;
  }

  private beginSessionRequest(session: PrivateConnectSession): (() => void) | null {
    const current = this.inFlightBySession.get(session.id) ?? 0;
    if (current >= PRIVATE_CONNECT_LIMITS.inFlightRequestsPerSession) return null;
    this.inFlightBySession.set(session.id, current + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (this.inFlightBySession.get(session.id) ?? 1) - 1;
      if (next <= 0) this.inFlightBySession.delete(session.id);
      else this.inFlightBySession.set(session.id, next);
    };
  }

}

function parseUrl(request: IncomingMessage): URL | null {
  try { return new URL(request.url ?? "/", "http://127.0.0.1"); } catch { return null; }
}

function requestIdFromBody(value: unknown): string {
  if (plainObject(value) && typeof value.requestId === "string" && /^[0-9a-f-]{36}$/iu.test(value.requestId)) return value.requestId;
  return "00000000-0000-4000-8000-000000000000";
}

function requestIdFromRaw(raw: WebSocket.RawData): string {
  try { return requestIdFromBody(JSON.parse(raw.toString("utf8")) as unknown); } catch { return "00000000-0000-4000-8000-000000000000"; }
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonBody(request: IncomingMessage, maximum: number): Promise<unknown> {
  const contentLength = Number(request.headers["content-length"] ?? NaN);
  if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > maximum) throw new Error("The request body is too large or missing its length.");
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.byteLength;
    if (length > maximum) throw new Error("The request body is too large.");
    chunks.push(bytes);
  }
  if (length !== contentLength) throw new Error("The request body length was invalid.");
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(value));
}

function readCookie(header: string | undefined, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) {
      try { return decodeURIComponent(value.join("=")); } catch { return null; }
    }
  }
  return null;
}

function setSessionCookie(value: string, expiresAt: string): string {
  const maxAge = Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1_000));
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

function clearSessionCookie(response: ServerResponse): void {
  response.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
}

function normalizeNetworkLabel(value: string | string[] | undefined): string | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (!candidate) return null;
  const sanitized = candidate.trim().replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, 120);
  return sanitized || null;
}

function securityHeaders(html: boolean): Record<string, string> {
  return {
    "Content-Security-Policy": html
      ? "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' wss:; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
      : "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), usb=()",
    "Cache-Control": "no-store",
  };
}

function contentType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".json": return "application/manifest+json; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    default: return "application/octet-stream";
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Private Connect request timed out.")), timeoutMs);
    timer.unref?.();
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

function busyResponse(requestId: string): PrivateConnectResponse {
  return {
    type: "response",
    requestId,
    ok: false,
    code: "busy",
    message: "Too many Private Connect requests are already in progress.",
  };
}

function isJsonMutation(request: IncomingMessage, url: URL): boolean {
  if (request.method !== "POST") return false;
  if (!["/api/pair/start", "/api/pair/status", "/api/session/ws-ticket", "/api/session/logout", "/api/request"].includes(url.pathname)) return false;
  const contentType = request.headers["content-type"]?.toLowerCase() ?? "";
  return contentType === "application/json" || contentType === "application/json; charset=utf-8";
}

export function sessionCookie(value: string, expiresAt: string): string {
  return setSessionCookie(value, expiresAt);
}
