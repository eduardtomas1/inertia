import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

import { WebSocket, WebSocketServer } from "ws";

const PROTOCOL_VERSION = 2;
const MAX_ENVELOPE_BYTES = 132 * 1024;
const MAX_CONNECTIONS = 1_024;
const MAX_CONNECTIONS_PER_DESKTOP = 8;
const MAX_BROWSER_MESSAGES_PER_MINUTE = 240;
// Four active sessions may each use the protocol's 120-request/minute
// allowance. Leave a separate bounded margin for pairing/session lifecycle.
const MAX_DESKTOP_MESSAGES_PER_MINUTE = (4 * 120) + 64;
const MAX_BUFFERED_BYTES = 2 * MAX_ENVELOPE_BYTES;
const MINUTE_MS = 60_000;
const HEARTBEAT_MS = 30_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ROUTING_ID = /^[A-Za-z0-9_-]{1,64}$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const FRAME_KINDS = new Set([
  "pair.request",
  "pair.response",
  "session.open",
  "session.accept",
  "session.data",
  "session.close",
]);
const CLOSE_REASONS = new Set([
  "disabled",
  "expired",
  "revoked",
  "permissions-changed",
  "replay",
  "rate-limited",
  "protocol-error",
  "shutdown",
]);

export async function createReferenceRelay(options = {}) {
  const host = options.host ?? "127.0.0.1";
  const port = boundedInteger(options.port, 0, 65_535, 8787);
  const allowedOrigins = normalizeAllowedOrigins(options.allowedOrigins ?? []);
  const maxConnections = boundedInteger(
    options.maxConnections,
    1,
    MAX_CONNECTIONS,
    MAX_CONNECTIONS,
  );
  const maxConnectionsPerDesktop = boundedInteger(
    options.maxConnectionsPerDesktop,
    1,
    64,
    MAX_CONNECTIONS_PER_DESKTOP,
  );
  const maxBufferedBytes = boundedInteger(
    options.maxBufferedBytes,
    1_024,
    16 * MAX_ENVELOPE_BYTES,
    MAX_BUFFERED_BYTES,
  );
  const now = options.now ?? Date.now;
  const desktops = new Map();
  const peers = new Map();
  const stateBySocket = new WeakMap();
  const sockets = new Set();

  const server = createServer((request, response) => {
    const status = request.method === "GET" && request.url === "/health"
      ? 200
      : 404;
    response.writeHead(status, {
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      "Content-Type": "text/plain; charset=utf-8",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(status === 200 ? "ok" : "not found");
  });
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 1_000;
  server.maxHeadersCount = 32;

  const websocketServer = new WebSocketServer({
    noServer: true,
    clientTracking: false,
    perMessageDeflate: false,
    maxPayload: MAX_ENVELOPE_BYTES,
  });

  server.on("upgrade", (request, socket, head) => {
    if (
      request.url !== "/remote"
      || sockets.size >= maxConnections
      || !originAllowed(request.headers.origin, allowedOrigins)
    ) {
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      websocketServer.emit("connection", websocket, request);
    });
  });

  websocketServer.on("connection", (socket, request) => {
    sockets.add(socket);
    stateBySocket.set(socket, {
      role: "unregistered",
      endpointId: null,
      connectionId: null,
      origin: typeof request?.headers?.origin === "string"
        ? request.headers.origin
        : null,
      messageTimes: [],
      alive: true,
    });
    socket.on("pong", () => {
      const state = stateBySocket.get(socket);
      if (state) state.alive = true;
    });
    socket.on("message", (raw, isBinary) => {
      if (isBinary || raw.byteLength > MAX_ENVELOPE_BYTES) {
        socket.close(1009, "invalid message");
        return;
      }
      const state = stateBySocket.get(socket);
      if (
        !state
        || !takeRate(
          state.messageTimes,
          state.role === "desktop"
            ? MAX_DESKTOP_MESSAGES_PER_MINUTE
            : MAX_BROWSER_MESSAGES_PER_MINUTE,
          now(),
        )
      ) {
        sendError(socket, "rate-limited");
        socket.close(1008, "rate limited");
        return;
      }
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        sendError(socket, "invalid-message");
        return;
      }
      if (!validEnvelope(message)) {
        sendError(socket, "invalid-message");
        return;
      }
      if (message.type === "relay.register") {
        if (state.origin !== null) {
          sendError(socket, "invalid-message");
          return;
        }
        if (
          state.role !== "unregistered"
          || desktops.has(message.endpointId)
        ) {
          sendError(socket, "capacity");
          return;
        }
        state.role = "desktop";
        state.endpointId = message.endpointId;
        desktops.set(message.endpointId, socket);
        send(socket, { type: "relay.registered" });
        return;
      }
      if (message.type === "relay.connect") {
        if (
          state.role !== "unregistered"
          || (
            allowedOrigins.size > 0
            && (state.origin === null || !allowedOrigins.has(state.origin))
          )
        ) {
          sendError(socket, "invalid-message");
          return;
        }
        const desktop = desktops.get(message.endpointId);
        if (!desktop || desktop.readyState !== WebSocket.OPEN) {
          sendError(socket, "desktop-offline");
          return;
        }
        const desktopConnections = [...peers.values()].filter(
          (peer) => peer.desktop === desktop,
        ).length;
        if (desktopConnections >= maxConnectionsPerDesktop) {
          sendError(socket, "capacity");
          return;
        }
        const connectionId = randomUUID();
        state.role = "browser";
        state.endpointId = message.endpointId;
        state.connectionId = connectionId;
        peers.set(connectionId, { browser: socket, desktop });
        send(socket, { type: "relay.connected", connectionId });
        send(desktop, { type: "relay.peer-connected", connectionId });
        return;
      }
      if (message.type === "relay.disconnect") {
        const peer = peers.get(message.connectionId);
        if (
          !peer
          || (peer.browser !== socket && peer.desktop !== socket)
        ) {
          sendError(socket, "connection-missing");
          return;
        }
        disconnectPeer(message.connectionId);
        return;
      }
      const peer = peers.get(message.connectionId);
      if (!peer) {
        sendError(socket, "connection-missing");
        return;
      }
      const destination = socket === peer.desktop
        ? peer.browser
        : socket === peer.browser
          ? peer.desktop
          : null;
      if (!destination || destination.readyState !== WebSocket.OPEN) {
        sendError(socket, "connection-missing");
        return;
      }
      send(destination, {
        type: "relay.frame",
        connectionId: message.connectionId,
        frame: message.frame,
      });
    });
    socket.once("close", () => removeSocket(socket));
    socket.once("error", () => removeSocket(socket));
  });

  function removeSocket(socket) {
    if (!sockets.delete(socket)) return;
    const state = stateBySocket.get(socket);
    if (state?.role === "desktop" && state.endpointId) {
      if (desktops.get(state.endpointId) === socket) {
        desktops.delete(state.endpointId);
      }
    }
    for (const [connectionId, peer] of peers) {
      if (peer.browser === socket || peer.desktop === socket) {
        disconnectPeer(connectionId, socket);
      }
    }
  }

  function disconnectPeer(connectionId, source = null) {
    const peer = peers.get(connectionId);
    if (!peer) return;
    peers.delete(connectionId);
    for (const socket of [peer.browser, peer.desktop]) {
      if (socket !== source && socket.readyState === WebSocket.OPEN) {
        send(socket, { type: "relay.peer-disconnected", connectionId });
      }
    }
  }

  const heartbeat = setInterval(() => {
    for (const socket of sockets) {
      const state = stateBySocket.get(socket);
      if (!state?.alive) {
        socket.terminate();
        continue;
      }
      state.alive = false;
      socket.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });

  return {
    server,
    address: () => {
      const address = server.address();
      return address && typeof address !== "string" ? address : null;
    },
    close: async () => {
      clearInterval(heartbeat);
      for (const socket of sockets) socket.terminate();
      websocketServer.close();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };

  function send(socket, message) {
    if (socket.readyState !== WebSocket.OPEN) return;
    const serialized = JSON.stringify({
      protocolVersion: PROTOCOL_VERSION,
      ...message,
    });
    if (
      socket.bufferedAmount + Buffer.byteLength(serialized)
      > maxBufferedBytes
    ) {
      socket.terminate();
      return;
    }
    socket.send(serialized);
  }

  function sendError(socket, code) {
    send(socket, { type: "relay.error", code });
  }
}

function validEnvelope(value) {
  if (
    !plainObject(value)
    || value.protocolVersion !== PROTOCOL_VERSION
    || typeof value.type !== "string"
  ) return false;
  if (value.type === "relay.register") {
    return exactKeys(value, 5)
      && value.role === "desktop"
      && ROUTING_ID.test(value.endpointId)
      && boundedString(value.relayVersion, 40);
  }
  if (value.type === "relay.connect") {
    return exactKeys(value, 4)
      && ROUTING_ID.test(value.endpointId)
      && boundedString(value.browserVersion, 40);
  }
  if (value.type === "relay.disconnect") {
    return exactKeys(value, 3) && UUID.test(value.connectionId);
  }
  return value.type === "relay.frame"
    && exactKeys(value, 4)
    && UUID.test(value.connectionId)
    && validFrame(value.frame);
}

function validFrame(frame) {
  if (
    !plainObject(frame)
    || frame.protocolVersion !== PROTOCOL_VERSION
    || !FRAME_KINDS.has(frame.kind)
  ) return false;
  if (frame.kind === "pair.request") {
    return exactKeys(frame, 5)
      && UUID.test(frame.invitationId)
      && boundedBase64(frame.enc, 256)
      && boundedBase64(frame.ciphertext, MAX_ENVELOPE_BYTES);
  }
  if (frame.kind === "pair.response") {
    return exactKeys(frame, 5)
      && UUID.test(frame.requestId)
      && boundedBase64(frame.enc, 256)
      && boundedBase64(frame.ciphertext, MAX_ENVELOPE_BYTES);
  }
  if (frame.kind === "session.open" || frame.kind === "session.accept") {
    return exactKeys(frame, 5)
      && UUID.test(frame.sessionId)
      && boundedBase64(frame.enc, 256)
      && boundedBase64(frame.ciphertext, MAX_ENVELOPE_BYTES);
  }
  if (frame.kind === "session.data") {
    return exactKeys(frame, 5)
      && UUID.test(frame.sessionId)
      && Number.isSafeInteger(frame.sequence)
      && frame.sequence >= 0
      && boundedBase64(frame.ciphertext, MAX_ENVELOPE_BYTES);
  }
  return exactKeys(frame, 4)
    && UUID.test(frame.sessionId)
    && CLOSE_REASONS.has(frame.reason);
}

function plainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value, count) {
  return Object.keys(value).length === count;
}

function boundedString(value, maximum) {
  return typeof value === "string" && value.length >= 1 && value.length <= maximum;
}

function boundedBase64(value, maximum) {
  return boundedString(value, maximum) && BASE64URL.test(value);
}

function takeRate(times, maximum, now) {
  while (times.length > 0 && times[0] <= now - MINUTE_MS) times.shift();
  if (times.length >= maximum) return false;
  times.push(now);
  return true;
}

function boundedInteger(value, minimum, maximum, fallback) {
  return Number.isInteger(value)
    ? Math.max(minimum, Math.min(value, maximum))
    : fallback;
}

function normalizeAllowedOrigins(values) {
  if (!Array.isArray(values) || values.length > 16) {
    throw new Error("allowedOrigins must contain at most 16 origins.");
  }
  return new Set(values.map((value) => {
    if (typeof value !== "string" || value.length > 200) {
      throw new Error("Invalid allowed browser origin.");
    }
    const url = new URL(value);
    const loopback = [
      "127.0.0.1",
      "localhost",
      "[::1]",
    ].includes(url.hostname);
    if (
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
      || url.username
      || url.password
      || url.pathname !== "/"
      || url.search
      || url.hash
    ) {
      throw new Error("Browser origins must be HTTPS or loopback HTTP origins.");
    }
    return url.origin;
  }));
}

function originAllowed(origin, allowedOrigins) {
  if (origin === undefined) return true;
  return typeof origin === "string" && allowedOrigins.has(origin);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const host = process.env.INERTIA_REMOTE_RELAY_HOST ?? "127.0.0.1";
  if (
    host !== "127.0.0.1"
    && host !== "localhost"
    && host !== "::1"
    && process.env.INERTIA_REMOTE_ALLOW_INSECURE_BIND !== "1"
  ) {
    throw new Error(
      "Refusing a non-loopback plaintext bind. Terminate TLS in front of the relay and set INERTIA_REMOTE_ALLOW_INSECURE_BIND=1 explicitly.",
    );
  }
  const relay = await createReferenceRelay({
    host,
    port: Number(process.env.INERTIA_REMOTE_RELAY_PORT ?? "8787"),
    allowedOrigins: (process.env.INERTIA_REMOTE_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  });
  const shutdown = () => {
    void relay.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
