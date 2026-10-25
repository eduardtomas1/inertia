import type { BackendAuthenticationMode } from "../../../../shared/model-routing";
import {
  MAX_DISCOVERED_BACKEND_MODELS,
  type BackendDiscoveredModel,
} from "../../../../shared/backend-profile-settings";
import {
  BackendProbeError,
  clampInteger,
  FIXED_FAILURE_MESSAGES,
  MAX_TIMEOUT_MS,
  normalizeProbeError,
  plainObject,
  throwIfAborted,
  type BackendCompatibilityProbeDependencies,
  type HttpBackendProtocol,
} from "./core";
import {
  assertSuccessfulResponse,
  boundedRequest,
  resolveAddresses,
  resolveProbeCredential,
  scrubHeaders,
  validateBackendEndpointNetworkPolicy,
} from "./http";

export const DEFAULT_DISCOVERY_TIMEOUT_MS = 15_000;
export const MAX_DISCOVERY_RESPONSE_BYTES = 4 * 1024 * 1024;
const LABEL_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/gu;
const ID_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const LABEL_INVISIBLE_CHARACTERS = /[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/gu;
const ID_INVISIBLE_CHARACTERS = /[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/u;

export interface BackendModelDiscoveryRequest {
  protocol: HttpBackendProtocol;
  authenticationMode: BackendAuthenticationMode;
  endpointUrl: string;
  secretReference: string | null;
  allowInsecureLocalhost: boolean;
  allowPrivateNetwork: boolean;
}

export type BackendModelDiscoveryDependencies = Pick<
  BackendCompatibilityProbeDependencies,
  "resolveCredential" | "resolveAddresses" | "timeoutMs" | "maxResponseBytes"
>;

const DISCOVERY_FAILURE_MESSAGES: Readonly<Partial<Record<BackendProbeError["code"], string>>> = {
  "missing-model": "This backend does not offer a model list. Enter the model IDs yourself.",
  "unsupported-protocol": "This backend does not offer a model list. Enter the model IDs yourself.",
  "malformed-response": "The backend returned a model list Inertia could not read.",
  "response-too-large": "The backend's model list is too large to load.",
  timeout: "The backend did not return its model list in time.",
  cancelled: "Loading the model list was cancelled.",
};

export async function discoverHttpBackendModels(
  request: BackendModelDiscoveryRequest,
  dependencies: BackendModelDiscoveryDependencies = {},
  externalSignal?: AbortSignal,
): Promise<BackendDiscoveredModel[]> {
  const timeoutMs = clampInteger(
    dependencies.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS,
    1,
    MAX_TIMEOUT_MS,
  );
  const maxResponseBytes = clampInteger(
    dependencies.maxResponseBytes ?? MAX_DISCOVERY_RESPONSE_BYTES,
    1,
    MAX_DISCOVERY_RESPONSE_BYTES,
  );
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer.unref();
  const onExternalAbort = (): void => controller.abort();
  if (externalSignal?.aborted) controller.abort();
  else externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  const signal = controller.signal;
  let secret: string | null = null;
  let headers: Record<string, string> | null = null;
  try {
    throwIfAborted(signal);
    const { baseUrl, resolved } = await validateBackendEndpointNetworkPolicy(
      request.endpointUrl,
      {
        allowInsecureLocalhost: request.allowInsecureLocalhost,
        allowPrivateNetwork: request.allowPrivateNetwork,
      },
      signal,
      dependencies.resolveAddresses ?? resolveAddresses,
    );
    const endpoint = modelsEndpoint(baseUrl, request.protocol);
    secret = await resolveProbeCredential(
      request.authenticationMode,
      request.secretReference,
      dependencies,
      signal,
    );
    throwIfAborted(signal);
    headers = discoveryHeaders(request.protocol, request.authenticationMode, secret);
    secret = null;
    const response = await boundedRequest(
      endpoint,
      resolved,
      null,
      headers,
      signal,
      maxResponseBytes,
    );
    assertSuccessfulResponse(response);
    return parseDiscoveredModels(response.body);
  } catch (error) {
    const normalized = normalizeProbeError(error, timedOut, externalSignal?.aborted === true);
    throw new BackendProbeError(
      normalized.code,
      DISCOVERY_FAILURE_MESSAGES[normalized.code] ?? FIXED_FAILURE_MESSAGES[normalized.code],
      normalized.retryAfterSeconds,
    );
  } finally {
    secret = null;
    if (headers) scrubHeaders(headers);
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

function modelsEndpoint(baseUrl: URL, protocol: HttpBackendProtocol): URL {
  const endpoint = new URL(baseUrl.toString());
  const segments = endpoint.pathname.split("/").filter(Boolean);
  const tail = segments.at(-1);
  const base = segments.at(-2) === "v1" && (tail === "messages" || tail === "responses")
    ? segments.slice(0, -1)
    : tail === "v1"
      ? segments
      : [...segments, "v1"];
  endpoint.pathname = `/${[...base, "models"].join("/")}`;
  endpoint.search = protocol === "anthropic-messages" ? "?limit=1000" : "";
  endpoint.hash = "";
  return endpoint;
}

function discoveryHeaders(
  protocol: HttpBackendProtocol,
  authenticationMode: BackendAuthenticationMode,
  secret: string | null,
): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/json" };
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

function discoveredLabel(value: string): string {
  return value
    .replace(LABEL_INVISIBLE_CHARACTERS, "")
    .replace(LABEL_CONTROL_CHARACTERS, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 200)
    .trim();
}

function parseDiscoveredModels(body: Buffer): BackendDiscoveredModel[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw new BackendProbeError("malformed-response", FIXED_FAILURE_MESSAGES["malformed-response"]);
  }
  if (!plainObject(parsed) || !Array.isArray(parsed.data)) {
    throw new BackendProbeError("malformed-response", FIXED_FAILURE_MESSAGES["malformed-response"]);
  }
  const models: BackendDiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const entry of parsed.data) {
    if (models.length >= MAX_DISCOVERED_BACKEND_MODELS) break;
    if (!plainObject(entry) || typeof entry.id !== "string") continue;
    const id = entry.id.trim();
    if (
      id.length === 0
      || id.length > 500
      || ID_CONTROL_CHARACTERS.test(id)
      || ID_INVISIBLE_CHARACTERS.test(id)
      || seen.has(id)
    ) continue;
    const named = typeof entry.display_name === "string"
      ? discoveredLabel(entry.display_name)
      : "";
    seen.add(id);
    models.push({ id, displayName: named || discoveredLabel(id) });
  }
  return models;
}
