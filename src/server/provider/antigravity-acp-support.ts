import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { Transform, type TransformCallback } from "node:stream";

import { parseAcpSessionNotificationOrIgnoredCommands } from "./acp-command-advertisement";
import { validAcpJsonRpcEnvelope } from "./acp-json-rpc";
import { acpStopReasonMessage } from "./acp-stop-reasons";
import {
  sanitizeProviderActivityDetail,
  sanitizeProviderFailureSummary,
} from "./activity-detail";
import type { ProviderRunFailure } from "./contracts";
import type { ProviderRunEventBudget } from "./io";
import {
  acpResumeStep,
  acpSessionUnavailable,
  namesUnrelatedMissingResource,
} from "./session-unavailable";

const MAX_ERROR_DETAIL_CHARS = 1024 * 1024;
const MAX_TECHNICAL_DETAIL_CHARS = 16 * 1024;
const MAX_STOP_REASON_CHARS = 160;
const AUTH_REQUIRED_JSON_RPC_CODE = -32000;
const RESOURCE_NOT_FOUND_JSON_RPC_CODE = -32002;
const INTERNAL_ERROR_JSON_RPC_CODE = -32603;

export class BoundedAntigravityJsonLineTransform extends Transform {
  private decoder = new TextDecoder("utf-8", { fatal: true });
  private decodedParts: string[] = [];
  private pendingBytes = 0;

  constructor(
    private readonly maxLineBytes: number,
    private readonly eventBudget: ProviderRunEventBudget,
  ) {
    super();
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    try {
      let offset = 0;
      let newline: number;
      while ((newline = chunk.indexOf(0x0a, offset)) >= 0) {
        this.appendFragment(chunk.subarray(offset, newline));
        this.finishLine();
        offset = newline + 1;
      }
      this.appendFragment(chunk.subarray(offset));
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  override _flush(callback: TransformCallback): void {
    try {
      if (this.pendingBytes > 0) this.finishLine();
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  private appendFragment(fragment: Buffer): void {
    if (fragment.byteLength === 0) return;
    const nextBytes = this.pendingBytes + fragment.byteLength;
    if (nextBytes > this.maxLineBytes) {
      throw new Error("Antigravity ACP sent an oversized JSON-RPC frame.");
    }
    const decoded = this.decoder.decode(fragment, { stream: true });
    if (decoded) this.decodedParts.push(decoded);
    this.pendingBytes = nextBytes;
  }

  private finishLine(): void {
    const trailing = this.decoder.decode();
    if (trailing) this.decodedParts.push(trailing);
    const line = this.decodedParts.join("");
    const lineBytes = this.pendingBytes;
    this.decoder = new TextDecoder("utf-8", { fatal: true });
    this.decodedParts = [];
    this.pendingBytes = 0;
    this.eventBudget.observeBytes(lineBytes);
    if (line.trim().length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error("Antigravity ACP sent a malformed JSON-RPC frame.");
    }
    if (!validAcpJsonRpcEnvelope(parsed)) {
      throw new Error("Antigravity ACP sent a malformed JSON-RPC frame.");
    }
    if ((parsed as { method?: unknown }).method === "session/update") {
      parseAcpSessionNotificationOrIgnoredCommands((parsed as { params?: unknown }).params);
    }
    this.push(`${line}\n`);
  }
}

export async function observeAntigravityProcessExit(
  child: ChildProcessWithoutNullStreams,
  waitMs = 50,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", finish);
      resolve();
    };
    child.once("exit", finish);
    const timer = setTimeout(finish, waitMs);
    timer.unref();
    if (child.exitCode !== null || child.signalCode !== null) finish();
  });
}

export function antigravitySpawnFailure(
  error: unknown,
  workspaceRoot: string,
): ProviderRunFailure {
  const detail = antigravityErrorDetail(error, "Antigravity ACP could not be started.");
  const technicalDetail = sanitizeProviderActivityDetail(detail, {
    workspaceRoot,
    maxChars: MAX_TECHNICAL_DETAIL_CHARS,
  }) ?? undefined;
  return {
    reason: "process-exit",
    message: "Antigravity ACP could not be started.",
    phase: "spawn",
    terminalEvent: "process/spawn",
    ...(technicalDetail ? { technicalDetail } : {}),
  };
}

export function antigravityStopFailure(stopReason: string): ProviderRunFailure {
  const safeStopReason = stopReason.slice(0, MAX_STOP_REASON_CHARS);
  return {
    reason: "provider-error",
    message: acpStopReasonMessage("Antigravity", safeStopReason),
    technicalDetail: `Stop reason: ${safeStopReason}`,
    phase: "turn",
    terminalEvent: `session/prompt:${safeStopReason}`,
  };
}

export interface AntigravityRuntimeFailureContext {
  child: ChildProcessWithoutNullStreams;
  processError?: Error;
  wireError?: Error;
  diagnostic: string;
  phase: string;
  terminalEvent: string;
  workspaceRoot: string;
  errorCode?: number;
}

export function antigravityErrorCode(error: unknown): number | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && !seen.has(current); depth += 1) {
    seen.add(current);
    const record = objectValue(current);
    if (record && typeof record.code === "number" && Number.isInteger(record.code)) {
      return record.code;
    }
    if (current instanceof Error) {
      const code = (current as Error & { code?: unknown }).code;
      if (typeof code === "number" && Number.isInteger(code)) return code;
      current = current.cause;
      continue;
    }
    current = record?.cause;
  }
  return undefined;
}

export function antigravityRuntimeFailure(
  error: unknown,
  context: AntigravityRuntimeFailureContext,
): ProviderRunFailure {
  const primaryDetail = antigravityErrorDetail(error, "Antigravity ACP stopped unexpectedly.");
  const errorCode = context.errorCode ?? antigravityErrorCode(error);
  const detail = [
    primaryDetail,
    context.wireError
      ? antigravityErrorDetail(context.wireError, "Antigravity ACP wire error.")
      : "",
    context.processError
      ? antigravityErrorDetail(context.processError, "Antigravity ACP process error.")
      : "",
    context.diagnostic,
  ].filter(Boolean).join("\n");
  const transportFailure = /stream (?:was )?closed|connection (?:was )?closed|transport|end of (?:file|stream)|\beof\b|epipe|econnreset|broken pipe/iu;
  const unsupportedTerminalAuth = /advertised terminal authentication without client terminal support/iu
    .test(detail);
  const invalidTerminalAuth = /unsupported or invalid terminal authentication descriptor/iu.test(detail);
  const isSubscriptionRequired = /\bSUBSCRIPTION_REQUIRED\b/iu.test(detail);
  const isTimeout = /timed out|timeout|deadline|stopped responding/iu.test(detail);
  const isNoBrowserAuth = (
    errorCode === INTERNAL_ERROR_JSON_RPC_CODE
    || /\bcode:\s*-32603\b/u.test(detail)
  ) && /no browser is available here/iu.test(detail);
  const isAuth = !unsupportedTerminalAuth && !invalidTerminalAuth && !isSubscriptionRequired && (
    errorCode === AUTH_REQUIRED_JSON_RPC_CODE
    || isNoBrowserAuth
    || /auth_required|not authenticated|authentication required|authentication expired|login required|unauthorized|\bcode:\s*-32000\b/iu
      .test(detail)
    || (context.phase === "auth" && !isTimeout)
  );
  const reason: ProviderRunFailure["reason"] = unsupportedTerminalAuth || invalidTerminalAuth || isSubscriptionRequired
    ? "provider-error"
    : isAuth
    ? "provider-error"
    : /oversized|bounded (?:approval|input|tool activity|event|protocol)|safety limit|more than \d+ input options/iu.test(detail)
      ? "protocol-overflow"
      : /malformed|unexpected token|json-rpc frame|protocol version|not antigravity|invalid .* identity|invalid utf|not valid.*utf-?8|did not return a session id/iu.test(detail)
        ? "malformed-protocol"
        : isTimeout
          ? "rpc-timeout"
          : context.child.signalCode
            ? "process-signal"
            : context.child.exitCode !== null || context.processError
              ? "process-exit"
              : transportFailure.test(primaryDetail)
                ? "transport-closed"
                : "provider-error";
  const message = unsupportedTerminalAuth
    ? "Antigravity ACP advertised unsupported terminal authentication."
    : invalidTerminalAuth
    ? "Antigravity ACP returned an unsupported or invalid terminal authentication descriptor."
    : isSubscriptionRequired
    ? "Google requires an eligible Antigravity subscription for this account."
    : isAuth
    ? "Antigravity is not authenticated. Connect Antigravity in provider settings, then try again."
    : reason === "protocol-overflow"
      ? "Antigravity ACP exceeded Inertia's bounded protocol limits."
      : reason === "malformed-protocol"
        ? "Antigravity ACP returned a malformed protocol message."
        : reason === "rpc-timeout"
          ? "Antigravity ACP stopped responding."
          : reason === "transport-closed"
            ? "The Antigravity ACP connection closed before the turn completed."
            : reason === "process-signal" || reason === "process-exit"
              ? "Antigravity ACP stopped before the turn completed."
              : sanitizeProviderFailureSummary(
                  detail,
                  "Antigravity ACP stopped unexpectedly.",
                  { workspaceRoot: context.workspaceRoot },
                );
  const technicalDetail = sanitizeProviderActivityDetail(detail, {
    workspaceRoot: context.workspaceRoot,
    maxChars: MAX_TECHNICAL_DETAIL_CHARS,
  }) ?? undefined;
  const phase = isAuth ? "auth" : context.phase;
  const terminalEvent = isAuth
    ? context.terminalEvent
    : reason === "protocol-overflow" || reason === "malformed-protocol"
      ? "transport/frame"
      : reason === "transport-closed"
        ? "transport/closed"
        : reason === "process-exit" || reason === "process-signal"
          ? "process/exit"
          : context.terminalEvent;
  const missingSessionCode = acpResumeStep(context.terminalEvent)
    && !namesUnrelatedMissingResource(primaryDetail)
    && (errorCode === RESOURCE_NOT_FOUND_JSON_RPC_CODE || /\bcode:\s*-32002\b/u.test(primaryDetail));
  const sessionUnavailable = !isAuth && !isSubscriptionRequired
    && (acpSessionUnavailable(context.terminalEvent, primaryDetail) || missingSessionCode);
  return {
    reason,
    message,
    phase,
    terminalEvent,
    ...(technicalDetail && technicalDetail !== message
      ? { technicalDetail }
      : {}),
    ...(sessionUnavailable ? { sessionUnavailable: true as const } : {}),
    ...(!isAuth && !isSubscriptionRequired && reason === "provider-error" && acpResumeStep(context.terminalEvent)
      ? { resumeRejected: true as const }
      : {}),
  };
}

export function antigravityErrorDetail(error: unknown, fallback: string): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && !seen.has(current); depth += 1) {
    seen.add(current);
    if (current instanceof Error) {
      if (current.name && current.name !== "Error") parts.push(current.name);
      const code = (current as Error & { code?: unknown }).code;
      if (typeof code === "number" && Number.isInteger(code)) parts.push(`code: ${code}`);
      else if (typeof code === "string" && code) parts.push(`code: ${code}`);
      if (current.message) parts.push(current.message);
      const data = (current as Error & { data?: unknown }).data;
      if (typeof data === "string" && data) {
        parts.push(`data: ${data}`);
      } else {
        const dataRecord = objectValue(data);
        const detail = typeof dataRecord?.details === "string"
          ? dataRecord.details
          : typeof dataRecord?.message === "string"
            ? dataRecord.message
            : undefined;
        if (detail) parts.push(`data: ${detail}`);
      }
      current = current.cause;
      continue;
    }
    if (typeof current === "string") {
      parts.push(current);
      break;
    }
    const record = objectValue(current);
    if (!record) break;
    for (const key of ["name", "code", "message", "data"] as const) {
      const value = record[key];
      if (typeof value === "string" && value) parts.push(`${key}: ${value}`);
      else if (key === "code" && typeof value === "number" && Number.isInteger(value)) {
        parts.push(`code: ${value}`);
      }
    }
    current = record.cause;
  }
  return (parts.join("\n") || fallback).slice(0, MAX_ERROR_DETAIL_CHARS);
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
