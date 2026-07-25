import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";

import {
  backendCompatibilityProbeRequestSchema,
  backendCompatibilityProbeResultSchema,
  type BackendCompatibilityProbeRequest,
  type BackendCompatibilityProbeResult,
  type BackendProbeCapabilityEvidence,
  type BackendProbeFailure,
  type BackendProbeFailureCode,
  type BackendProbeContextEvidence,
} from "../../../shared/backend-probe";
import { isBackendCredentialSecret } from "../../../shared/backend-credentials";
import {
  MODEL_CAPABILITY_IDS,
  modelCapabilitySchema,
  type ModelBackendProtocol,
  type ModelCapability,
  type ModelCapabilityId,
  type ModelCapabilityProvenance,
} from "../../../shared/model-routing";

const DEFAULT_TIMEOUT_MS = 7_500;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_NATIVE_MODELS = 512;
const MAX_NATIVE_CAPABILITIES = MODEL_CAPABILITY_IDS.length;

export interface BackendProbeResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface NativeBackendProbeObservation {
  protocolVerified: boolean;
  modelVerified: boolean;
  capabilities?: readonly ModelCapability[];
  contextWindowTokens?: number | null;
  contextWindowProvenance?: Exclude<ModelCapabilityProvenance, "unknown"> | null;
  contextWindowDetail?: string | null;
}

export interface NativeBackendProbeAdapter {
  probe(
    input: {
      profileId: string;
      protocol: Extract<ModelBackendProtocol, "cursor-managed" | "opencode-native">;
      modelId: string;
    },
    signal: AbortSignal,
  ): Promise<NativeBackendProbeObservation>;
}

export interface BackendCompatibilityProbeDependencies {
  resolveCredential?: (
    secretReference: string,
    signal?: AbortSignal,
  ) => Promise<string | null>;
  resolveAddresses?: (
    hostname: string,
    signal: AbortSignal,
  ) => Promise<readonly BackendProbeResolvedAddress[]>;
  nativeAdapters?: Partial<Record<
    Extract<ModelBackendProtocol, "cursor-managed" | "opencode-native">,
    NativeBackendProbeAdapter
  >>;
  timeoutMs?: number;
  maxResponseBytes?: number;
  now?: () => Date;
}

interface ProbeObservation {
  protocolVerified: boolean;
  modelVerified: boolean;
  observedCapabilities: readonly ModelCapability[];
  contextWindowTokens: number | null;
  contextWindowProvenance: ModelCapabilityProvenance | null;
  contextWindowDetail: string | null;
}

interface HttpResponse {
  statusCode: number;
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  body: Buffer;
}

class BackendProbeError extends Error {
  constructor(
    readonly code: BackendProbeFailureCode,
    message: string,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "BackendProbeError";
  }
}

const BLOCKED_ADDRESSES = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  BLOCKED_ADDRESSES.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  BLOCKED_ADDRESSES.addSubnet(network, prefix, "ipv6");
}

const FIXED_FAILURE_MESSAGES: Readonly<Record<BackendProbeFailureCode, string>> = {
  "invalid-url": "The backend endpoint URL is invalid.",
  "insecure-url": "The backend endpoint must use HTTPS.",
  "private-network": "The backend endpoint resolves to a blocked network address.",
  "unsafe-redirect": "Backend probe redirects are not allowed.",
  "credential-unavailable": "The backend credential is unavailable.",
  "invalid-credentials": "The backend rejected the configured credential.",
  "unreachable": "The backend could not be reached.",
  "timeout": "The backend probe timed out.",
  "response-too-large": "The backend returned an oversized probe response.",
  "malformed-response": "The backend returned an invalid protocol response.",
  "missing-model": "The selected model is unavailable on this backend.",
  "unsupported-protocol": "The backend does not support the expected protocol.",
  "rate-limited": "The backend rate limit prevented verification.",
  "server-error": "The backend reported a server error.",
  "cancelled": "The backend probe was cancelled.",
};

export async function probeBackendCompatibility(
  requestInput: BackendCompatibilityProbeRequest,
  dependencies: BackendCompatibilityProbeDependencies = {},
  externalSignal?: AbortSignal,
): Promise<BackendCompatibilityProbeResult> {
  const request = backendCompatibilityProbeRequestSchema.parse(requestInput);
  const checkedAt = (dependencies.now ?? (() => new Date()))().toISOString();
  const timeoutMs = clampInteger(dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1, MAX_TIMEOUT_MS);
  const maxResponseBytes = clampInteger(
    dependencies.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    1,
    MAX_RESPONSE_BYTES,
  );
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer.unref();
  const onExternalAbort = (): void => controller.abort();
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

  try {
    let observation: ProbeObservation;
    if (
      request.profile.protocol === "anthropic-messages"
      || request.profile.protocol === "openai-responses"
    ) {
      observation = await probeHttpBackend(
        request,
        dependencies,
        controller.signal,
        maxResponseBytes,
      );
    } else {
      observation = await probeNativeBackend(request, dependencies, controller.signal);
    }
    return resultForObservation(request, observation, checkedAt);
  } catch (error) {
    const normalized = normalizeProbeError(error, timedOut, externalSignal?.aborted === true);
    return resultForFailure(request, normalized, checkedAt);
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

async function probeHttpBackend(
  request: BackendCompatibilityProbeRequest,
  dependencies: BackendCompatibilityProbeDependencies,
  signal: AbortSignal,
  maxResponseBytes: number,
): Promise<ProbeObservation> {
  if (request.endpointUrl === null) {
    throw new BackendProbeError("invalid-url", FIXED_FAILURE_MESSAGES["invalid-url"]);
  }

  let secret: string | null = null;
  try {
    const baseUrl = validateEndpointUrl(request.endpointUrl, request.allowInsecureLocalhost);
    const endpoint = apiEndpoint(baseUrl, request.profile.protocol);
    secret = await resolveProbeCredential(request, dependencies, signal);
    throwIfAborted(signal);
    const resolved = await resolveAndValidateAddress(
      baseUrl,
      request.allowInsecureLocalhost,
      dependencies.resolveAddresses ?? resolveAddresses,
      signal,
    );
    const body = probeBody(request.profile.protocol, request.modelId);
    const headers = probeHeaders(
      request.profile.protocol,
      request.profile.authenticationMode,
      secret,
    );
    secret = null;
    const response = await boundedRequest(
      endpoint,
      resolved,
      body,
      headers,
      signal,
      maxResponseBytes,
    );
    scrubHeaders(headers);
    if (response.statusCode >= 300 && response.statusCode < 400) {
      throw new BackendProbeError("unsafe-redirect", FIXED_FAILURE_MESSAGES["unsafe-redirect"]);
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw statusError(response.statusCode, response.headers, response.body);
    }
    return parseStreamingResponse(
      request.profile.protocol as "anthropic-messages" | "openai-responses",
      request.modelId,
      response.headers,
      response.body,
    );
  } finally {
    secret = null;
  }
}

async function probeNativeBackend(
  request: BackendCompatibilityProbeRequest,
  dependencies: BackendCompatibilityProbeDependencies,
  signal: AbortSignal,
): Promise<ProbeObservation> {
  const protocol = request.profile.protocol;
  if (protocol !== "cursor-managed" && protocol !== "opencode-native") {
    throw new BackendProbeError("unsupported-protocol", FIXED_FAILURE_MESSAGES["unsupported-protocol"]);
  }
  const adapter = dependencies.nativeAdapters?.[protocol];
  if (!adapter) {
    throw new BackendProbeError("unsupported-protocol", FIXED_FAILURE_MESSAGES["unsupported-protocol"]);
  }
  const observed: unknown = await abortable(adapter.probe({
    profileId: request.profile.id,
    protocol,
    modelId: request.modelId,
  }, signal), signal);
  throwIfAborted(signal);
  if (
    !plainObject(observed)
    || typeof observed.protocolVerified !== "boolean"
    || typeof observed.modelVerified !== "boolean"
  ) {
    throw new BackendProbeError("malformed-response", FIXED_FAILURE_MESSAGES["malformed-response"]);
  }
  if (!observed.protocolVerified) {
    throw new BackendProbeError("unsupported-protocol", FIXED_FAILURE_MESSAGES["unsupported-protocol"]);
  }
  if (!observed.modelVerified) {
    throw new BackendProbeError("missing-model", FIXED_FAILURE_MESSAGES["missing-model"]);
  }
  const capabilities = validateNativeCapabilities(
    observed.capabilities === undefined ? [] : observed.capabilities,
  );
  if (
    observed.contextWindowTokens !== undefined
    && observed.contextWindowTokens !== null
    && typeof observed.contextWindowTokens !== "number"
  ) {
    throw new BackendProbeError("malformed-response", FIXED_FAILURE_MESSAGES["malformed-response"]);
  }
  const contextWindowTokens = typeof observed.contextWindowTokens === "number"
    ? observed.contextWindowTokens
    : null;
  if (
    contextWindowTokens !== null
    && (!Number.isSafeInteger(contextWindowTokens) || contextWindowTokens <= 0 || contextWindowTokens > 100_000_000)
  ) {
    throw new BackendProbeError("malformed-response", FIXED_FAILURE_MESSAGES["malformed-response"]);
  }
  return {
    protocolVerified: true,
    modelVerified: true,
    observedCapabilities: capabilities,
    contextWindowTokens,
    contextWindowProvenance: contextWindowTokens === null
      ? null
      : validContextProvenance(observed.contextWindowProvenance),
    contextWindowDetail: boundedDetail(
      typeof observed.contextWindowDetail === "string" ? observed.contextWindowDetail : null,
    ),
  };
}

async function resolveProbeCredential(
  request: BackendCompatibilityProbeRequest,
  dependencies: BackendCompatibilityProbeDependencies,
  signal: AbortSignal,
): Promise<string | null> {
  if (request.profile.authenticationMode === "none") return null;
  if (request.profile.authenticationMode === "harness-managed") {
    throw new BackendProbeError("credential-unavailable", FIXED_FAILURE_MESSAGES["credential-unavailable"]);
  }
  if (!request.secretReference || !dependencies.resolveCredential) {
    throw new BackendProbeError("credential-unavailable", FIXED_FAILURE_MESSAGES["credential-unavailable"]);
  }
  let secret: string | null;
  try {
    secret = await abortable(
      dependencies.resolveCredential(request.secretReference, signal),
      signal,
    );
  } catch {
    throwIfAborted(signal);
    throw new BackendProbeError("credential-unavailable", FIXED_FAILURE_MESSAGES["credential-unavailable"]);
  }
  if (!isBackendCredentialSecret(secret)) {
    throw new BackendProbeError("credential-unavailable", FIXED_FAILURE_MESSAGES["credential-unavailable"]);
  }
  return secret;
}

function validateEndpointUrl(value: string, allowInsecureLocalhost: boolean): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BackendProbeError("invalid-url", FIXED_FAILURE_MESSAGES["invalid-url"]);
  }
  if (
    url.username
    || url.password
    || url.search
    || url.hash
    || value.length > 2_048
  ) {
    throw new BackendProbeError("invalid-url", FIXED_FAILURE_MESSAGES["invalid-url"]);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BackendProbeError("invalid-url", FIXED_FAILURE_MESSAGES["invalid-url"]);
  }
  const literalLocal = isLiteralLocalhost(url.hostname);
  if (url.protocol === "http:" && !(allowInsecureLocalhost && literalLocal)) {
    throw new BackendProbeError("insecure-url", FIXED_FAILURE_MESSAGES["insecure-url"]);
  }
  if (literalLocal && !allowInsecureLocalhost) {
    throw new BackendProbeError("private-network", FIXED_FAILURE_MESSAGES["private-network"]);
  }
  return url;
}

async function resolveAndValidateAddress(
  url: URL,
  allowInsecureLocalhost: boolean,
  resolver: NonNullable<BackendCompatibilityProbeDependencies["resolveAddresses"]>,
  signal: AbortSignal,
): Promise<BackendProbeResolvedAddress> {
  const hostname = stripIpv6Brackets(url.hostname);
  const literalLocal = isLiteralLocalhost(url.hostname);
  let addresses: readonly BackendProbeResolvedAddress[];
  if (isIP(hostname)) {
    addresses = [{ address: hostname, family: isIP(hostname) as 4 | 6 }];
  } else {
    try {
      addresses = await abortable(resolver(hostname, signal), signal);
    } catch {
      throwIfAborted(signal);
      throw new BackendProbeError("unreachable", FIXED_FAILURE_MESSAGES.unreachable);
    }
  }
  throwIfAborted(signal);
  if (addresses.length === 0 || addresses.length > 32) {
    throw new BackendProbeError("unreachable", FIXED_FAILURE_MESSAGES.unreachable);
  }
  for (const candidate of addresses) {
    if (
      (candidate.family !== 4 && candidate.family !== 6)
      || isIP(candidate.address) !== candidate.family
    ) {
      throw new BackendProbeError("unreachable", FIXED_FAILURE_MESSAGES.unreachable);
    }
    const loopback = isLoopbackAddress(candidate.address, candidate.family);
    if (literalLocal) {
      if (!allowInsecureLocalhost || !loopback) {
        throw new BackendProbeError("private-network", FIXED_FAILURE_MESSAGES["private-network"]);
      }
    } else if (loopback || isBlockedAddress(candidate.address, candidate.family)) {
      throw new BackendProbeError("private-network", FIXED_FAILURE_MESSAGES["private-network"]);
    }
  }
  return addresses[0]!;
}

async function resolveAddresses(
  hostname: string,
  signal: AbortSignal,
): Promise<readonly BackendProbeResolvedAddress[]> {
  throwIfAborted(signal);
  const result = await dnsLookup(hostname, { all: true, verbatim: true });
  throwIfAborted(signal);
  return result.map(({ address, family }) => ({
    address,
    family: family as 4 | 6,
  }));
}

function apiEndpoint(baseUrl: URL, protocol: ModelBackendProtocol): URL {
  const endpoint = new URL(baseUrl.toString());
  const current = endpoint.pathname.split("/").filter(Boolean);
  const operation = protocol === "anthropic-messages" ? "messages" : "responses";
  const tail = current.slice(-2);
  if (
    tail[0] === "v1"
    && (tail[1] === "messages" || tail[1] === "responses")
    && tail[1] !== operation
  ) {
    throw new BackendProbeError(
      "unsupported-protocol",
      FIXED_FAILURE_MESSAGES["unsupported-protocol"],
    );
  }
  const segments = tail[0] === "v1" && tail[1] === operation
    ? current
    : current.at(-1) === "v1"
      ? [...current, operation]
      : [...current, "v1", operation];
  endpoint.pathname = `/${segments.join("/")}`;
  endpoint.search = "";
  endpoint.hash = "";
  return endpoint;
}

function probeBody(protocol: ModelBackendProtocol, modelId: string): Buffer {
  const value = protocol === "anthropic-messages"
    ? {
        model: modelId,
        max_tokens: 1,
        messages: [{ role: "user", content: "Reply with OK." }],
        stream: true,
      }
    : {
        model: modelId,
        input: "Reply with OK.",
        max_output_tokens: 16,
        store: false,
        stream: true,
      };
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.byteLength > MAX_REQUEST_BYTES) {
    throw new BackendProbeError("malformed-response", FIXED_FAILURE_MESSAGES["malformed-response"]);
  }
  return body;
}

function probeHeaders(
  protocol: ModelBackendProtocol,
  authenticationMode: BackendCompatibilityProbeRequest["profile"]["authenticationMode"],
  secret: string | null,
): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "text/event-stream",
    "content-type": "application/json",
  };
  if (protocol === "anthropic-messages") headers["anthropic-version"] = "2023-06-01";
  if (secret !== null) {
    if (protocol === "anthropic-messages" && authenticationMode === "api-key") {
      headers["x-api-key"] = secret;
    } else {
      headers.authorization = `Bearer ${secret}`;
    }
  }
  return headers;
}

function scrubHeaders(headers: Record<string, string>): void {
  for (const key of Object.keys(headers)) {
    if (key === "authorization" || key === "x-api-key") headers[key] = "";
    delete headers[key];
  }
}

function boundedRequest(
  url: URL,
  address: BackendProbeResolvedAddress,
  body: Buffer,
  headers: Record<string, string>,
  signal: AbortSignal,
  maxResponseBytes: number,
): Promise<HttpResponse> {
  throwIfAborted(signal);
  return new Promise<HttpResponse>((resolve, reject) => {
    let settled = false;
    let activeRequest: ReturnType<typeof httpRequest> | null = null;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => {
      activeRequest?.destroy(new BackendProbeError("cancelled", FIXED_FAILURE_MESSAGES.cancelled));
    };
    const requestHeaders: Record<string, string> = {
      ...headers,
      "content-length": String(body.byteLength),
    };
    const options: RequestOptions & { servername?: string } = {
      protocol: url.protocol,
      hostname: stripIpv6Brackets(url.hostname),
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: "POST",
      headers: requestHeaders,
      agent: false,
      lookup: (_hostname, _options, callback) => {
        if (typeof _options === "object" && _options.all === true) {
          callback(null, [{ address: address.address, family: address.family }]);
          return;
        }
        callback(null, address.address, address.family);
      },
    };
    if (url.protocol === "https:" && isIP(stripIpv6Brackets(url.hostname)) === 0) {
      options.servername = stripIpv6Brackets(url.hostname);
    }
    try {
      activeRequest = (url.protocol === "https:" ? httpsRequest : httpRequest)(options, (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const declaredLength = Number(response.headers["content-length"]);
        if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
          response.destroy(new BackendProbeError(
            "response-too-large",
            FIXED_FAILURE_MESSAGES["response-too-large"],
          ));
        }
        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += buffer.byteLength;
          if (size > maxResponseBytes) {
            response.destroy(new BackendProbeError(
              "response-too-large",
              FIXED_FAILURE_MESSAGES["response-too-large"],
            ));
            return;
          }
          chunks.push(buffer);
        });
        response.once("error", (error) => finish(() => reject(error)));
        response.once("end", () => finish(() => resolve({
          statusCode: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks, size),
        })));
      });
    } finally {
      // ClientRequest copies these values synchronously. Clear the temporary
      // construction objects before the request can settle or be inspected.
      scrubHeaders(requestHeaders);
      scrubHeaders(headers);
    }
    activeRequest.once("error", (error) => finish(() => reject(error)));
    signal.addEventListener("abort", onAbort, { once: true });
    activeRequest.end(body);
  });
}

function parseStreamingResponse(
  protocol: Extract<ModelBackendProtocol, "anthropic-messages" | "openai-responses">,
  requestedModelId: string,
  headers: HttpResponse["headers"],
  body: Buffer,
): ProbeObservation {
  const contentType = firstHeader(headers["content-type"]).toLowerCase();
  if (!contentType.includes("text/event-stream")) {
    throw new BackendProbeError("unsupported-protocol", FIXED_FAILURE_MESSAGES["unsupported-protocol"]);
  }
  const events = parseSseEvents(body);
  let protocolVerified = false;
  let modelVerified = false;
  let usageVerified = false;
  let terminal = false;

  for (const event of events) {
    if (event.data === "[DONE]") {
      terminal = protocol === "openai-responses" || terminal;
      continue;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(event.data);
    } catch {
      throw new BackendProbeError("malformed-response", FIXED_FAILURE_MESSAGES["malformed-response"]);
    }
    if (!plainObject(payload)) {
      throw new BackendProbeError("malformed-response", FIXED_FAILURE_MESSAGES["malformed-response"]);
    }
    if (protocol === "anthropic-messages") {
      const type = stringField(payload, "type") ?? event.event;
      if (type === "message_start") {
        const message = plainObject(payload.message) ? payload.message : null;
        protocolVerified = message?.type === "message";
        const actualModel = message ? stringField(message, "model") : null;
        modelVerified = actualModel === requestedModelId;
        usageVerified ||= validUsage(message?.usage);
      } else if (type === "message_delta") {
        usageVerified ||= validUsage(payload.usage);
      } else if (type === "message_stop") {
        terminal = true;
      } else if (type === "error") {
        throw providerPayloadError(payload);
      }
    } else {
      const type = stringField(payload, "type") ?? event.event;
      if (type === "response.created" || type === "response.in_progress") {
        const response = plainObject(payload.response) ? payload.response : null;
        protocolVerified = protocolVerified || response !== null;
        const actualModel = response ? stringField(response, "model") : null;
        modelVerified = modelVerified || actualModel === requestedModelId;
      } else if (type === "response.completed") {
        const response = plainObject(payload.response) ? payload.response : null;
        protocolVerified = response !== null;
        const actualModel = response ? stringField(response, "model") : null;
        modelVerified = actualModel === requestedModelId;
        usageVerified = validUsage(response?.usage);
        terminal = true;
      } else if (type === "error" || type === "response.failed") {
        throw providerPayloadError(payload);
      }
    }
  }

  if (!protocolVerified || !terminal) {
    throw new BackendProbeError("malformed-response", FIXED_FAILURE_MESSAGES["malformed-response"]);
  }
  if (!modelVerified) {
    throw new BackendProbeError("missing-model", FIXED_FAILURE_MESSAGES["missing-model"]);
  }
  const capabilities: ModelCapability[] = [
    {
      id: "streaming",
      state: "verified",
      provenance: "probe",
      detail: "A bounded streaming request completed using the expected protocol.",
    },
  ];
  if (usageVerified) {
    capabilities.push({
      id: "usage",
      state: "verified",
      provenance: "probe",
      detail: "The probe returned valid token usage fields.",
    });
  }
  return {
    protocolVerified: true,
    modelVerified: true,
    observedCapabilities: capabilities,
    contextWindowTokens: null,
    contextWindowProvenance: null,
    contextWindowDetail: null,
  };
}

function parseSseEvents(body: Buffer): Array<{ event: string | null; data: string }> {
  const text = body.toString("utf8").replace(/\r\n/gu, "\n");
  const events: Array<{ event: string | null; data: string }> = [];
  for (const block of text.split(/\n\n+/u)) {
    if (!block.trim()) continue;
    let event: string | null = null;
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) event = line.slice(6).trim().slice(0, 100);
      if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (data.length > 0) events.push({ event, data: data.join("\n") });
  }
  if (events.length === 0 || events.length > 1_024) {
    throw new BackendProbeError("malformed-response", FIXED_FAILURE_MESSAGES["malformed-response"]);
  }
  return events;
}

function statusError(
  statusCode: number,
  headers: HttpResponse["headers"],
  body: Buffer,
): BackendProbeError {
  if (statusCode === 401 || statusCode === 403) {
    return new BackendProbeError("invalid-credentials", FIXED_FAILURE_MESSAGES["invalid-credentials"]);
  }
  if (statusCode === 429) {
    return new BackendProbeError(
      "rate-limited",
      FIXED_FAILURE_MESSAGES["rate-limited"],
      retryAfterSeconds(headers["retry-after"]),
    );
  }
  if (statusCode === 413) {
    return new BackendProbeError(
      "response-too-large",
      FIXED_FAILURE_MESSAGES["response-too-large"],
    );
  }
  if (statusCode >= 500) {
    return new BackendProbeError("server-error", FIXED_FAILURE_MESSAGES["server-error"]);
  }
  const error = safeProviderError(body);
  if (
    error.code === "model_not_found"
    || error.param === "model"
    || /model/u.test(error.type)
  ) {
    return new BackendProbeError("missing-model", FIXED_FAILURE_MESSAGES["missing-model"]);
  }
  return new BackendProbeError("unsupported-protocol", FIXED_FAILURE_MESSAGES["unsupported-protocol"]);
}

function providerPayloadError(payload: Record<string, unknown>): BackendProbeError {
  const candidate = plainObject(payload.error) ? payload.error : payload;
  const code = stringField(candidate, "code");
  const type = stringField(candidate, "type");
  if (code === "model_not_found" || /model/u.test(type ?? "")) {
    return new BackendProbeError("missing-model", FIXED_FAILURE_MESSAGES["missing-model"]);
  }
  return new BackendProbeError("server-error", FIXED_FAILURE_MESSAGES["server-error"]);
}

function safeProviderError(body: Buffer): { code: string; type: string; param: string } {
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    const root = plainObject(parsed) && plainObject(parsed.error) ? parsed.error : parsed;
    return plainObject(root)
      ? {
          code: stringField(root, "code") ?? "",
          type: stringField(root, "type") ?? "",
          param: stringField(root, "param") ?? "",
        }
      : { code: "", type: "", param: "" };
  } catch {
    return { code: "", type: "", param: "" };
  }
}

function resultForObservation(
  request: BackendCompatibilityProbeRequest,
  observation: ProbeObservation,
  checkedAt: string,
): BackendCompatibilityProbeResult {
  const hints = new Map(request.capabilityHints.map((capability) => [capability.id, capability]));
  for (const observed of observation.observedCapabilities) hints.set(observed.id, observed);
  const capabilities: BackendProbeCapabilityEvidence[] = MODEL_CAPABILITY_IDS.map((id) => {
    const evidence = hints.get(id) ?? unknownCapability(id);
    return { ...evidence, checkedAt };
  });
  const contextWindow = contextEvidence(request, observation, checkedAt);
  const unknownCapabilities = capabilities.some((capability) => (
    capability.state === "unknown" || capability.state === "user-declared"
  ));
  return backendCompatibilityProbeResultSchema.parse({
    profileId: request.profile.id,
    backendConfigurationRevision: request.profile.configurationRevision,
    endpointIdentity: request.profile.endpointIdentity,
    protocol: request.profile.protocol,
    modelId: request.modelId,
    compatibility: unknownCapabilities ? "partially-compatible" : "protocol-compatible",
    protocolVerified: observation.protocolVerified,
    modelVerified: observation.modelVerified,
    capabilities,
    contextWindow,
    failure: null,
    checkedAt,
  });
}

function resultForFailure(
  request: BackendCompatibilityProbeRequest,
  failure: BackendProbeError,
  checkedAt: string,
): BackendCompatibilityProbeResult {
  const hints = new Map(request.capabilityHints.map((capability) => [capability.id, capability]));
  const capabilities = MODEL_CAPABILITY_IDS.map((id): BackendProbeCapabilityEvidence => ({
    ...(hints.get(id) ?? unknownCapability(id)),
    checkedAt,
  }));
  return backendCompatibilityProbeResultSchema.parse({
    profileId: request.profile.id,
    backendConfigurationRevision: request.profile.configurationRevision,
    endpointIdentity: request.profile.endpointIdentity,
    protocol: request.profile.protocol,
    modelId: request.modelId,
    compatibility: "unavailable",
    protocolVerified: false,
    modelVerified: false,
    capabilities,
    contextWindow: contextEvidence(request, {
      protocolVerified: false,
      modelVerified: false,
      observedCapabilities: [],
      contextWindowTokens: null,
      contextWindowProvenance: null,
      contextWindowDetail: null,
    }, checkedAt),
    failure: {
      code: failure.code,
      message: FIXED_FAILURE_MESSAGES[failure.code],
      retryAfterSeconds: failure.retryAfterSeconds,
    } satisfies BackendProbeFailure,
    checkedAt,
  });
}

function contextEvidence(
  request: BackendCompatibilityProbeRequest,
  observation: ProbeObservation,
  checkedAt: string,
): BackendProbeContextEvidence {
  if (observation.contextWindowTokens !== null) {
    return {
      tokens: observation.contextWindowTokens,
      state: "verified",
      provenance: observation.contextWindowProvenance ?? "probe",
      detail: observation.contextWindowDetail,
      checkedAt,
    };
  }
  if (request.contextWindowHint) {
    return {
      tokens: request.contextWindowHint.tokens,
      state: request.contextWindowHint.provenance === "user" ? "user-declared" : "partially-compatible",
      provenance: request.contextWindowHint.provenance,
      detail: request.contextWindowHint.detail,
      checkedAt,
    };
  }
  return {
    tokens: null,
    state: "unknown",
    provenance: "unknown",
    detail: null,
    checkedAt,
  };
}

function validateNativeCapabilities(capabilities: unknown): readonly ModelCapability[] {
  if (!Array.isArray(capabilities)) {
    throw new BackendProbeError("malformed-response", FIXED_FAILURE_MESSAGES["malformed-response"]);
  }
  if (capabilities.length > MAX_NATIVE_CAPABILITIES) {
    throw new BackendProbeError("malformed-response", FIXED_FAILURE_MESSAGES["malformed-response"]);
  }
  const ids = new Set<ModelCapabilityId>();
  return capabilities.map((input) => {
    const parsed = modelCapabilitySchema.safeParse(input);
    if (!parsed.success) {
      throw new BackendProbeError("malformed-response", FIXED_FAILURE_MESSAGES["malformed-response"]);
    }
    const capability = parsed.data;
    if (ids.has(capability.id) || capability.provenance === "probe") {
      throw new BackendProbeError("malformed-response", FIXED_FAILURE_MESSAGES["malformed-response"]);
    }
    ids.add(capability.id);
    return capability;
  });
}

/**
 * Adapter for authoritative native model catalogs (OpenCode provider.list,
 * Cursor ACP model config options). Catalog loading remains owned by the
 * native harness; this adapter only validates and projects bounded evidence.
 */
export function nativeModelCatalogProbeAdapter(
  loadModels: (
    signal: AbortSignal,
  ) => Promise<readonly {
    id: string;
    capabilities?: readonly ModelCapability[];
    contextWindowTokens?: number | null;
  }[]>,
): NativeBackendProbeAdapter {
  return {
    async probe(input, signal) {
      const models = await abortable(loadModels(signal), signal);
      throwIfAborted(signal);
      if (!Array.isArray(models)) {
        throw new BackendProbeError("malformed-response", FIXED_FAILURE_MESSAGES["malformed-response"]);
      }
      if (models.length > MAX_NATIVE_MODELS) {
        throw new BackendProbeError("malformed-response", FIXED_FAILURE_MESSAGES["malformed-response"]);
      }
      const selected = models.find((model) => (
        plainObject(model) && model.id === input.modelId
      ));
      if (!selected) {
        return { protocolVerified: true, modelVerified: false };
      }
      if (
        !plainObject(selected)
        || typeof selected.id !== "string"
        || selected.id.length === 0
        || selected.id.length > 500
        || /[\0\r\n]/u.test(selected.id)
      ) {
        throw new BackendProbeError("malformed-response", FIXED_FAILURE_MESSAGES["malformed-response"]);
      }
      if (
        selected.contextWindowTokens !== undefined
        && selected.contextWindowTokens !== null
        && typeof selected.contextWindowTokens !== "number"
      ) {
        throw new BackendProbeError("malformed-response", FIXED_FAILURE_MESSAGES["malformed-response"]);
      }
      return {
        protocolVerified: true,
        modelVerified: true,
        capabilities: validateNativeCapabilities(selected.capabilities ?? []),
        contextWindowTokens: typeof selected.contextWindowTokens === "number"
          ? selected.contextWindowTokens
          : null,
        contextWindowProvenance: selected.contextWindowTokens == null ? null : "provider",
      };
    },
  };
}

function normalizeProbeError(
  error: unknown,
  timedOut: boolean,
  externallyAborted: boolean,
): BackendProbeError {
  if (timedOut) return new BackendProbeError("timeout", FIXED_FAILURE_MESSAGES.timeout);
  if (externallyAborted) return new BackendProbeError("cancelled", FIXED_FAILURE_MESSAGES.cancelled);
  if (error instanceof BackendProbeError) return error;
  return new BackendProbeError("unreachable", FIXED_FAILURE_MESSAGES.unreachable);
}

function validContextProvenance(value: unknown): ModelCapabilityProvenance {
  if (value === undefined || value === null) return "provider";
  if (
    value === "provider"
    || value === "harness"
    || value === "probe"
    || value === "user"
    || value === "built-in"
  ) return value;
  throw new BackendProbeError("malformed-response", FIXED_FAILURE_MESSAGES["malformed-response"]);
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new BackendProbeError("cancelled", FIXED_FAILURE_MESSAGES.cancelled));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(new BackendProbeError("cancelled", FIXED_FAILURE_MESSAGES.cancelled));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function unknownCapability(id: ModelCapabilityId): ModelCapability {
  return { id, state: "unknown", provenance: "unknown", detail: null };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new BackendProbeError("cancelled", FIXED_FAILURE_MESSAGES.cancelled);
  }
}

function isLiteralLocalhost(hostname: string): boolean {
  const normalized = stripIpv6Brackets(hostname).toLowerCase();
  if (normalized === "localhost" || normalized === "::1") return true;
  if (isIP(normalized) !== 4) return false;
  return normalized.split(".")[0] === "127";
}

function isLoopbackAddress(address: string, family: 4 | 6): boolean {
  if (family === 4) return address.split(".")[0] === "127";
  return address === "::1" || address.toLowerCase() === "0:0:0:0:0:0:0:1";
}

function isBlockedAddress(address: string, family: 4 | 6): boolean {
  return BLOCKED_ADDRESSES.check(address, family === 4 ? "ipv4" : "ipv6");
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function retryAfterSeconds(value: string | readonly string[] | undefined): number | null {
  const first = firstHeader(value);
  const seconds = Number(first);
  return Number.isInteger(seconds) && seconds >= 0 && seconds <= 86_400 ? seconds : null;
}

function firstHeader(value: string | readonly string[] | undefined): string {
  return typeof value === "string" ? value : value?.[0] ?? "";
}

function validUsage(value: unknown): boolean {
  if (!plainObject(value)) return false;
  const fields = [
    value.input_tokens,
    value.output_tokens,
    value.total_tokens,
    value.inputTokens,
    value.outputTokens,
    value.totalTokens,
  ].filter((candidate) => candidate !== undefined);
  return fields.length > 0 && fields.every(
    (candidate) => typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0,
  );
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, key: string): string | null {
  const field = value[key];
  return typeof field === "string" && field.length > 0 && field.length <= 500
    ? field
    : null;
}

function boundedDetail(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/gu, " ").slice(0, 1_000);
  return normalized || null;
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}
