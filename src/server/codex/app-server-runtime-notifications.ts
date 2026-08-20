import {
  boundedText,
  objectValue,
  type JsonObject,
} from "./protocol";
import type { CodexAppServerOptions } from "./types";

type EmitActivity = NonNullable<CodexAppServerOptions["onActivity"]>;

interface CodexRuntimeNotificationHost {
  providerThreadId: () => string | undefined;
  activeTurnId: () => string | undefined;
  emitActivity: EmitActivity;
}

export type CodexRuntimeNotificationOutcome =
  | "not-handled"
  | "handled"
  | "active-thread-deleted";

const AUTO_REVIEW_FAILURE_STATUSES = new Set([
  "denied",
  "timedOut",
  "aborted",
]);

function notificationThreadId(params: JsonObject): string | undefined {
  return boundedText(params.threadId, 512);
}

function notificationTurnId(params: JsonObject): string | undefined {
  return boundedText(params.turnId, 512);
}

function ownsThread(
  host: CodexRuntimeNotificationHost,
  params: JsonObject,
): boolean {
  const threadId = host.providerThreadId();
  return Boolean(threadId && notificationThreadId(params) === threadId);
}

function ownsTurn(
  host: CodexRuntimeNotificationHost,
  params: JsonObject,
): boolean {
  const turnId = host.activeTurnId();
  return ownsThread(host, params)
    && Boolean(turnId && notificationTurnId(params) === turnId);
}

function boundedStrings(
  value: unknown,
  maxItems = 16,
  maxChars = 500,
): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, maxItems).flatMap((entry) =>
    boundedText(entry, maxChars) ?? []
  );
}

function emitNotice(
  host: CodexRuntimeNotificationHost,
  method: string,
  params: JsonObject,
): CodexRuntimeNotificationOutcome {
  if (
    method !== "configWarning"
    && method !== "deprecationNotice"
    && method !== "warning"
    && method !== "guardianWarning"
  ) return "not-handled";

  if (method === "guardianWarning" && !ownsThread(host, params)) {
    return "handled";
  }
  if (
    method === "warning"
    && params.threadId !== null
    && notificationThreadId(params) !== host.providerThreadId()
  ) return "handled";

  const summary = boundedText(params.summary, 1_000)
    ?? boundedText(params.message, 1_000)
    ?? (method === "configWarning"
      ? "Codex configuration warning"
      : method === "deprecationNotice"
        ? "Codex deprecation notice"
        : method === "guardianWarning"
          ? "Codex guardian warning"
          : "Codex warning");
  const detail = [
    boundedText(params.details, 8_000),
    boundedText(params.path, 2_000),
  ].filter((part): part is string => Boolean(part)).join("\n\n");
  host.emitActivity(
    "system",
    "info",
    summary,
    detail ? { detail } : undefined,
  );
  return "handled";
}

function projectMcpStartup(
  host: CodexRuntimeNotificationHost,
  method: string,
  params: JsonObject,
): CodexRuntimeNotificationOutcome {
  if (method !== "mcpServer/startupStatus/updated") return "not-handled";
  const appScoped = params.threadId === null;
  if (!appScoped && !ownsThread(host, params)) return "handled";

  const name = boundedText(params.name, 200) ?? "MCP server";
  const status = boundedText(params.status, 100);
  const error = boundedText(params.error, 8_000);
  const failureReason = boundedText(params.failureReason, 200);
  const detail = [
    error ? `Error:\n${error}` : null,
    failureReason === "reauthenticationRequired"
      ? "Authentication must be renewed before this server can start."
      : failureReason ? `Failure reason: ${failureReason}` : null,
  ].filter((part): part is string => Boolean(part)).join("\n\n");
  const projection = status === "starting"
    ? { phase: "started" as const, label: `MCP server starting · ${name}` }
    : status === "ready"
      ? { phase: "completed" as const, label: `MCP server ready · ${name}` }
      : status === "failed"
        ? { phase: "failed" as const, label: `MCP server failed to start · ${name}` }
        : status === "cancelled"
          ? { phase: "info" as const, label: `MCP server startup cancelled · ${name}` }
          : { phase: "info" as const, label: `MCP server status changed · ${name}` };
  host.emitActivity(
    "system",
    projection.phase,
    projection.label,
    detail ? { detail } : undefined,
  );
  return "handled";
}

function autoReviewActionDetail(value: unknown): string | null {
  const action = objectValue(value);
  const type = boundedText(action?.type, 100);
  if (!action || !type) return null;
  const detail = type === "command"
    ? boundedText(action.command, 4_000)
    : type === "execve"
      ? [
          boundedText(action.program, 1_000),
          ...boundedStrings(action.argv, 32, 500),
        ].filter(Boolean).join(" ")
      : type === "applyPatch"
        ? boundedStrings(action.files, 32, 2_000).join("\n")
        : type === "networkAccess"
          ? boundedText(action.target, 2_000)
            ?? boundedText(action.host, 500)
          : type === "mcpToolCall"
            ? [
                boundedText(action.server, 200),
                boundedText(action.toolName, 200),
              ].filter(Boolean).join(" / ")
            : type === "requestPermissions"
              ? boundedText(action.reason, 4_000)
              : null;
  return detail ? `${type}: ${detail}` : type;
}

function projectAutoApprovalReview(
  host: CodexRuntimeNotificationHost,
  method: string,
  params: JsonObject,
): CodexRuntimeNotificationOutcome {
  if (
    method !== "item/autoApprovalReview/started"
    && method !== "item/autoApprovalReview/completed"
  ) return "not-handled";
  if (!ownsTurn(host, params)) return "handled";

  const reviewId = boundedText(params.reviewId, 1_000);
  const review = objectValue(params.review);
  const status = boundedText(review?.status, 100);
  const riskLevel = boundedText(review?.riskLevel, 100);
  const authorization = boundedText(review?.userAuthorization, 100);
  const rationale = boundedText(review?.rationale, 4_000);
  const action = autoReviewActionDetail(params.action);
  const targetItemId = boundedText(params.targetItemId, 1_000);
  const detail = [
    action ? `Action: ${action}` : null,
    targetItemId ? `Target item: ${targetItemId}` : null,
    riskLevel ? `Risk: ${riskLevel}` : null,
    authorization ? `User authorization: ${authorization}` : null,
    rationale ? `Rationale:\n${rationale}` : null,
  ].filter((part): part is string => Boolean(part)).join("\n\n");
  if (method === "item/autoApprovalReview/started") {
    host.emitActivity(
      "system",
      "started",
      "Approval auto-review started",
      reviewId || detail
        ? { ...(reviewId ? { activityId: reviewId } : {}), ...(detail ? { detail } : {}) }
        : undefined,
    );
    return "handled";
  }

  const phase = status === "approved"
    ? "completed"
    : status && AUTO_REVIEW_FAILURE_STATUSES.has(status)
      ? "failed"
      : "info";
  const label = status === "approved"
    ? "Approval auto-review approved"
    : status === "denied"
      ? "Approval auto-review denied"
      : status === "timedOut"
        ? "Approval auto-review timed out"
        : status === "aborted"
          ? "Approval auto-review stopped"
          : "Approval auto-review completed";
  host.emitActivity(
    "system",
    phase,
    label,
    reviewId || detail
      ? { ...(reviewId ? { activityId: reviewId } : {}), ...(detail ? { detail } : {}) }
      : undefined,
  );
  return "handled";
}

function projectModelSafety(
  host: CodexRuntimeNotificationHost,
  method: string,
  params: JsonObject,
): CodexRuntimeNotificationOutcome {
  if (method === "model/verification") {
    if (!ownsTurn(host, params)) return "handled";
    const verifications = boundedStrings(params.verifications, 16, 300);
    host.emitActivity(
      "system",
      "info",
      "Additional model verification required",
      verifications.length > 0
        ? { detail: `Required verification:\n${verifications.join("\n")}` }
        : undefined,
    );
    return "handled";
  }
  if (method !== "model/safetyBuffering/updated") return "not-handled";
  if (!ownsTurn(host, params)) return "handled";

  const model = boundedText(params.model, 160);
  const fasterModel = boundedText(params.fasterModel, 160);
  const useCases = boundedStrings(params.useCases, 16, 300);
  const reasons = boundedStrings(params.reasons, 16, 500);
  const detail = [
    model ? `Model: ${model}` : null,
    useCases.length > 0 ? `Use cases:\n${useCases.join("\n")}` : null,
    reasons.length > 0 ? `Reasons:\n${reasons.join("\n")}` : null,
    fasterModel ? `Faster alternative: ${fasterModel}` : null,
  ].filter((part): part is string => Boolean(part)).join("\n\n");
  const buffering = params.showBufferingUi === true;
  host.emitActivity(
    "system",
    buffering ? "started" : "completed",
    buffering
      ? "Codex is applying a safety review"
      : "Codex safety review completed",
    detail ? { detail } : undefined,
  );
  return "handled";
}

function settingsDetail(params: JsonObject): string | null {
  const settings = objectValue(params.threadSettings);
  if (!settings) return null;
  const sandbox = objectValue(settings.sandboxPolicy);
  const collaboration = objectValue(settings.collaborationMode);
  const approvalPolicy = boundedText(settings.approvalPolicy, 100)
    ?? (objectValue(settings.approvalPolicy) ? "granular" : undefined);
  const entries = [
    boundedText(settings.model, 160)
      ? `Model: ${boundedText(settings.model, 160)}` : null,
    boundedText(settings.effort, 100)
      ? `Reasoning effort: ${boundedText(settings.effort, 100)}` : null,
    boundedText(settings.cwd, 2_000)
      ? `Working directory: ${boundedText(settings.cwd, 2_000)}` : null,
    approvalPolicy ? `Approval policy: ${approvalPolicy}` : null,
    boundedText(settings.approvalsReviewer, 100)
      ? `Approval reviewer: ${boundedText(settings.approvalsReviewer, 100)}` : null,
    boundedText(sandbox?.type, 100)
      ? `Sandbox: ${boundedText(sandbox?.type, 100)}` : null,
    boundedText(settings.serviceTier, 100)
      ? `Service tier: ${boundedText(settings.serviceTier, 100)}` : null,
    boundedText(settings.personality, 100)
      ? `Personality: ${boundedText(settings.personality, 100)}` : null,
    boundedText(collaboration?.mode, 100)
      ? `Collaboration mode: ${boundedText(collaboration?.mode, 100)}` : null,
  ].filter((part): part is string => Boolean(part));
  return entries.length > 0 ? entries.join("\n") : null;
}

function projectThreadRuntime(
  host: CodexRuntimeNotificationHost,
  method: string,
  params: JsonObject,
): CodexRuntimeNotificationOutcome {
  if (
    method !== "thread/deleted"
    && method !== "thread/reverted"
    && method !== "thread/environment/connected"
    && method !== "thread/environment/disconnected"
    && method !== "thread/settings/updated"
  ) return "not-handled";
  if (!ownsThread(host, params)) return "handled";
  if (method === "thread/deleted") return "active-thread-deleted";
  if (method === "thread/reverted") {
    host.emitActivity("system", "info", "Codex thread history was reverted");
    return "handled";
  }
  if (method === "thread/settings/updated") {
    const detail = settingsDetail(params);
    host.emitActivity(
      "system",
      "info",
      "Codex thread settings updated",
      detail ? { detail } : undefined,
    );
    return "handled";
  }
  const environmentId = boundedText(params.environmentId, 500);
  const connected = method === "thread/environment/connected";
  host.emitActivity(
    "system",
    connected ? "completed" : "info",
    connected
      ? "Codex environment connected"
      : "Codex environment disconnected",
    environmentId ? { detail: `Environment: ${environmentId}` } : undefined,
  );
  return "handled";
}

export function projectCodexRuntimeNotification(
  host: CodexRuntimeNotificationHost,
  method: string,
  params: JsonObject,
): CodexRuntimeNotificationOutcome {
  const projections = [
    emitNotice(host, method, params),
    projectMcpStartup(host, method, params),
    projectAutoApprovalReview(host, method, params),
    projectModelSafety(host, method, params),
    projectThreadRuntime(host, method, params),
  ];
  return projections.find((outcome) => outcome !== "not-handled")
    ?? "not-handled";
}
