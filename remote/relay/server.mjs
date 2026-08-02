import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { WebSocket, WebSocketServer } from "ws";

import {
  RELAY_PROTOCOL_RANGE,
  REMOTE_PROTOCOL_RANGE,
  negotiateCompatibility,
} from "./compatibility.mjs";
import {
  EndpointAuthenticator,
  EndpointBindingStore,
} from "./endpoint-auth.mjs";

const RELAY_PROTOCOL_VERSION = 2;
const REMOTE_PROTOCOL_VERSION = 2;
const RELAY_VERSION = "0.2.0";
const MAX_ENVELOPE_BYTES = 132 * 1024;
const MAX_CONNECTIONS = 1_024;
const MAX_CONNECTIONS_PER_DESKTOP = 8;
const MAX_BROWSER_MESSAGES_PER_MINUTE = 240;
const MAX_DESKTOP_MESSAGES_PER_MINUTE = (4 * 120) + 64;
const MAX_BUFFERED_BYTES = 2 * MAX_ENVELOPE_BYTES;
const MINUTE_MS = 60_000;
const HEARTBEAT_MS = 30_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ROUTING_ID = /^[A-Za-z0-9_-]{1,64}$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
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
  const allowLegacyRegistration = options.allowLegacyRegistration === true;
  const temporaryStateDirectory = options.stateDirectory
    ? null
    : await mkdtemp(join(tmpdir(), "inertia-remote-relay-"));
  const stateDirectory = options.stateDirectory ?? temporaryStateDirectory;
  const store = await EndpointBindingStore.open({
    stateDirectory,
    initialize: temporaryStateDirectory !== null || options.initializeState === true,
    maxEndpoints: options.maxEndpoints,
    now,
  });
  const endpointAuthenticator = new EndpointAuthenticator({
    store,
    now,
    maxChallenges: options.maxChallenges,
    maxIpFailures: options.maxIpFailures,
    maxEndpointFailures: options.maxEndpointFailures,
    maxClaimsPerSourcePerMinute: options.maxClaimsPerSourcePerMinute,
    maxRateKeys: options.maxRateKeys,
  });
  const persistence = temporaryStateDirectory === null ? "durable" : "ephemeral";
  const endpointAuthentication = allowLegacyRegistration ? "migration" : "required";
  const relayDescriptor = componentDescriptor("relay", RELAY_VERSION);
  const desktops = new Map();
  const peers = new Map();
  const stateBySocket = new WeakMap();
  const sockets = new Set();

  const server = createServer((request, response) => {
    const healthy = request.method === "GET" && request.url === "/health";
    response.writeHead(healthy ? 200 : 404, {
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      "Content-Type": healthy
        ? "application/json; charset=utf-8"
        : "text/plain; charset=utf-8",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(healthy ? `${JSON.stringify({
      status: endpointAuthentication === "required" ? "ok" : "degraded",
      relayVersion: RELAY_VERSION,
      relayProtocol: RELAY_PROTOCOL_RANGE,
      remoteProtocol: REMOTE_PROTOCOL_RANGE,
      endpointAuthentication,
      persistence,
      originPolicy: allowedOrigins.size > 0 ? "configured" : "missing",
      transport: loopbackHost(host) ? "loopback-development" : "wss",
    })}\n` : "not found");
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
    const socketId = randomUUID();
    const state = {
      socketId,
      role: "unregistered",
      endpointId: null,
      endpointEpoch: null,
      connectionId: null,
      descriptor: null,
      previousLastConnectedAt: null,
      origin: typeof request?.headers?.origin === "string"
        ? request.headers.origin
        : null,
      source: directSource(request),
      messageTimes: [],
      authenticationMessages: 0,
      alive: true,
      messageTail: Promise.resolve(),
      legacy: false,
    };
    sockets.add(socket);
    stateBySocket.set(socket, state);
    send(socket, {
      type: "relay.hello",
      relayVersion: RELAY_VERSION,
      relayIdentity: store.relayIdentity,
      relayProtocol: RELAY_PROTOCOL_RANGE,
      remoteProtocol: REMOTE_PROTOCOL_RANGE,
      endpointAuthentication,
      persistence,
    });
    socket.on("pong", () => {
      const current = stateBySocket.get(socket);
      if (current) current.alive = true;
    });
    socket.on("message", (raw, isBinary) => {
      state.messageTail = state.messageTail.then(async () => {
        await handleMessage(socket, state, raw, isBinary);
      }).catch(() => {
        sendError(socket, "storage-unavailable");
        socket.close(1011, "relay unavailable");
      });
    });
    socket.once("close", () => removeSocket(socket));
    socket.once("error", () => removeSocket(socket));
  });

  async function handleMessage(socket, state, raw, isBinary) {
    if (isBinary || raw.byteLength > MAX_ENVELOPE_BYTES) {
      socket.close(1009, "invalid message");
      return;
    }
    if (!takeRate(
      state.messageTimes,
      state.role === "desktop"
        ? MAX_DESKTOP_MESSAGES_PER_MINUTE
        : MAX_BROWSER_MESSAGES_PER_MINUTE,
      now(),
    )) {
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

    if (allowLegacyRegistration && validLegacyEnvelope(message)) {
      await handleLegacyMessage(socket, state, message);
      return;
    }
    if (!validEnvelope(message)) {
      authenticationFailure(socket, state, "invalid-message");
      return;
    }
    if (message.type === "relay.claim.begin" || message.type === "relay.register.begin") {
      if (state.origin !== null || state.role !== "unregistered") {
        authenticationFailure(socket, state, "invalid-message");
        return;
      }
      state.authenticationMessages += 1;
      if (state.authenticationMessages > 2) {
        authenticationFailure(socket, state, "rate-limited");
        return;
      }
      state.descriptor = message.desktop;
      const current = await store.get(message.endpointId);
      state.previousLastConnectedAt = current?.lastConnectedAt ?? null;
      const result = message.type === "relay.claim.begin"
        ? await endpointAuthenticator.beginClaim({
            socketId: state.socketId,
            source: state.source,
            endpointId: message.endpointId,
            endpointPublicKey: message.endpointPublicKey,
          })
        : await endpointAuthenticator.beginRegistration({
            socketId: state.socketId,
            source: state.source,
            endpointId: message.endpointId,
          });
      if (!result.ok) {
        authenticationFailure(socket, state, result.code);
        return;
      }
      send(socket, {
        type: "relay.register.challenge",
        ...result.challenge,
        relayProtocol: RELAY_PROTOCOL_RANGE,
        remoteProtocol: REMOTE_PROTOCOL_RANGE,
      });
      return;
    }
    if (message.type === "relay.register.proof") {
      state.authenticationMessages += 1;
      if (
        state.origin !== null
        || state.role !== "unregistered"
        || state.authenticationMessages > 2
        || state.descriptor === null
      ) {
        authenticationFailure(socket, state, "invalid-message");
        return;
      }
      const result = await endpointAuthenticator.prove(
        state.socketId,
        state.source,
        message,
      );
      if (!result.ok) {
        authenticationFailure(socket, state, result.code);
        return;
      }
      const registration = registrationCompatibility(relayDescriptor, state.descriptor);
      if (!registration.ok) {
        sendIncompatible(socket, registration.incompatibility);
        return;
      }
      const previous = desktops.get(result.binding.endpointId);
      state.role = "desktop";
      state.endpointId = result.binding.endpointId;
      state.endpointEpoch = result.binding.epoch;
      desktops.set(result.binding.endpointId, {
        socket,
        epoch: result.binding.epoch,
        descriptor: state.descriptor,
        legacy: false,
      });
      if (previous && previous.socket !== socket) {
        disconnectDesktopRoutes(result.binding.endpointId, previous.epoch);
        previous.socket.close(4001, "endpoint superseded");
      }
      send(socket, {
        type: "relay.registered",
        ownership: previous && previous.socket !== socket
          ? "taken-over"
          : result.ownership,
        endpointEpoch: result.binding.epoch,
        lastConnectedAt: state.previousLastConnectedAt,
        selected: registration.selected,
        versions: {
          relay: RELAY_VERSION,
          desktop: state.descriptor.version,
        },
      });
      return;
    }
    if (message.type === "relay.origin.probe") {
      if (state.role !== "unregistered" || state.origin === null) {
        sendError(socket, "invalid-message");
        return;
      }
      send(socket, {
        type: "relay.origin.accepted",
        relayVersion: RELAY_VERSION,
        relayProtocol: RELAY_PROTOCOL_RANGE,
        remoteProtocol: REMOTE_PROTOCOL_RANGE,
      });
      return;
    }
    if (message.type === "relay.connect") {
      if (state.role !== "unregistered" || state.origin === null) {
        sendError(socket, "invalid-message");
        return;
      }
      const desktop = desktops.get(message.endpointId);
      if (!desktop || desktop.legacy || !desktopCurrent(message.endpointId, desktop)) {
        sendError(socket, "desktop-offline");
        return;
      }
      const compatibility = negotiateCompatibility({
        relay: relayDescriptor,
        desktop: desktop.descriptor,
        browser: message.browser,
      });
      if (!compatibility.ok) {
        sendIncompatible(socket, compatibility.incompatibility);
        return;
      }
      const desktopConnections = [...peers.values()].filter(
        (peer) => peer.endpointId === message.endpointId
          && peer.endpointEpoch === desktop.epoch,
      ).length;
      if (desktopConnections >= maxConnectionsPerDesktop) {
        sendError(socket, "capacity");
        return;
      }
      const connectionId = randomUUID();
      state.role = "browser";
      state.endpointId = message.endpointId;
      state.connectionId = connectionId;
      state.descriptor = message.browser;
      peers.set(connectionId, {
        browser: socket,
        desktop: desktop.socket,
        endpointId: message.endpointId,
        endpointEpoch: desktop.epoch,
      });
      const connection = {
        connectionId,
        endpointEpoch: desktop.epoch,
        relayIdentity: store.relayIdentity,
        selected: compatibility.selected,
        versions: compatibility.versions,
      };
      send(socket, { type: "relay.connected", ...connection });
      send(desktop.socket, { type: "relay.peer-connected", ...connection });
      return;
    }
    if (message.type === "relay.disconnect") {
      const peer = ownedPeer(socket, state, message.connectionId);
      if (!peer) {
        sendError(socket, "connection-missing");
        return;
      }
      disconnectPeer(message.connectionId);
      return;
    }
    const peer = ownedPeer(socket, state, message.connectionId);
    if (!peer) {
      sendError(socket, "connection-missing");
      return;
    }
    const destination = socket === peer.desktop ? peer.browser : peer.desktop;
    if (destination.readyState !== WebSocket.OPEN) {
      sendError(socket, "connection-missing");
      return;
    }
    send(destination, {
      type: "relay.frame",
      connectionId: message.connectionId,
      endpointEpoch: peer.endpointEpoch,
      frame: message.frame,
    });
  }

  async function handleLegacyMessage(socket, state, message) {
    if (message.type === "relay.register") {
      if (state.origin !== null || state.role !== "unregistered") {
        sendLegacyError(socket, "invalid-message");
        return;
      }
      if (await store.get(message.endpointId) !== null || desktops.has(message.endpointId)) {
        sendLegacyError(socket, "capacity");
        return;
      }
      state.role = "desktop";
      state.endpointId = message.endpointId;
      state.legacy = true;
      desktops.set(message.endpointId, {
        socket,
        epoch: 0,
        descriptor: componentDescriptor("desktop", message.relayVersion),
        legacy: true,
      });
      sendLegacy(socket, { type: "relay.registered" });
      return;
    }
    sendLegacyError(socket, "invalid-message");
  }

  function authenticationFailure(socket, state, code) {
    endpointAuthenticator.forgetSocket(state.socketId);
    sendError(socket, code);
    socket.close(1008, "endpoint authentication failed");
  }

  function sendIncompatible(socket, incompatibility) {
    send(socket, incompatibility);
    socket.close(1008, "component incompatible");
  }

  function desktopCurrent(endpointId, desktop) {
    const state = stateBySocket.get(desktop.socket);
    return desktops.get(endpointId) === desktop
      && state?.role === "desktop"
      && state.endpointId === endpointId
      && state.endpointEpoch === desktop.epoch
      && desktop.socket.readyState === WebSocket.OPEN;
  }

  function ownedPeer(socket, state, connectionId) {
    const peer = peers.get(connectionId);
    if (!peer) return null;
    const desktop = desktops.get(peer.endpointId);
    if (
      !desktop
      || desktop.socket !== peer.desktop
      || desktop.epoch !== peer.endpointEpoch
      || !desktopCurrent(peer.endpointId, desktop)
    ) {
      disconnectPeer(connectionId);
      return null;
    }
    if (socket === peer.desktop) {
      return state.role === "desktop"
        && state.endpointId === peer.endpointId
        && state.endpointEpoch === peer.endpointEpoch
        ? peer
        : null;
    }
    return socket === peer.browser && state.connectionId === connectionId
      ? peer
      : null;
  }

  function removeSocket(socket) {
    if (!sockets.delete(socket)) return;
    const state = stateBySocket.get(socket);
    if (state) endpointAuthenticator.forgetSocket(state.socketId);
    if (state?.role === "desktop" && state.endpointId) {
      const desktop = desktops.get(state.endpointId);
      if (desktop?.socket === socket && desktop.epoch === state.endpointEpoch) {
        desktops.delete(state.endpointId);
      }
    }
    for (const [connectionId, peer] of peers) {
      if (peer.browser === socket || peer.desktop === socket) {
        disconnectPeer(connectionId, socket);
      }
    }
  }

  function disconnectDesktopRoutes(endpointId, epoch) {
    for (const [connectionId, peer] of peers) {
      if (peer.endpointId === endpointId && peer.endpointEpoch === epoch) {
        disconnectPeer(connectionId);
      }
    }
  }

  function disconnectPeer(connectionId, source = null) {
    const peer = peers.get(connectionId);
    if (!peer) return;
    peers.delete(connectionId);
    for (const socket of [peer.browser, peer.desktop]) {
      if (socket !== source && socket.readyState === WebSocket.OPEN) {
        send(socket, {
          type: "relay.peer-disconnected",
          connectionId,
          endpointEpoch: peer.endpointEpoch,
        });
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
      if (temporaryStateDirectory !== null) {
        await rm(temporaryStateDirectory, { recursive: true, force: true });
      }
    },
  };

  function send(socket, message) {
    sendSerialized(socket, {
      relayProtocolVersion: RELAY_PROTOCOL_VERSION,
      ...message,
    });
  }

  function sendLegacy(socket, message) {
    sendSerialized(socket, {
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      ...message,
    });
  }

  function sendSerialized(socket, message) {
    if (socket.readyState !== WebSocket.OPEN) return;
    const serialized = JSON.stringify(message);
    if (socket.bufferedAmount + Buffer.byteLength(serialized) > maxBufferedBytes) {
      socket.terminate();
      return;
    }
    socket.send(serialized);
  }

  function sendError(socket, code) {
    send(socket, { type: "relay.error", code });
  }

  function sendLegacyError(socket, code) {
    sendLegacy(socket, { type: "relay.error", code });
  }
}

function validEnvelope(value) {
  if (!plainObject(value) || typeof value.type !== "string") return false;
  if (value.type === "relay.register.proof") {
    return exactKeys(value, 9);
  }
  if (value.relayProtocolVersion !== RELAY_PROTOCOL_VERSION) return false;
  if (value.type === "relay.claim.begin") {
    return exactKeys(value, 5)
      && ROUTING_ID.test(value.endpointId)
      && boundedBase64(value.endpointPublicKey, 256)
      && validComponent(value.desktop, "desktop");
  }
  if (value.type === "relay.register.begin") {
    return exactKeys(value, 4)
      && ROUTING_ID.test(value.endpointId)
      && validComponent(value.desktop, "desktop");
  }
  if (value.type === "relay.origin.probe") {
    return exactKeys(value, 3) && validComponent(value.browser, "browser");
  }
  if (value.type === "relay.connect") {
    return exactKeys(value, 4)
      && ROUTING_ID.test(value.endpointId)
      && validComponent(value.browser, "browser");
  }
  if (value.type === "relay.disconnect") {
    return exactKeys(value, 3) && UUID.test(value.connectionId);
  }
  return value.type === "relay.frame"
    && exactKeys(value, 4)
    && UUID.test(value.connectionId)
    && validFrame(value.frame);
}

function validLegacyEnvelope(value) {
  return plainObject(value)
    && value.protocolVersion === REMOTE_PROTOCOL_VERSION
    && value.type === "relay.register"
    && exactKeys(value, 5)
    && value.role === "desktop"
    && ROUTING_ID.test(value.endpointId)
    && typeof value.relayVersion === "string"
    && SEMVER.test(value.relayVersion);
}

function validComponent(value, kind) {
  return plainObject(value)
    && exactKeys(value, 4)
    && value.kind === kind
    && typeof value.version === "string"
    && value.version.length <= 40
    && SEMVER.test(value.version)
    && validRange(value.relayProtocol)
    && validRange(value.remoteProtocol);
}

function validRange(value) {
  return plainObject(value)
    && exactKeys(value, 2)
    && Number.isSafeInteger(value.minimum)
    && Number.isSafeInteger(value.maximum)
    && value.minimum >= 1
    && value.maximum >= value.minimum;
}

function componentDescriptor(kind, version) {
  return {
    kind,
    version,
    relayProtocol: RELAY_PROTOCOL_RANGE,
    remoteProtocol: REMOTE_PROTOCOL_RANGE,
  };
}

function registrationCompatibility(relay, desktop) {
  const negotiated = negotiateCompatibility({
    relay,
    desktop,
    browser: {
      ...desktop,
      kind: "browser",
    },
  });
  if (negotiated.ok) {
    return { ok: true, selected: negotiated.selected };
  }
  return negotiated;
}

function validFrame(frame) {
  if (
    !plainObject(frame)
    || frame.protocolVersion !== REMOTE_PROTOCOL_VERSION
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

function boundedBase64(value, maximum) {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= maximum
    && BASE64URL.test(value);
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
    const loopback = loopbackHost(url.hostname);
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

function directSource(request) {
  const value = request?.socket?.remoteAddress;
  return typeof value === "string" && value.length > 0 && value.length <= 200
    ? value
    : "unknown";
}

function loopbackHost(host) {
  return host === "127.0.0.1"
    || host === "localhost"
    || host === "::1"
    || host === "[::1]";
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const host = process.env.INERTIA_REMOTE_RELAY_HOST ?? "127.0.0.1";
  if (
    !loopbackHost(host)
    && process.env.INERTIA_REMOTE_ALLOW_INSECURE_BIND !== "1"
  ) {
    throw new Error(
      "Refusing a non-loopback plaintext bind. Terminate TLS in front of the relay and set INERTIA_REMOTE_ALLOW_INSECURE_BIND=1 explicitly.",
    );
  }
  const stateDirectory = process.env.INERTIA_REMOTE_RELAY_STATE_DIR;
  if (!stateDirectory && !loopbackHost(host)) {
    throw new Error("A durable INERTIA_REMOTE_RELAY_STATE_DIR is required outside loopback development.");
  }
  const relay = await createReferenceRelay({
    host,
    port: Number(process.env.INERTIA_REMOTE_RELAY_PORT ?? "8787"),
    allowedOrigins: (process.env.INERTIA_REMOTE_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    stateDirectory,
    initializeState: process.env.INERTIA_REMOTE_RELAY_INITIALIZE === "1",
    allowLegacyRegistration:
      process.env.INERTIA_REMOTE_ALLOW_LEGACY_REGISTRATION === "1",
  });
  const shutdown = () => {
    void relay.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
