import {
  boundedText,
  type JsonObject,
} from "./protocol";
import type { CodexAppServerOptions } from "./types";

export const CODEX_APP_SERVER_MAX_FRAME_BYTES = 16 * 1024 * 1024;
export const CODEX_APP_SERVER_MAX_PROTOCOL_BYTES = 256 * 1024 * 1024;
export const MAX_CODEX_TEXT_CHARS = 4 * 1024 * 1024;
export const MAX_CODEX_DIAGNOSTIC_CHARS = 32 * 1024;
export const CODEX_RPC_TIMEOUT_MS = 30_000;
export const CODEX_TRANSPORT_CLOSE_GRACE_MS = 100;
export const CODEX_SUBAGENT_DRAIN_TIMEOUT_MS = 2_000;
export const CODEX_GOAL_CONTINUATION_GRACE_MS = 30_000;
const MIN_CODEX_SUBAGENT_DRAIN_TIMEOUT_MS = 25;
const MIN_CODEX_GOAL_CONTINUATION_GRACE_MS = 25;

export type CodexRunPhase =
  | "opening"
  | "starting-turn"
  | "running"
  | "awaiting-goal-continuation"
  | "settled";

export interface CodexAccessPolicy {
  approvalPolicy: "untrusted" | "on-request" | "never";
  threadSandbox: "read-only" | "workspace-write" | "danger-full-access";
  turnSandboxPolicy: JsonObject;
}

export function codexSubagentDrainTimeoutMs(
  value: CodexAppServerOptions["subagentDrainTimeoutMs"],
): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 1
  ) {
    return CODEX_SUBAGENT_DRAIN_TIMEOUT_MS;
  }
  return Math.max(
    MIN_CODEX_SUBAGENT_DRAIN_TIMEOUT_MS,
    Math.min(value, CODEX_SUBAGENT_DRAIN_TIMEOUT_MS),
  );
}

export function codexGoalContinuationGraceMs(
  value: CodexAppServerOptions["goalContinuationGraceMs"],
): number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 1
  ) {
    return CODEX_GOAL_CONTINUATION_GRACE_MS;
  }
  return Math.max(
    MIN_CODEX_GOAL_CONTINUATION_GRACE_MS,
    Math.min(value, CODEX_GOAL_CONTINUATION_GRACE_MS),
  );
}

export function codexProtocolLimits(
  override: CodexAppServerOptions["protocolLimits"],
): { maxFrameBytes: number; maxProtocolBytes: number } {
  if (!override) {
    return {
      maxFrameBytes: CODEX_APP_SERVER_MAX_FRAME_BYTES,
      maxProtocolBytes: CODEX_APP_SERVER_MAX_PROTOCOL_BYTES,
    };
  }
  if (
    !Number.isSafeInteger(override.maxFrameBytes)
    || override.maxFrameBytes < 1
    || !Number.isSafeInteger(override.maxProtocolBytes)
    || override.maxProtocolBytes < override.maxFrameBytes
  ) {
    throw new Error("The Codex App Server protocol limits are invalid.");
  }
  return override;
}

export function commandExecutionLabel(item: JsonObject): string {
  const raw = boundedText(item.command, 4_000)
    ?? boundedText(item.cmd, 4_000)
    ?? (Array.isArray(item.command)
      ? item.command
        .filter((value): value is string => typeof value === "string")
        .join(" ")
      : undefined);
  if (!raw) return "Command";
  const packageScript =
    /\b(npm|pnpm|yarn|bun)\s+(?:(run)\s+)?([A-Za-z0-9:_-]{1,80})/u
      .exec(raw);
  if (!packageScript) return "Command";
  return `${packageScript[1]} ${packageScript[2] ? "run " : ""}${packageScript[3]}`;
}

export function codexAccessPolicy(
  options: Pick<CodexAppServerOptions, "access" | "planMode">,
): CodexAccessPolicy {
  if (options.access === "full") {
    return {
      approvalPolicy: "never",
      threadSandbox: "danger-full-access",
      turnSandboxPolicy: { type: "dangerFullAccess" },
    };
  }

  const readOnly = options.planMode || options.access === "supervised";
  return {
    approvalPolicy: options.access === "supervised"
      ? "untrusted"
      : "on-request",
    threadSandbox: readOnly ? "read-only" : "workspace-write",
    turnSandboxPolicy: readOnly
      ? { type: "readOnly", networkAccess: false }
      : {
          type: "workspaceWrite",
          writableRoots: [],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
  };
}

export function isUnsupportedFullAccessError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const unsupported = "(?:unknown|unsupported|unrecognized|invalid)";
  const fullAccess = "(?:danger-full-access|dangerFullAccess)";
  return new RegExp(
    `${unsupported}.{0,160}${fullAccess}|${fullAccess}.{0,160}${unsupported}`,
    "iu",
  ).test(message);
}

export function isStaleResumeError(error: unknown): boolean {
  const message = (
    error instanceof Error ? error.message : String(error)
  ).toLowerCase();
  return message.includes("thread")
    && [
      "not found",
      "missing",
      "unknown",
      "does not exist",
      "no such",
    ].some((part) => message.includes(part));
}

export function validateCodexModelProvider(
  options: Pick<CodexAppServerOptions, "environment" | "modelProvider">,
): CodexAppServerOptions["modelProvider"] {
  const provider = options.modelProvider;
  if (!provider) return undefined;
  let baseUrl: URL;
  try {
    baseUrl = new URL(provider.baseUrl);
  } catch {
    throw new Error("The Codex Responses backend configuration is invalid.");
  }
  const literalLoopback = baseUrl.hostname === "localhost"
    || baseUrl.hostname === "[::1]"
    || (
      baseUrl.hostname.split(".").length === 4
      && baseUrl.hostname.split(".")[0] === "127"
      && baseUrl.hostname.split(".").every((part) =>
        /^\d{1,3}$/u.test(part) && Number(part) <= 255)
    );
  if (
    !/^[A-Za-z0-9_-]{1,64}$/u.test(provider.providerId)
    || provider.displayName.length < 1
    || provider.displayName.length > 120
    || /[\0\r\n]/u.test(provider.displayName)
    || (
      baseUrl.protocol !== "https:"
      && !(baseUrl.protocol === "http:" && literalLoopback)
    )
    || Boolean(
      baseUrl.username
      || baseUrl.password
      || baseUrl.search
      || baseUrl.hash,
    )
    || provider.baseUrl.length > 2_048
  ) {
    throw new Error("The Codex Responses backend configuration is invalid.");
  }
  if (
    provider.credentialEnvironmentKey !== null
    && (
      !/^[A-Z_][A-Z0-9_]{0,127}$/u.test(
        provider.credentialEnvironmentKey,
      )
      || !options.environment[provider.credentialEnvironmentKey]
    )
  ) {
    throw new Error("The Codex Responses backend credential is unavailable.");
  }
  return provider;
}
