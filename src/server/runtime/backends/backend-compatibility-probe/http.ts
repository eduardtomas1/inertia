import { lookup as dnsLookup } from "node:dns/promises";
import { randomBytes } from "node:crypto";
import { request as httpRequest, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";

import type { BackendCompatibilityProbeRequest } from "../../../../shared/backend-probe";
import { isBackendCredentialSecret } from "../../../../shared/backend-credentials";
import type {
  ModelBackendProtocol,
  ModelCapability,
} from "../../../../shared/model-routing";
import {
  abortable,
  BackendProbeError,
  FIXED_FAILURE_MESSAGES,
  plainObject,
  stringField,
  throwIfAborted,
  type BackendCompatibilityProbeDependencies,
  type BackendProbeResolvedAddress,
  type HttpBackendProtocol,
  type ProbeObservation,
} from "./core";

const MAX_REQUEST_BYTES = 16 * 1024;

interface HttpResponse {
  statusCode: number;
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  body: Buffer;
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
  ["::", 96],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 32],
  ["2002::", 16],
  ["2001:db8::", 32],
  ["fec0::", 10],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  BLOCKED_ADDRESSES.addSubnet(network, prefix, "ipv6");
}

export async function probeHttpBackend(
  request: BackendCompatibilityProbeRequest,
  dependencies: BackendCompatibilityProbeDependencies,
  signal: AbortSignal,
  maxResponseBytes: number,
  externalSignal?: AbortSignal,
): Promise<ProbeObservation> {
  if (request.endpointUrl === null) {
    throw new BackendProbeError("invalid-url", FIXED_FAILURE_MESSAGES["invalid-url"]);
  }

  let secret: string | null = null;
  let headers: Record<string, string> | null = null;
  let toolHeaders: Record<string, string> | null = null;
  let continuationHeaders: Record<string, string> | null = null;
  try {
    const { baseUrl, resolved } = await validateBackendEndpointNetworkPolicy(
      request.endpointUrl,
      request.allowInsecureLocalhost,
      signal,
      dependencies.resolveAddresses ?? resolveAddresses,
    );
    const endpoint = apiEndpoint(baseUrl, request.profile.protocol);
    secret = await resolveProbeCredential(request, dependencies, signal);
    throwIfAborted(signal);
    const body = probeBody(request.profile.protocol, request.modelId);
    headers = probeHeaders(
      request.profile.protocol,
      request.profile.authenticationMode,
      secret,
    );
    toolHeaders = request.profile.protocol === "openai-responses"
      ? probeHeaders(
          request.profile.protocol,
          request.profile.authenticationMode,
          secret,
        )
      : null;
    continuationHeaders = request.profile.protocol === "openai-responses"
      ? probeHeaders(
          request.profile.protocol,
          request.profile.authenticationMode,
          secret,
        )
      : null;
    secret = null;
    const response = await boundedRequest(
      endpoint,
      resolved,
      body,
      headers,
      signal,
      maxResponseBytes,
    );
    assertSuccessfulResponse(response);
    const observation = parseStreamingResponse(
      request.profile.protocol as HttpBackendProtocol,
      request.modelId,
      response.headers,
      response.body,
    );
    if (
      request.profile.protocol !== "openai-responses"
      || toolHeaders === null
      || continuationHeaders === null
    ) {
      return observation;
    }

    // Responses text compatibility remains independently useful. Tool
    // authority requires both an exact inert call and acceptance of its inert
    // result in a bounded follow-up. Nothing on the host is ever executed.
    try {
      const challenge = toolProbeChallenge();
      const toolResponse = await boundedRequest(
        endpoint,
        resolved,
        toolProbeBody(request.modelId, challenge),
        toolHeaders,
        signal,
        maxResponseBytes,
      );
      assertSuccessfulResponse(toolResponse);
      const call = parseInertToolResponse(
        request.modelId,
        challenge,
        toolResponse.headers,
        toolResponse.body,
      );
      const continuationResponse = await boundedRequest(
        endpoint,
        resolved,
        toolContinuationProbeBody(request.modelId, challenge, call),
        continuationHeaders,
        signal,
        maxResponseBytes,
      );
      assertSuccessfulResponse(continuationResponse);
      parseToolContinuationResponse(
        request.modelId,
        challenge,
        continuationResponse.headers,
        continuationResponse.body,
      );
      return {
        ...observation,
        observedCapabilities: [
          ...observation.observedCapabilities,
          {
            id: "tools",
            state: "verified",
            provenance: "probe",
            detail: "A bounded Responses call/result continuation completed the exact inert challenge.",
          },
        ],
      };
    } catch {
      // User cancellation still cancels the full probe. A tool-incompatible
      // backend, including a bounded tool-check timeout, remains an honest
      // text-only result and cannot unlock custom Codex admission.
      if (externalSignal?.aborted) throwIfAborted(signal);
      return observation;
    }
  } finally {
    secret = null;
    if (headers) scrubHeaders(headers);
    if (toolHeaders) scrubHeaders(toolHeaders);
    if (continuationHeaders) scrubHeaders(continuationHeaders);
  }
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

/**
 * Revalidate a custom endpoint immediately before privileged probe or launch
 * work. Probe sockets additionally pin `resolved`; external provider CLIs may
 * resolve the hostname again, so this is an admission check rather than a DNS
 * pinning claim. Their TLS stack remains responsible for hostname binding.
 */
export async function validateBackendEndpointNetworkPolicy(
  endpointUrl: string,
  allowInsecureLocalhost: boolean,
  signal: AbortSignal,
  resolver: NonNullable<BackendCompatibilityProbeDependencies["resolveAddresses"]> = resolveAddresses,
): Promise<{ baseUrl: URL; resolved: BackendProbeResolvedAddress }> {
  const baseUrl = validateEndpointUrl(endpointUrl, allowInsecureLocalhost);
  const resolved = await resolveAndValidateAddress(
    baseUrl,
    allowInsecureLocalhost,
    resolver,
    signal,
  );
  return { baseUrl, resolved };
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

interface ToolProbeChallenge {
  name: string;
  nonce: string;
  resultNonce: string;
}

interface InertToolCall {
  callId: string;
  name: string;
  arguments: string;
}

function toolProbeChallenge(): ToolProbeChallenge {
  const suffix = randomBytes(12).toString("hex");
  return {
    name: `inertia_capability_probe_${suffix}`,
    nonce: randomBytes(16).toString("hex"),
    resultNonce: randomBytes(16).toString("hex"),
  };
}

function toolProbeBody(modelId: string, challenge: ToolProbeChallenge): Buffer {
  const value = {
    model: modelId,
    input: `Call ${challenge.name} exactly once with the required nonce. Do not answer with text.`,
    max_output_tokens: 64,
    store: false,
    stream: true,
    parallel_tool_calls: false,
    tools: [toolProbeDefinition(challenge)],
    tool_choice: { type: "function", name: challenge.name },
  };
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.byteLength > MAX_REQUEST_BYTES) {
    throw new BackendProbeError("malformed-response", FIXED_FAILURE_MESSAGES["malformed-response"]);
  }
  return body;
}

function toolProbeDefinition(challenge: ToolProbeChallenge) {
  return {
    type: "function",
    name: challenge.name,
    description: "Inert compatibility check. The call is inspected but never executed.",
    parameters: {
      type: "object",
      properties: {
        nonce: { type: "string", enum: [challenge.nonce] },
      },
      required: ["nonce"],
      additionalProperties: false,
    },
    strict: true,
  } as const;
}

function toolContinuationProbeBody(
  modelId: string,
  challenge: ToolProbeChallenge,
  call: InertToolCall,
): Buffer {
  const value = {
    model: modelId,
    input: [
      {
        role: "user",
        content: "Repeat the inert function result exactly, with no other text.",
      },
      {
        type: "function_call",
        call_id: call.callId,
        name: call.name,
        arguments: call.arguments,
      },
      {
        type: "function_call_output",
        call_id: call.callId,
        output: challenge.resultNonce,
      },
    ],
    max_output_tokens: 64,
    store: false,
    stream: true,
    parallel_tool_calls: false,
    tools: [toolProbeDefinition(challenge)],
    tool_choice: "none",
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
  protocol: HttpBackendProtocol,
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

function parseInertToolResponse(
  requestedModelId: string,
  challenge: ToolProbeChallenge,
  headers: HttpResponse["headers"],
  body: Buffer,
): InertToolCall {
  // This also proves an exact terminal Responses stream and model identity.
  parseStreamingResponse("openai-responses", requestedModelId, headers, body);
  const calls = new Map<string, { name: string; arguments: string }>();
  for (const event of parseSseEvents(body)) {
    if (event.data === "[DONE]") continue;
    let payload: unknown;
    try {
      payload = JSON.parse(event.data);
    } catch {
      throw new BackendProbeError("malformed-response", FIXED_FAILURE_MESSAGES["malformed-response"]);
    }
    if (!plainObject(payload)) {
      throw new BackendProbeError("malformed-response", FIXED_FAILURE_MESSAGES["malformed-response"]);
    }
    const type = stringField(payload, "type") ?? event.event;
    if (type === "response.output_item.added") {
      assertExpectedFunctionName(payload.item, challenge.name);
    } else if (type === "response.output_item.done") {
      collectFinalFunctionCall(calls, payload.item, challenge.name);
    } else if (type === "response.completed") {
      const response = plainObject(payload.response) ? payload.response : null;
      if (!response || !Array.isArray(response.output)) {
        throw new BackendProbeError("malformed-response", FIXED_FAILURE_MESSAGES["malformed-response"]);
      }
      for (const item of response.output) {
        if (plainObject(item) && item.type === "function_call") {
          collectFinalFunctionCall(calls, item, challenge.name);
        }
      }
    }
  }
  if (calls.size !== 1) {
    throw new BackendProbeError("malformed-response", FIXED_FAILURE_MESSAGES["malformed-response"]);
  }
  const [callId, call] = [...calls.entries()][0]!;
  let argumentsValue: unknown;
  try {
    argumentsValue = JSON.parse(call.arguments);
  } catch {
    throw new BackendProbeError("malformed-response", FIXED_FAILURE_MESSAGES["malformed-response"]);
  }
  if (
    !plainObject(argumentsValue)
    || Object.keys(argumentsValue).length !== 1
    || argumentsValue.nonce !== challenge.nonce
  ) {
    throw new BackendProbeError("malformed-response", FIXED_FAILURE_MESSAGES["malformed-response"]);
  }
  return { callId, ...call };
}

function parseToolContinuationResponse(
  requestedModelId: string,
  challenge: ToolProbeChallenge,
  headers: HttpResponse["headers"],
  body: Buffer,
): void {
  parseStreamingResponse("openai-responses", requestedModelId, headers, body);
  let deltaText = "";
  let completedText: string | null = null;
  for (const event of parseSseEvents(body)) {
    if (event.data === "[DONE]") continue;
    let payload: unknown;
    try {
      payload = JSON.parse(event.data);
    } catch {
      throw new BackendProbeError("malformed-response", FIXED_FAILURE_MESSAGES["malformed-response"]);
    }
    if (!plainObject(payload)) {
      throw new BackendProbeError("malformed-response", FIXED_FAILURE_MESSAGES["malformed-response"]);
    }
    const type = stringField(payload, "type") ?? event.event;
    if (type === "response.output_item.added" || type === "response.output_item.done") {
      const item = plainObject(payload.item) ? payload.item : null;
      if (item?.type === "function_call") {
        throw new BackendProbeError("malformed-response", FIXED_FAILURE_MESSAGES["malformed-response"]);
      }
    }
    if (type === "response.output_text.delta") {
      const delta = stringField(payload, "delta");
      if (delta === null || deltaText.length + delta.length > MAX_REQUEST_BYTES) {
        throw new BackendProbeError("malformed-response", FIXED_FAILURE_MESSAGES["malformed-response"]);
      }
      deltaText += delta;
    } else if (type === "response.completed") {
      const response = plainObject(payload.response) ? payload.response : null;
      if (!response || !Array.isArray(response.output)) {
        throw new BackendProbeError("malformed-response", FIXED_FAILURE_MESSAGES["malformed-response"]);
      }
      const parts: string[] = [];
      for (const item of response.output) {
        if (plainObject(item) && item.type === "function_call") {
          throw new BackendProbeError("malformed-response", FIXED_FAILURE_MESSAGES["malformed-response"]);
        }
        if (!plainObject(item) || item.type !== "message" || !Array.isArray(item.content)) continue;
        for (const content of item.content) {
          if (!plainObject(content) || content.type !== "output_text") continue;
          const text = stringField(content, "text");
          if (text === null) {
            throw new BackendProbeError("malformed-response", FIXED_FAILURE_MESSAGES["malformed-response"]);
          }
          parts.push(text);
        }
      }
      completedText = parts.join("");
    }
  }
  const exactText = completedText && completedText.length > 0
    ? completedText
    : deltaText;
  if (
    exactText !== challenge.resultNonce
    || (deltaText.length > 0 && deltaText !== challenge.resultNonce)
  ) {
    throw new BackendProbeError("malformed-response", FIXED_FAILURE_MESSAGES["malformed-response"]);
  }
}

function assertExpectedFunctionName(item: unknown, expectedName: string): void {
  if (!plainObject(item) || item.type !== "function_call") return;
  if (stringField(item, "name") !== expectedName) {
    throw new BackendProbeError("malformed-response", FIXED_FAILURE_MESSAGES["malformed-response"]);
  }
}

function collectFinalFunctionCall(
  calls: Map<string, { name: string; arguments: string }>,
  item: unknown,
  expectedName: string,
): void {
  if (!plainObject(item) || item.type !== "function_call") return;
  const name = stringField(item, "name");
  const callId = stringField(item, "call_id") ?? stringField(item, "id");
  const argumentsValue = stringField(item, "arguments");
  if (
    name !== expectedName
    || !callId
    || callId.length > 500
    || argumentsValue === null
    || argumentsValue.length > MAX_REQUEST_BYTES
  ) {
    throw new BackendProbeError("malformed-response", FIXED_FAILURE_MESSAGES["malformed-response"]);
  }
  const previous = calls.get(callId);
  if (previous && (previous.name !== name || previous.arguments !== argumentsValue)) {
    throw new BackendProbeError("malformed-response", FIXED_FAILURE_MESSAGES["malformed-response"]);
  }
  calls.set(callId, { name, arguments: argumentsValue });
}

function assertSuccessfulResponse(response: HttpResponse): void {
  if (response.statusCode >= 300 && response.statusCode < 400) {
    throw new BackendProbeError("unsafe-redirect", FIXED_FAILURE_MESSAGES["unsafe-redirect"]);
  }
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw statusError(response.statusCode, response.headers, response.body);
  }
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
