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
import {
  CHAT_ATTACHMENT_MIME_TYPES,
  MAX_CHAT_ATTACHMENT_BYTES,
} from "../shared/attachments";
import type { TrustedRuntimeAttachment } from "../shared/runtime-attachments";
import {
  remoteAuthorizationSubjectSchema,
  remoteRequestSchema,
  remoteResponseSchema,
  type RemoteAuthorizationSubject,
  type RemoteRequest,
  type RemoteResponse,
} from "../shared/remote-protocol";
import {
  parseSecureFileRequest,
  parseSecureFileResult,
  type SecureFileRequest,
  type SecureFileResult,
} from "./secure-file-protocol";

export interface RuntimeWorkerOptions {
  dataDirectory: string;
  defaultWorkspacePath: string;
  enableProviders: boolean;
  /** Optional trusted desktop override; never accepted from the renderer. */
  codexBinaryPath?: string;
  /** Main-owned import root used to revalidate brokered attachment capabilities. */
  attachmentRoot?: string;
  /** Safe configuration only; credential values remain in the main-process vault. */
  kimiClaudeProfiles?: readonly ClaudeCompatibleBackendProfile[];
  /** Test-only packaged-runtime proof that the native PDF stack can execute. */
  packageSmokePdf?: {
    inputPath: string;
    resultPath: string;
  };
  /** Privileged deterministic fault injection used by lifecycle tests only. */
  recoveryImportFault?: {
    phase: "after-staging-publish";
    markerPath: string;
    stallMs: number;
  };
}

export interface RuntimeRemotePromptPreparation {
  preparationId: string;
}

export type RuntimeRemoteForgetScope =
  | { kind: "all" }
  | { kind: "conversation"; conversationId: string };

export type RuntimeDatabaseRecoveryOperation = "export" | "import";

export interface RuntimeDatabaseRecoverySummary {
  projects: number;
  conversations: number;
  messages: number;
  alreadyImported: boolean;
}

export interface RuntimeDatabaseStartupRecoveryReport {
  checkedAt: string;
  outcome: "healthy" | "first-launch" | "restored" | "created-empty";
  trigger: "none" | "primary-missing" | "primary-corrupt";
  restoredBackup: string | null;
  preservedCorruptPrimary: boolean;
  invalidBackupsSkipped: number;
  unsupportedBackupsSkipped: number;
}

export type RuntimeWorkerCommand =
  | { type: "runtime.start"; options: RuntimeWorkerOptions }
  | { type: "runtime.shutdown" }
  | { type: "runtime.resolve-project-path"; requestId: string; request: OpenProjectPathRequest }
  | {
      type: "runtime.remote-request";
      requestId: string;
      subject: RemoteAuthorizationSubject;
      request: Exclude<RemoteRequest, { type: "prompt.send" }>;
    }
  | {
      type: "runtime.remote-prompt-prepare";
      operationId: string;
      subject: RemoteAuthorizationSubject;
      request: Extract<RemoteRequest, { type: "prompt.send" }>;
    }
  | {
      type: "runtime.remote-prompt-commit";
      operationId: string;
      preparationId: string;
      subject: RemoteAuthorizationSubject;
      request: Extract<RemoteRequest, { type: "prompt.send" }>;
    }
  | { type: "runtime.remote-forget"; scope: RuntimeRemoteForgetScope }
  | {
      type: "runtime.database-recovery";
      operationId: string;
      generation: number;
      operation: RuntimeDatabaseRecoveryOperation;
      path: string;
      targetDirectory?: string;
    }
  | {
      type: "runtime.database-recovery-cancel";
      operationId: string;
      generation: number;
      operation: RuntimeDatabaseRecoveryOperation;
    }
  | RuntimeCredentialResult
  | RuntimeAttachmentResult
  | RuntimeAttachmentReleaseResult
  | RuntimeAttachmentRelinquishResult
  | RuntimeSecureFileResult;

export type RuntimeCredentialOperation = "resolve" | "status" | "clear" | "forget";
export type RuntimeCredentialFailureCode = "not-found" | "unavailable" | "invalid";
export type RuntimeAttachmentFailureCode = "not-found" | "unavailable" | "invalid";

export type RuntimeAttachmentResult =
  | {
      type: "runtime.attachment-result";
      requestId: string;
      ok: true;
      attachment: TrustedRuntimeAttachment;
    }
  | {
      type: "runtime.attachment-result";
      requestId: string;
      ok: false;
      code: RuntimeAttachmentFailureCode;
      message: string;
    };

export type RuntimeAttachmentReleaseResult =
  | {
      type: "runtime.attachment-release-result";
      requestId: string;
      ok: true;
      released: boolean;
    }
  | {
      type: "runtime.attachment-release-result";
      requestId: string;
      ok: false;
      code: RuntimeAttachmentFailureCode;
      message: string;
    };

export type RuntimeAttachmentRelinquishResult =
  | {
      type: "runtime.attachment-relinquish-result";
      requestId: string;
      ok: true;
      relinquished: boolean;
    }
  | {
      type: "runtime.attachment-relinquish-result";
      requestId: string;
      ok: false;
      code: RuntimeAttachmentFailureCode;
      message: string;
    };

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

export interface RuntimeSecureFileResult {
  type: "runtime.secure-file-result";
  requestId: string;
  result: SecureFileResult;
}

export type RuntimeWorkerEvent =
  | {
      type: "runtime.ready";
      websocketUrl: string;
      databaseRecovery?: RuntimeDatabaseStartupRecoveryReport;
    }
  | { type: "runtime.startup-failed"; message: string }
  | { type: "runtime.shutdown-unconfirmed" }
  | { type: "runtime.stopped" }
  | { type: "runtime.project-path-resolved"; requestId: string; path: string }
  | { type: "runtime.project-path-rejected"; requestId: string; message: string }
  | {
      type: "runtime.database-recovery-result";
      operationId: string;
      generation: number;
      operation: RuntimeDatabaseRecoveryOperation;
      ok: true;
      summary: RuntimeDatabaseRecoverySummary | null;
    }
  | {
      type: "runtime.database-recovery-result";
      operationId: string;
      generation: number;
      operation: RuntimeDatabaseRecoveryOperation;
      ok: false;
      cancelled: boolean;
      message: string;
    }
  | {
      type: "runtime.remote-response";
      requestId: string;
      response: RemoteResponse;
    }
  | {
      type: "runtime.remote-prompt-result";
      operationId: string;
      requestId: string;
      phase: "prepare" | "commit";
      preparationId: string | null;
      response: RemoteResponse | null;
    }
  | {
      type: "runtime.attachment-request";
      requestId: string;
      attachmentId: string;
    }
  | {
      type: "runtime.attachment-release-request";
      requestId: string;
      attachmentId: string;
    }
  | {
      type: "runtime.attachment-cleanup-request";
      requestId: string;
      attachmentId: string;
    }
  | {
      type: "runtime.attachment-relinquish-request";
      requestId: string;
      attachmentId: string;
    }
  | {
      type: "runtime.credential-request";
      requestId: string;
      operation: RuntimeCredentialOperation;
      secretReference: string;
    }
  | ({
      type: "runtime.secure-file-request";
      requestId: string;
    } & SecureFileRequest);

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
  if (value.type === "runtime.attachment-result") {
    return parseRuntimeAttachmentResult(value);
  }
  if (value.type === "runtime.attachment-release-result") {
    return parseRuntimeAttachmentReleaseResult(value);
  }
  if (value.type === "runtime.attachment-relinquish-result") {
    return parseRuntimeAttachmentRelinquishResult(value);
  }
  if (value.type === "runtime.credential-result") {
    return parseRuntimeCredentialResult(value);
  }
  if (
    value.type === "runtime.secure-file-result"
    && Object.keys(value).length === 3
    && typeof value.requestId === "string"
    && UUID_PATTERN.test(value.requestId)
  ) {
    const result = parseSecureFileResult(value.result);
    return result
      ? {
          type: "runtime.secure-file-result",
          requestId: value.requestId,
          result,
        }
      : null;
  }
  if (
    value.type === "runtime.remote-forget"
    && Object.keys(value).length === 2
  ) {
    const scope = parseRuntimeRemoteForgetScope(value.scope);
    return scope ? { type: "runtime.remote-forget", scope } : null;
  }
  if (
    value.type === "runtime.remote-request"
    && Object.keys(value).length === 4
    && typeof value.requestId === "string"
    && UUID_PATTERN.test(value.requestId)
  ) {
    const subject = remoteAuthorizationSubjectSchema.safeParse(value.subject);
    const request = remoteRequestSchema.safeParse(value.request);
    return subject.success
      && request.success
      && request.data.type !== "prompt.send"
      && request.data.requestId === value.requestId
      ? {
          type: "runtime.remote-request",
          requestId: value.requestId,
          subject: subject.data,
          request: request.data,
        }
      : null;
  }
  if (
    (
      value.type === "runtime.remote-prompt-prepare"
      || value.type === "runtime.remote-prompt-commit"
    )
    && Object.keys(value).length === (
      value.type === "runtime.remote-prompt-commit" ? 5 : 4
    )
    && typeof value.operationId === "string"
    && UUID_PATTERN.test(value.operationId)
  ) {
    if (
      value.type === "runtime.remote-prompt-commit"
      && (
        typeof value.preparationId !== "string"
        || !UUID_PATTERN.test(value.preparationId)
      )
    ) return null;
    const subject = remoteAuthorizationSubjectSchema.safeParse(value.subject);
    const request = remoteRequestSchema.safeParse(value.request);
    if (
      !subject.success
      || !request.success
      || request.data.type !== "prompt.send"
    ) return null;
    return value.type === "runtime.remote-prompt-commit"
      ? {
          type: "runtime.remote-prompt-commit",
          operationId: value.operationId,
          preparationId: value.preparationId as string,
          subject: subject.data,
          request: request.data,
        }
      : {
          type: "runtime.remote-prompt-prepare",
          operationId: value.operationId,
          subject: subject.data,
          request: request.data,
        };
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
  if (
    value.type === "runtime.database-recovery-cancel"
    && Object.keys(value).length === 4
    && typeof value.operationId === "string"
    && UUID_PATTERN.test(value.operationId)
    && typeof value.generation === "number"
    && Number.isSafeInteger(value.generation)
    && value.generation > 0
    && (value.operation === "export" || value.operation === "import")
  ) {
    return {
      type: "runtime.database-recovery-cancel",
      operationId: value.operationId,
      generation: value.generation,
      operation: value.operation,
    };
  }
  if (
    value.type === "runtime.database-recovery"
    && typeof value.operationId === "string"
    && UUID_PATTERN.test(value.operationId)
    && typeof value.generation === "number"
    && Number.isSafeInteger(value.generation)
    && value.generation > 0
    && (value.operation === "export" || value.operation === "import")
    && runtimePath(value.path)
  ) {
    if (value.operation === "export" && Object.keys(value).length === 5) return {
      type: "runtime.database-recovery",
      operationId: value.operationId,
      generation: value.generation,
      operation: "export",
      path: value.path,
    };
    if (
      value.operation === "import"
      && Object.keys(value).length === 6
      && runtimePath(value.targetDirectory)
    ) return {
      type: "runtime.database-recovery",
      operationId: value.operationId,
      generation: value.generation,
      operation: "import",
      path: value.path,
      targetDirectory: value.targetDirectory,
    };
    return null;
  }
  if (value.type !== "runtime.start" || Object.keys(value).length !== 2 || !plainObject(value.options)) return null;
  const options = value.options;
  const optionKeys = Object.keys(options);
  const hasKimiProfiles = Object.hasOwn(options, "kimiClaudeProfiles");
  const hasCodexBinaryPath = Object.hasOwn(options, "codexBinaryPath");
  const hasAttachmentRoot = Object.hasOwn(options, "attachmentRoot");
  const hasPackageSmokePdf = Object.hasOwn(options, "packageSmokePdf");
  const hasRecoveryImportFault = Object.hasOwn(options, "recoveryImportFault");
  if (
    optionKeys.length !== 3
      + Number(hasKimiProfiles)
      + Number(hasCodexBinaryPath)
      + Number(hasAttachmentRoot)
      + Number(hasPackageSmokePdf)
      + Number(hasRecoveryImportFault)
    || !runtimePath(options.dataDirectory)
    || !runtimePath(options.defaultWorkspacePath)
    || typeof options.enableProviders !== "boolean"
    || (hasCodexBinaryPath && !runtimePath(options.codexBinaryPath))
    || (hasAttachmentRoot && !runtimePath(options.attachmentRoot))
    || (
      hasPackageSmokePdf
      && (
        !plainObject(options.packageSmokePdf)
        || Object.keys(options.packageSmokePdf).length !== 2
        || !runtimePath(options.packageSmokePdf.inputPath)
        || !runtimePath(options.packageSmokePdf.resultPath)
      )
    )
    || (
      hasRecoveryImportFault
      && (
        !plainObject(options.recoveryImportFault)
        || Object.keys(options.recoveryImportFault).length !== 3
        || options.recoveryImportFault.phase !== "after-staging-publish"
        || !runtimePath(options.recoveryImportFault.markerPath)
        || typeof options.recoveryImportFault.stallMs !== "number"
        || !Number.isSafeInteger(options.recoveryImportFault.stallMs)
        || options.recoveryImportFault.stallMs < 1_000
        || options.recoveryImportFault.stallMs > 30_000
      )
    )
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
      ...(hasAttachmentRoot ? { attachmentRoot: options.attachmentRoot as string } : {}),
      ...(hasKimiProfiles ? { kimiClaudeProfiles } : {}),
      ...(hasPackageSmokePdf
        ? {
            packageSmokePdf: {
              inputPath: (options.packageSmokePdf as Record<string, unknown>).inputPath as string,
              resultPath: (options.packageSmokePdf as Record<string, unknown>).resultPath as string,
            },
          }
        : {}),
      ...(hasRecoveryImportFault
        ? {
            recoveryImportFault: {
              phase: "after-staging-publish" as const,
              markerPath: (options.recoveryImportFault as Record<string, unknown>).markerPath as string,
              stallMs: (options.recoveryImportFault as Record<string, unknown>).stallMs as number,
            },
          }
        : {}),
    },
  };
}

export function parseRuntimeWorkerEvent(value: unknown): RuntimeWorkerEvent | null {
  if (!plainObject(value) || typeof value.type !== "string") return null;
  if (value.type === "runtime.stopped" && Object.keys(value).length === 1) return { type: "runtime.stopped" };
  if (value.type === "runtime.shutdown-unconfirmed" && Object.keys(value).length === 1) {
    return { type: "runtime.shutdown-unconfirmed" };
  }
  if (
    value.type === "runtime.remote-response"
    && Object.keys(value).length === 3
    && typeof value.requestId === "string"
    && UUID_PATTERN.test(value.requestId)
  ) {
    const response = remoteResponseSchema.safeParse(value.response);
    return response.success && response.data.requestId === value.requestId
      ? {
          type: "runtime.remote-response",
          requestId: value.requestId,
          response: response.data,
        }
      : null;
  }
  if (
    value.type === "runtime.remote-prompt-result"
    && Object.keys(value).length === 6
    && typeof value.operationId === "string"
    && UUID_PATTERN.test(value.operationId)
    && typeof value.requestId === "string"
    && UUID_PATTERN.test(value.requestId)
    && (value.phase === "prepare" || value.phase === "commit")
  ) {
    const response = value.response === null
      ? null
      : remoteResponseSchema.safeParse(value.response);
    const preparationId = typeof value.preparationId === "string"
      && UUID_PATTERN.test(value.preparationId)
      ? value.preparationId
      : null;
    const validResponse = response !== null
      && response.success
      && response.data.requestId === value.requestId;
    const validPrepare = value.phase === "prepare"
      && (
        (preparationId !== null && response === null)
        || (preparationId === null && validResponse)
      );
    const validCommit = value.phase === "commit"
      && preparationId === null
      && validResponse;
    if (!validPrepare && !validCommit) return null;
    return {
      type: "runtime.remote-prompt-result",
      operationId: value.operationId,
      requestId: value.requestId,
      phase: value.phase,
      preparationId,
      response: response === null ? null : response.data,
    };
  }
  if (
    (
      value.type === "runtime.attachment-request"
      || value.type === "runtime.attachment-release-request"
      || value.type === "runtime.attachment-cleanup-request"
      || value.type === "runtime.attachment-relinquish-request"
    )
    && Object.keys(value).length === 3
    && typeof value.requestId === "string"
    && UUID_PATTERN.test(value.requestId)
    && typeof value.attachmentId === "string"
    && UUID_PATTERN.test(value.attachmentId)
  ) {
    return {
      type: value.type,
      requestId: value.requestId,
      attachmentId: value.attachmentId,
    };
  }
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
    value.type === "runtime.secure-file-request"
    && typeof value.requestId === "string"
    && UUID_PATTERN.test(value.requestId)
  ) {
    const { type: _type, requestId: _requestId, ...requestValue } = value;
    const request = parseSecureFileRequest(requestValue);
    return request
      ? {
          type: "runtime.secure-file-request",
          requestId: value.requestId,
          ...request,
        }
      : null;
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
  if (
    value.type === "runtime.database-recovery-result"
    && typeof value.operationId === "string"
    && UUID_PATTERN.test(value.operationId)
    && typeof value.generation === "number"
    && Number.isSafeInteger(value.generation)
    && value.generation > 0
    && (value.operation === "export" || value.operation === "import")
    && typeof value.ok === "boolean"
  ) {
    if (!value.ok) {
      if (
        Object.keys(value).length !== 7
        || typeof value.cancelled !== "boolean"
        || typeof value.message !== "string"
      ) {
        return null;
      }
      const message = value.message.trim();
      return message.length > 0 && message.length <= 1_000
        ? {
            type: "runtime.database-recovery-result",
            operationId: value.operationId,
            generation: value.generation,
            operation: value.operation,
            ok: false,
            cancelled: value.cancelled,
            message,
          }
        : null;
    }
    if (Object.keys(value).length !== 6) return null;
    if (value.summary === null) {
      if (value.operation !== "export") return null;
      return {
        type: "runtime.database-recovery-result",
        operationId: value.operationId,
        generation: value.generation,
        operation: value.operation,
        ok: true,
        summary: null,
      };
    }
    if (!plainObject(value.summary) || Object.keys(value.summary).length !== 4) {
      return null;
    }
    if (value.operation !== "import") return null;
    const summary = value.summary;
    if (![
      summary.projects,
      summary.conversations,
      summary.messages,
    ].every((count) =>
      typeof count === "number"
      && Number.isSafeInteger(count)
      && count >= 0)) return null;
    if (typeof summary.alreadyImported !== "boolean") return null;
    return {
      type: "runtime.database-recovery-result",
      operationId: value.operationId,
      generation: value.generation,
      operation: value.operation,
      ok: true,
      summary: {
        projects: summary.projects as number,
        conversations: summary.conversations as number,
        messages: summary.messages as number,
        alreadyImported: summary.alreadyImported,
      },
    };
  }
  if (value.type === "runtime.startup-failed" && Object.keys(value).length === 2 && typeof value.message === "string") {
    const message = value.message.trim();
    return message && message.length <= 1000 ? { type: "runtime.startup-failed", message } : null;
  }
  if (
    value.type === "runtime.ready"
    && (
      Object.keys(value).length === 2
      || Object.keys(value).length === 3
    )
    && isRuntimeWebSocketUrl(value.websocketUrl)
  ) {
    if (!Object.hasOwn(value, "databaseRecovery")) {
      return { type: "runtime.ready", websocketUrl: value.websocketUrl };
    }
    const recovery = parseRuntimeDatabaseStartupRecovery(value.databaseRecovery);
    return recovery
      ? {
          type: "runtime.ready",
          websocketUrl: value.websocketUrl,
          databaseRecovery: recovery,
        }
      : null;
  }
  return null;
}

function parseRuntimeDatabaseStartupRecovery(
  value: unknown,
): RuntimeDatabaseStartupRecoveryReport | null {
  if (!plainObject(value) || Object.keys(value).length !== 7) return null;
  if (
    typeof value.checkedAt !== "string"
    || value.checkedAt.length > 64
    || !Number.isFinite(Date.parse(value.checkedAt))
    || (
      value.outcome !== "healthy"
      && value.outcome !== "first-launch"
      && value.outcome !== "restored"
      && value.outcome !== "created-empty"
    )
    || (
      value.trigger !== "none"
      && value.trigger !== "primary-missing"
      && value.trigger !== "primary-corrupt"
    )
    || (
      value.restoredBackup !== null
      && (
        typeof value.restoredBackup !== "string"
        || !/^[A-Za-z0-9_.-]{1,200}$/u.test(value.restoredBackup)
      )
    )
    || typeof value.preservedCorruptPrimary !== "boolean"
    || typeof value.invalidBackupsSkipped !== "number"
    || !Number.isSafeInteger(value.invalidBackupsSkipped)
    || value.invalidBackupsSkipped < 0
    || typeof value.unsupportedBackupsSkipped !== "number"
    || !Number.isSafeInteger(value.unsupportedBackupsSkipped)
    || value.unsupportedBackupsSkipped < 0
  ) return null;
  if (
    (
      (value.outcome === "healthy" || value.outcome === "first-launch")
      && (
        value.trigger !== "none"
        || value.restoredBackup !== null
        || value.preservedCorruptPrimary
        || value.invalidBackupsSkipped !== 0
        || value.unsupportedBackupsSkipped !== 0
      )
    )
    || (
      value.outcome === "restored"
      && (value.trigger === "none" || value.restoredBackup === null)
    )
    || (
      value.outcome === "created-empty"
      && (value.trigger === "none" || value.restoredBackup !== null)
    )
    || (value.preservedCorruptPrimary && value.trigger !== "primary-corrupt")
  ) return null;
  return {
    checkedAt: value.checkedAt,
    outcome: value.outcome,
    trigger: value.trigger,
    restoredBackup: value.restoredBackup,
    preservedCorruptPrimary: value.preservedCorruptPrimary,
    invalidBackupsSkipped: value.invalidBackupsSkipped,
    unsupportedBackupsSkipped: value.unsupportedBackupsSkipped,
  };
}

function parseRuntimeRemoteForgetScope(
  value: unknown,
): RuntimeRemoteForgetScope | null {
  if (typeof value !== "object" || value === null) return null;
  const scope = value as Record<string, unknown>;
  if (scope.kind === "all" && Object.keys(scope).length === 1) {
    return { kind: "all" };
  }
  if (
    scope.kind === "conversation"
    && Object.keys(scope).length === 2
    && typeof scope.conversationId === "string"
    && scope.conversationId.length > 0
    && scope.conversationId.length <= 200
  ) {
    return { kind: "conversation", conversationId: scope.conversationId };
  }
  return null;
}

function parseRuntimeAttachmentRelinquishResult(
  value: Record<string, unknown>,
): RuntimeAttachmentRelinquishResult | null {
  if (
    typeof value.requestId !== "string"
    || !UUID_PATTERN.test(value.requestId)
    || typeof value.ok !== "boolean"
  ) return null;
  if (!value.ok) {
    if (
      Object.keys(value).length !== 5
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
          type: "runtime.attachment-relinquish-result",
          requestId: value.requestId,
          ok: false,
          code: value.code,
          message,
        }
      : null;
  }
  return Object.keys(value).length === 4
    && typeof value.relinquished === "boolean"
    ? {
        type: "runtime.attachment-relinquish-result",
        requestId: value.requestId,
        ok: true,
        relinquished: value.relinquished,
      }
    : null;
}

function parseRuntimeAttachmentReleaseResult(
  value: Record<string, unknown>,
): RuntimeAttachmentReleaseResult | null {
  if (
    typeof value.requestId !== "string"
    || !UUID_PATTERN.test(value.requestId)
    || typeof value.ok !== "boolean"
  ) return null;
  if (!value.ok) {
    if (
      Object.keys(value).length !== 5
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
          type: "runtime.attachment-release-result",
          requestId: value.requestId,
          ok: false,
          code: value.code,
          message,
        }
      : null;
  }
  return Object.keys(value).length === 4
    && typeof value.released === "boolean"
    ? {
        type: "runtime.attachment-release-result",
        requestId: value.requestId,
        ok: true,
        released: value.released,
      }
    : null;
}

function parseRuntimeAttachmentResult(
  value: Record<string, unknown>,
): RuntimeAttachmentResult | null {
  if (
    typeof value.requestId !== "string"
    || !UUID_PATTERN.test(value.requestId)
    || typeof value.ok !== "boolean"
  ) return null;
  if (!value.ok) {
    if (
      Object.keys(value).length !== 5
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
          type: "runtime.attachment-result",
          requestId: value.requestId,
          ok: false,
          code: value.code,
          message,
        }
      : null;
  }
  if (
    Object.keys(value).length !== 4
    || !plainObject(value.attachment)
  ) return null;
  const attachment = value.attachment;
  if (
    Object.keys(attachment).length !== 6
    || typeof attachment.id !== "string"
    || !UUID_PATTERN.test(attachment.id)
    || typeof attachment.name !== "string"
    || attachment.name.length < 1
    || attachment.name.length > 255
    || /[\0-\x1f\x7f]/u.test(attachment.name)
    || !runtimePath(attachment.path)
    || !(CHAT_ATTACHMENT_MIME_TYPES as readonly unknown[]).includes(
      attachment.mimeType,
    )
    || typeof attachment.size !== "number"
    || !Number.isInteger(attachment.size)
    || attachment.size < 1
    || attachment.size > MAX_CHAT_ATTACHMENT_BYTES
    || typeof attachment.digest !== "string"
    || !/^[0-9a-f]{64}$/u.test(attachment.digest)
  ) return null;
  return {
    type: "runtime.attachment-result",
    requestId: value.requestId,
    ok: true,
    attachment: {
      id: attachment.id,
      name: attachment.name,
      path: attachment.path,
      mimeType: attachment.mimeType as TrustedRuntimeAttachment["mimeType"],
      size: attachment.size,
      digest: attachment.digest,
    },
  };
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
