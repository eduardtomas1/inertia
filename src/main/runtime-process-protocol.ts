import { isAbsolute } from "node:path";
import {
  parseOpenProjectPathRequest,
  type OpenProjectPathRequest,
} from "../shared/desktop";
import {
  isBackendCredentialGeneration,
  isBackendCredentialSecret,
  isBackendSecretReference,
} from "../shared/backend-credentials";
import {
  claudeCompatibleBackendProfileSchema,
  type ClaudeCompatibleBackendProfile,
} from "../shared/claude-backend-profiles";

export interface RuntimeWorkerOptions {
  dataDirectory: string;
  defaultWorkspacePath: string;
  enableProviders: boolean;
  /** Optional trusted desktop override; never accepted from the renderer. */
  codexBinaryPath?: string;
  /** Safe configuration only; credential values remain in the main-process vault. */
  kimiClaudeProfiles?: readonly ClaudeCompatibleBackendProfile[];
}

export type RuntimeWorkerCommand =
  | { type: "runtime.start"; options: RuntimeWorkerOptions }
  | { type: "runtime.shutdown" }
  | { type: "runtime.resolve-project-path"; requestId: string; request: OpenProjectPathRequest }
  | RuntimeCredentialResult;

export type RuntimeCredentialOperation = "resolve" | "status" | "clear" | "forget";
export type RuntimeCredentialFailureCode = "not-found" | "unavailable" | "invalid";

export type RuntimeCredentialResult =
  | {
      type: "runtime.credential-result";
      requestId: string;
      operation: "resolve";
      ok: true;
      secret: string;
    }
  | {
      type: "runtime.credential-result";
      requestId: string;
      operation: "status";
      ok: true;
      hasSecret: boolean;
      credentialGeneration: string | null;
    }
  | {
      type: "runtime.credential-result";
      requestId: string;
      operation: "clear" | "forget";
      ok: true;
      removed: boolean;
    }
  | {
      type: "runtime.credential-result";
      requestId: string;
      operation: RuntimeCredentialOperation;
      ok: false;
      code: RuntimeCredentialFailureCode;
      message: string;
    };

export type RuntimeWorkerEvent =
  | { type: "runtime.ready"; websocketUrl: string }
  | { type: "runtime.startup-failed"; message: string }
  | { type: "runtime.stopped" }
  | { type: "runtime.project-path-resolved"; requestId: string; path: string }
  | { type: "runtime.project-path-rejected"; requestId: string; message: string }
  | {
      type: "runtime.credential-request";
      requestId: string;
      operation: RuntimeCredentialOperation;
      secretReference: string;
    };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function runtimePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && !value.includes("\0") && isAbsolute(value);
}

export function parseRuntimeWorkerCommand(value: unknown): RuntimeWorkerCommand | null {
  if (!plainObject(value) || typeof value.type !== "string") return null;
  if (value.type === "runtime.shutdown" && Object.keys(value).length === 1) return { type: "runtime.shutdown" };
  if (value.type === "runtime.credential-result") {
    return parseRuntimeCredentialResult(value);
  }
  if (
    value.type === "runtime.resolve-project-path"
    && Object.keys(value).length === 3
    && typeof value.requestId === "string"
    && UUID_PATTERN.test(value.requestId)
  ) {
    const request = parseOpenProjectPathRequest(value.request);
    return request ? { type: "runtime.resolve-project-path", requestId: value.requestId, request } : null;
  }
  if (value.type !== "runtime.start" || Object.keys(value).length !== 2 || !plainObject(value.options)) return null;
  const options = value.options;
  const optionKeys = Object.keys(options);
  const hasKimiProfiles = Object.hasOwn(options, "kimiClaudeProfiles");
  const hasCodexBinaryPath = Object.hasOwn(options, "codexBinaryPath");
  if (
    optionKeys.length !== 3 + Number(hasKimiProfiles) + Number(hasCodexBinaryPath)
    || !runtimePath(options.dataDirectory)
    || !runtimePath(options.defaultWorkspacePath)
    || typeof options.enableProviders !== "boolean"
    || (hasCodexBinaryPath && !runtimePath(options.codexBinaryPath))
  ) return null;
  const kimiClaudeProfiles: ClaudeCompatibleBackendProfile[] = [];
  if (hasKimiProfiles) {
    if (
      !Array.isArray(options.kimiClaudeProfiles)
      || options.kimiClaudeProfiles.length > 8
    ) return null;
    for (const profile of options.kimiClaudeProfiles) {
      const parsed = claudeCompatibleBackendProfileSchema.safeParse(profile);
      if (!parsed.success || parsed.data.preset !== "kimi-code") return null;
      kimiClaudeProfiles.push(parsed.data);
    }
  }
  return {
    type: "runtime.start",
    options: {
      dataDirectory: options.dataDirectory,
      defaultWorkspacePath: options.defaultWorkspacePath,
      enableProviders: options.enableProviders,
      ...(hasCodexBinaryPath ? { codexBinaryPath: options.codexBinaryPath as string } : {}),
      ...(hasKimiProfiles ? { kimiClaudeProfiles } : {}),
    },
  };
}

export function parseRuntimeWorkerEvent(value: unknown): RuntimeWorkerEvent | null {
  if (!plainObject(value) || typeof value.type !== "string") return null;
  if (value.type === "runtime.stopped" && Object.keys(value).length === 1) return { type: "runtime.stopped" };
  if (
    value.type === "runtime.credential-request"
    && Object.keys(value).length === 4
    && typeof value.requestId === "string"
    && UUID_PATTERN.test(value.requestId)
    && (
      value.operation === "resolve"
      || value.operation === "status"
      || value.operation === "clear"
      || value.operation === "forget"
    )
    && isBackendSecretReference(value.secretReference)
  ) {
    return {
      type: "runtime.credential-request",
      requestId: value.requestId,
      operation: value.operation,
      secretReference: value.secretReference,
    };
  }
  if (
    value.type === "runtime.project-path-resolved"
    && Object.keys(value).length === 3
    && typeof value.requestId === "string"
    && UUID_PATTERN.test(value.requestId)
    && runtimePath(value.path)
  ) {
    return { type: "runtime.project-path-resolved", requestId: value.requestId, path: value.path };
  }
  if (
    value.type === "runtime.project-path-rejected"
    && Object.keys(value).length === 3
    && typeof value.requestId === "string"
    && UUID_PATTERN.test(value.requestId)
    && typeof value.message === "string"
  ) {
    const message = value.message.trim();
    return message && message.length <= 1_000
      ? { type: "runtime.project-path-rejected", requestId: value.requestId, message }
      : null;
  }
  if (value.type === "runtime.startup-failed" && Object.keys(value).length === 2 && typeof value.message === "string") {
    const message = value.message.trim();
    return message && message.length <= 1000 ? { type: "runtime.startup-failed", message } : null;
  }
  if (value.type === "runtime.ready" && Object.keys(value).length === 2 && isRuntimeWebSocketUrl(value.websocketUrl)) {
    return { type: "runtime.ready", websocketUrl: value.websocketUrl };
  }
  return null;
}

function parseRuntimeCredentialResult(
  value: Record<string, unknown>,
): RuntimeCredentialResult | null {
  if (
    typeof value.requestId !== "string"
    || !UUID_PATTERN.test(value.requestId)
    || (
      value.operation !== "resolve"
      && value.operation !== "status"
      && value.operation !== "clear"
      && value.operation !== "forget"
    )
    || typeof value.ok !== "boolean"
  ) return null;
  if (!value.ok) {
    if (
      Object.keys(value).length !== 6
      || (
        value.code !== "not-found"
        && value.code !== "unavailable"
        && value.code !== "invalid"
      )
      || typeof value.message !== "string"
    ) return null;
    const message = value.message.trim();
    return message.length > 0 && message.length <= 300
      ? {
          type: "runtime.credential-result",
          requestId: value.requestId,
          operation: value.operation,
          ok: false,
          code: value.code,
          message,
        }
      : null;
  }
  if (
    value.operation === "resolve"
    && Object.keys(value).length === 5
    && isBackendCredentialSecret(value.secret)
  ) {
    return {
      type: "runtime.credential-result",
      requestId: value.requestId,
      operation: "resolve",
      ok: true,
      secret: value.secret,
    };
  }
  if (
    value.operation === "status"
    && Object.keys(value).length === 6
    && typeof value.hasSecret === "boolean"
    && (
      value.credentialGeneration === null
      || isBackendCredentialGeneration(value.credentialGeneration)
    )
  ) {
    return {
      type: "runtime.credential-result",
      requestId: value.requestId,
      operation: "status",
      ok: true,
      hasSecret: value.hasSecret,
      credentialGeneration: value.credentialGeneration,
    };
  }
  if (
    (value.operation === "clear" || value.operation === "forget")
    && Object.keys(value).length === 5
    && typeof value.removed === "boolean"
  ) {
    return {
      type: "runtime.credential-result",
      requestId: value.requestId,
      operation: value.operation,
      ok: true,
      removed: value.removed,
    };
  }
  return null;
}

export function isRuntimeWebSocketUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 512) return false;
  try {
    const url = new URL(value);
    const port = Number(url.port);
    return url.protocol === "ws:"
      && url.hostname === "127.0.0.1"
      && Number.isInteger(port)
      && port >= 1
      && port <= 65_535
      && !url.username
      && !url.password
      && !url.search
      && !url.hash
      && /^\/runtime\/[A-Za-z0-9_-]{43}$/u.test(url.pathname);
  } catch {
    return false;
  }
}
