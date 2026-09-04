const SCHEMA_VERSION = 1;
const MAX_PATH_BYTES = 4 * 1_024;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const RUNTIME_GENERATION_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:[1-9][0-9]{0,9}$/iu;
const SYSTEM_BOOT_PATTERN = /^(?:(?:linux|darwin):[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|win32:[0-9a-f]{8}|test:[0-9a-f-]{36}|unavailable)$/u;

export const APP_UPDATE_CANDIDATE_VIABILITY_CODES = Object.freeze([
  "database-incompatible",
  "invalid-request",
  "recovery-storage-invalid",
  "validation-failed",
] as const);

export type AppUpdateCandidateViabilityCode =
  (typeof APP_UPDATE_CANDIDATE_VIABILITY_CODES)[number];

export interface AppUpdateCandidateViabilityRequest {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly operationId: string;
  readonly dataDirectory: string;
  readonly expectedActiveRuntimeOwner:
    AppUpdateCandidateExpectedRuntimeOwner | null;
}

export interface AppUpdateCandidateExpectedRuntimeOwner {
  readonly runtimeGenerationId: string;
  readonly systemBootId: string;
}

export interface AppUpdateCandidateViabilityResult {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly operationId: string;
  readonly status: "validated" | "rejected";
  readonly code: AppUpdateCandidateViabilityCode | null;
}

export interface AppUpdateCandidateViabilityResultAck {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly operationId: string;
  readonly type: "result-ack";
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  return keys.length === expectedKeys.length
    && keys.every((key, index) => key === expectedKeys[index]);
}

function boundedAbsolutePath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value === value.trim()
    && !value.includes("\0")
    && Buffer.byteLength(value, "utf8") <= MAX_PATH_BYTES
    && (
      value.startsWith("/")
      || /^[A-Za-z]:[\\/]/u.test(value)
      || value.startsWith("\\\\")
    );
}

function validOperationId(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function validCode(value: unknown): value is AppUpdateCandidateViabilityCode {
  return typeof value === "string"
    && APP_UPDATE_CANDIDATE_VIABILITY_CODES.some((code) => code === value);
}

export function appUpdateCandidateViabilityRequest(options: {
  readonly operationId: string;
  readonly dataDirectory: string;
  readonly expectedActiveRuntimeOwner?:
    AppUpdateCandidateExpectedRuntimeOwner | null;
}): AppUpdateCandidateViabilityRequest {
  const request: AppUpdateCandidateViabilityRequest = {
    schemaVersion: SCHEMA_VERSION,
    operationId: options.operationId,
    dataDirectory: options.dataDirectory,
    expectedActiveRuntimeOwner: options.expectedActiveRuntimeOwner ?? null,
  };
  const parsed = parseAppUpdateCandidateViabilityRequest(request);
  if (!parsed) throw new Error("The app update viability request is invalid.");
  return Object.freeze(parsed);
}

export function parseAppUpdateCandidateViabilityRequest(
  value: unknown,
): AppUpdateCandidateViabilityRequest | null {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || !exactKeys(value, [
      "dataDirectory",
      "expectedActiveRuntimeOwner",
      "operationId",
      "schemaVersion",
    ])
  ) return null;
  const request = value as Partial<AppUpdateCandidateViabilityRequest>;
  const owner = request.expectedActiveRuntimeOwner;
  const validOwner = owner === null || (
    !!owner
    && typeof owner === "object"
    && !Array.isArray(owner)
    && exactKeys(owner, ["runtimeGenerationId", "systemBootId"])
    && RUNTIME_GENERATION_PATTERN.test(owner.runtimeGenerationId)
    && SYSTEM_BOOT_PATTERN.test(owner.systemBootId)
  );
  return request.schemaVersion === SCHEMA_VERSION
    && validOperationId(request.operationId)
    && boundedAbsolutePath(request.dataDirectory)
    && validOwner
    ? request as AppUpdateCandidateViabilityRequest
    : null;
}

export function appUpdateCandidateViabilityResult(options: {
  readonly operationId: string;
  readonly status: "validated" | "rejected";
  readonly code?: AppUpdateCandidateViabilityCode | null;
}): AppUpdateCandidateViabilityResult {
  const result: AppUpdateCandidateViabilityResult = {
    schemaVersion: SCHEMA_VERSION,
    operationId: options.operationId,
    status: options.status,
    code: options.status === "validated" ? null : options.code ?? "validation-failed",
  };
  const parsed = parseAppUpdateCandidateViabilityResult(result);
  if (!parsed) throw new Error("The app update viability result is invalid.");
  return Object.freeze(parsed);
}

export function appUpdateCandidateViabilityResultAck(
  operationId: string,
): AppUpdateCandidateViabilityResultAck {
  const acknowledgement: AppUpdateCandidateViabilityResultAck = {
    schemaVersion: SCHEMA_VERSION,
    operationId,
    type: "result-ack",
  };
  if (!parseAppUpdateCandidateViabilityResultAck(acknowledgement)) {
    throw new Error("The app update viability acknowledgement is invalid.");
  }
  return Object.freeze(acknowledgement);
}

export function parseAppUpdateCandidateViabilityResult(
  value: unknown,
): AppUpdateCandidateViabilityResult | null {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || !exactKeys(value, ["code", "operationId", "schemaVersion", "status"])
  ) return null;
  const result = value as Partial<AppUpdateCandidateViabilityResult>;
  if (
    result.schemaVersion !== SCHEMA_VERSION
    || !validOperationId(result.operationId)
    || (result.status !== "validated" && result.status !== "rejected")
  ) return null;
  if (
    (result.status === "validated" && result.code !== null)
    || (result.status === "rejected" && !validCode(result.code))
  ) return null;
  return result as AppUpdateCandidateViabilityResult;
}

export function parseAppUpdateCandidateViabilityResultAck(
  value: unknown,
): AppUpdateCandidateViabilityResultAck | null {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || !exactKeys(value, ["operationId", "schemaVersion", "type"])
  ) return null;
  const acknowledgement = value as Partial<
    AppUpdateCandidateViabilityResultAck
  >;
  return acknowledgement.schemaVersion === SCHEMA_VERSION
    && validOperationId(acknowledgement.operationId)
    && acknowledgement.type === "result-ack"
    ? acknowledgement as AppUpdateCandidateViabilityResultAck
    : null;
}
