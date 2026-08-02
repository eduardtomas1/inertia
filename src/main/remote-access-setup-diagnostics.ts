import { isIP } from "node:net";

import WebSocket from "ws";

import {
  RELAY_PROTOCOL_RANGE,
  RELAY_PROTOCOL_VERSION,
  REMOTE_BROWSER_COMPATIBILITY,
  REMOTE_DESKTOP_VERSION,
  REMOTE_PROTOCOL_RANGE,
  relayServerMessageSchema,
  type RemoteSetupDiagnostics,
  type RemoteSetupMode,
} from "../shared/remote-protocol";
import {
  remoteRawDataByteLength,
  remoteRawDataText,
  validateRemoteRelayUrl,
} from "./remote-access-policy";

const PROBE_TIMEOUT_MS = 7_000;
const MAX_COMPANION_HTML_BYTES = 256 * 1_024;
const COMPANION_METADATA = /<meta\s+name=["']inertia-remote-companion["']\s+content=["']([^"']+)["']\s*\/?\s*>/iu;

export class RemoteSetupProbeError extends Error {
  constructor(
    readonly failureClass: RemoteSetupDiagnostics["failureClass"],
    message: string,
  ) {
    super(message);
    this.name = "RemoteSetupProbeError";
  }
}

export interface RemoteSetupProbeResult {
  relayUrl: string;
  companionUrl: string;
  relayIdentity: string;
  diagnostics: RemoteSetupDiagnostics;
}

export async function probeRemoteSetup(
  relayUrlInput: string,
  companionUrlInput: string,
  setupMode: RemoteSetupMode,
  options: {
    fetch?: typeof fetch;
    createSocket?: (url: string, origin: string) => WebSocket;
    now?: () => Date;
  } = {},
): Promise<RemoteSetupProbeResult> {
  const relayUrl = validateRemoteRelayUrl(relayUrlInput);
  const companionUrl = validateRemoteCompanionUrl(companionUrlInput, setupMode);
  const browserVersion = await probeCompanionHeaders(
    companionUrl,
    setupMode,
    options.fetch ?? fetch,
  );
  const relay = await probeRelay(
    relayUrl,
    new URL(companionUrl).origin,
    setupMode,
    options.createSocket ?? defaultCreateSocket,
  );
  return {
    relayUrl,
    companionUrl,
    relayIdentity: relay.relayIdentity,
    diagnostics: {
      status: "passed",
      testedAt: (options.now?.() ?? new Date()).toISOString(),
      transport: relayUrl.startsWith("wss:") ? "wss" : "loopback-development",
      tls: relayUrl.startsWith("wss:") ? "verified" : "not-applicable",
      originPolicy: "accepted",
      relayVersion: relay.relayVersion,
      browserVersion,
      desktopVersion: REMOTE_DESKTOP_VERSION,
      relayProtocol: RELAY_PROTOCOL_VERSION,
      remoteProtocol: REMOTE_PROTOCOL_RANGE.maximum,
      endpointAuthentication: relay.endpointAuthentication,
      persistence: relay.persistence,
      endpointOwnership: "unclaimed",
      endpointEpoch: null,
      lastConnectedAt: null,
      retryClass: "none",
      failureClass: "none",
      message: "HTTPS/WSS, security headers, origin policy, and component compatibility passed.",
    },
  };
}

export function validateRemoteCompanionUrl(
  value: string,
  setupMode: RemoteSetupMode,
): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new RemoteSetupProbeError(
      "configuration",
      "Enter a valid companion HTTPS URL.",
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new RemoteSetupProbeError(
      "configuration",
      "Companion URLs cannot contain credentials, query strings, or fragments.",
    );
  }
  const loopback = loopbackHostname(url.hostname);
  if (
    url.protocol !== "https:"
    && !(setupMode === "local-development" && url.protocol === "http:" && loopback)
  ) {
    throw new RemoteSetupProbeError(
      "configuration",
      "Use https://, or http:// on loopback only for local development.",
    );
  }
  if (setupMode === "self-hosted" && loopback) {
    throw new RemoteSetupProbeError(
      "configuration",
      "Self-hosted setup needs a private-network hostname reachable by the companion device.",
    );
  }
  return url.toString();
}

async function probeCompanionHeaders(
  companionUrl: string,
  setupMode: RemoteSetupMode,
  fetchImplementation: typeof fetch,
): Promise<string> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), PROBE_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await fetchImplementation(companionUrl, {
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: abort.signal,
    });
    return await readCompanionVersion(response, setupMode);
  } catch (error) {
    if (error instanceof RemoteSetupProbeError) throw error;
    throw probeNetworkError(error, "The companion HTTPS page could not be reached.");
  } finally {
    clearTimeout(timer);
  }
}

async function readCompanionVersion(
  response: Response,
  setupMode: RemoteSetupMode,
): Promise<string> {
  if (!response.ok) {
    throw new RemoteSetupProbeError(
      "network",
      `The companion returned HTTP ${response.status}.`,
    );
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const csp = response.headers.get("content-security-policy")?.toLowerCase() ?? "";
  if (
    !contentType.startsWith("text/html")
    || !directiveIncludes(csp, "frame-ancestors", "'none'")
    || !directiveIncludes(csp, "connect-src", setupMode === "self-hosted" ? "wss:" : null)
    || response.headers.get("x-content-type-options")?.toLowerCase() !== "nosniff"
    || response.headers.get("referrer-policy")?.toLowerCase() !== "no-referrer"
    || response.headers.get("cross-origin-resource-policy")?.toLowerCase() !== "same-origin"
  ) {
    throw new RemoteSetupProbeError(
      "browser-headers",
      "The companion response is missing its required CSP, frame, referrer, or content-type protections.",
    );
  }
  const html = await readBoundedText(response, MAX_COMPANION_HTML_BYTES);
  const metadata = COMPANION_METADATA.exec(html)?.[1];
  if (!metadata) {
    throw new RemoteSetupProbeError(
      "compatibility",
      "The companion page does not publish supported component metadata.",
    );
  }
  const values = new URLSearchParams(metadata.replaceAll(";", "&"));
  const browserVersion = values.get("version");
  if (
    !browserVersion
    || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(browserVersion)
    || values.get("relay") !== String(RELAY_PROTOCOL_RANGE.maximum)
    || values.get("remote") !== String(REMOTE_PROTOCOL_RANGE.maximum)
  ) {
    throw new RemoteSetupProbeError(
      "compatibility",
      "The companion browser version is incompatible. Install the matching checksummed browser artifact.",
    );
  }
  return browserVersion;
}

async function probeRelay(
  relayUrl: string,
  origin: string,
  setupMode: RemoteSetupMode,
  createSocket: (url: string, origin: string) => WebSocket,
): Promise<{
  relayIdentity: string;
  relayVersion: string;
  endpointAuthentication: "required" | "migration";
  persistence: "durable" | "ephemeral";
}> {
  return await new Promise((resolve, reject) => {
    let socket: WebSocket;
    let hello: ReturnType<typeof relayServerMessageSchema.parse> | null = null;
    let settled = false;
    let timer: NodeJS.Timeout;
    const finish = (error?: RemoteSetupProbeError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      if (socket.readyState === WebSocket.OPEN) socket.close(1000, "setup probe complete");
      else socket.terminate();
      if (error) reject(error);
    };
    try {
      socket = createSocket(relayUrl, origin);
    } catch (error) {
      reject(probeNetworkError(error, "The relay WSS URL could not be opened."));
      return;
    }
    timer = setTimeout(() => {
      finish(new RemoteSetupProbeError(
        "network",
        "The relay setup probe timed out.",
      ));
    }, PROBE_TIMEOUT_MS);
    timer.unref?.();
    socket.on("message", (raw, isBinary) => {
      if (settled || isBinary || remoteRawDataByteLength(raw) > 16 * 1_024) {
        finish(new RemoteSetupProbeError("compatibility", "The relay probe response was invalid."));
        return;
      }
      let message: ReturnType<typeof relayServerMessageSchema.parse>;
      try {
        message = relayServerMessageSchema.parse(JSON.parse(remoteRawDataText(raw)));
      } catch {
        finish(new RemoteSetupProbeError(
          "compatibility",
          "The relay does not speak the supported Remote Companion protocol.",
        ));
        return;
      }
      if (message.type === "relay.hello") {
        if (
          hello !== null
          || message.endpointAuthentication !== "required"
          || message.relayProtocol.minimum > RELAY_PROTOCOL_VERSION
          || message.relayProtocol.maximum < RELAY_PROTOCOL_VERSION
          || message.remoteProtocol.minimum > REMOTE_PROTOCOL_RANGE.maximum
          || message.remoteProtocol.maximum < REMOTE_PROTOCOL_RANGE.maximum
          || (setupMode === "self-hosted" && message.persistence !== "durable")
        ) {
          finish(new RemoteSetupProbeError(
            message.endpointAuthentication === "migration"
              ? "endpoint-authentication"
              : message.persistence === "ephemeral"
                ? "relay-storage"
                : "compatibility",
            message.persistence === "ephemeral" && setupMode === "self-hosted"
              ? "The self-hosted relay does not have durable endpoint storage."
              : "The relay needs the matching endpoint-authenticated v2 artifact.",
          ));
          return;
        }
        hello = message;
        socket.send(JSON.stringify({
          relayProtocolVersion: RELAY_PROTOCOL_VERSION,
          type: "relay.origin.probe",
          browser: REMOTE_BROWSER_COMPATIBILITY,
        }));
        return;
      }
      if (message.type === "relay.origin.accepted" && hello?.type === "relay.hello") {
        const result = {
          relayIdentity: hello.relayIdentity,
          relayVersion: hello.relayVersion,
          endpointAuthentication: hello.endpointAuthentication,
          persistence: hello.persistence,
        };
        finish();
        resolve(result);
        return;
      }
      if (message.type === "relay.incompatible") {
        finish(new RemoteSetupProbeError(
          "compatibility",
          `Component protocols are incompatible; ${message.guidance[0]?.action ?? "update"} the ${message.guidance[0]?.component ?? message.component}.`,
        ));
        return;
      }
      if (message.type === "relay.error") {
        finish(new RemoteSetupProbeError(
          message.code === "rate-limited" ? "network" : "origin-policy",
          message.code === "rate-limited"
            ? "The relay is rate limiting setup probes. Try again later."
            : "The relay rejected the configured companion origin.",
        ));
      }
    });
    socket.once("error", (error) => {
      finish(probeNetworkError(
        error,
        "The relay rejected the configured companion origin or could not be reached.",
        "origin-policy",
      ));
    });
    socket.once("close", () => {
      finish(new RemoteSetupProbeError(
        "origin-policy",
        "The relay closed the setup probe before accepting the companion origin.",
      ));
    });
  });
}

function defaultCreateSocket(url: string, origin: string): WebSocket {
  return new WebSocket(url, {
    origin,
    handshakeTimeout: PROBE_TIMEOUT_MS,
    maxPayload: 16 * 1_024,
    perMessageDeflate: false,
    followRedirects: false,
  });
}

function directiveIncludes(
  policy: string,
  name: string,
  required: string | null,
): boolean {
  const directive = policy.split(";").map((value) => value.trim())
    .find((value) => value === name || value.startsWith(`${name} `));
  return directive !== undefined && (required === null || directive.split(/\s+/u).includes(required));
}

async function readBoundedText(response: Response, maximum: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum) {
    throw new RemoteSetupProbeError("browser-headers", "The companion page is unexpectedly large.");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        throw new RemoteSetupProbeError("browser-headers", "The companion page is unexpectedly large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function probeNetworkError(
  error: unknown,
  fallback: string,
  fallbackClass: RemoteSetupDiagnostics["failureClass"] = "network",
): RemoteSetupProbeError {
  const detail = error instanceof Error
    ? `${error.message} ${String((error.cause as { code?: unknown } | undefined)?.code ?? "")}`
    : "";
  const tls = /cert|certificate|tls|ssl|self.signed|unable.to.verify/iu.test(detail);
  return new RemoteSetupProbeError(
    tls ? "tls-certificate" : fallbackClass,
    tls ? "TLS certificate verification failed." : fallback,
  );
}

function loopbackHostname(hostname: string): boolean {
  if (hostname === "localhost") return true;
  const normalized = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  return isIP(normalized) !== 0
    && (normalized === "127.0.0.1" || normalized === "::1");
}
