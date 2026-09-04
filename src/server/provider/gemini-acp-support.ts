import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { parseAcpSessionNotification, validAcpJsonRpcEnvelope } from "./acp-json-rpc";
import { Transform, type TransformCallback } from "node:stream";

import {
  sanitizeProviderActivityDetail,
  sanitizeProviderFailureSummary,
} from "./activity-detail";
import type { ProviderRunFailure } from "./contracts";
import type { ProviderRunEventBudget } from "./io";

const MAX_ERROR_DETAIL_CHARS = 1024 * 1024;
const MAX_TECHNICAL_DETAIL_CHARS = 16 * 1024;
const MAX_STOP_REASON_CHARS = 160;

export class BoundedGeminiJsonLineTransform extends Transform {
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
      throw new Error("Gemini ACP sent an oversized JSON-RPC frame.");
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
    if (lineBytes === 0) return;
    const parsed: unknown = JSON.parse(line);
    if (!validAcpJsonRpcEnvelope(parsed)) {
      throw new Error("Gemini ACP sent a malformed JSON-RPC frame.");
    }
    if ((parsed as { method?: unknown }).method === "session/update") {
      parseAcpSessionNotification((parsed as { params?: unknown }).params);
    }
    this.eventBudget.observeBytes(lineBytes);
    this.push(`${line}\n`);
  }
}

export async function observeGeminiProcessExit(
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

export function geminiSpawnFailure(
  error: unknown,
  workspaceRoot: string,
  sanitize?: (value: string) => string,
): ProviderRunFailure {
  const detail = geminiErrorDetail(
    error,
    "Gemini ACP could not be started.",
    sanitize,
  );
  const technicalDetail = sanitizeProviderActivityDetail(detail, {
    workspaceRoot,
    maxChars: MAX_TECHNICAL_DETAIL_CHARS,
  }) ?? undefined;
  return {
    reason: "process-exit",
    message: "Gemini ACP could not be started.",
    phase: "spawn",
    terminalEvent: "process/spawn",
    ...(technicalDetail ? { technicalDetail } : {}),
  };
}

export function geminiStopFailure(stopReason: string): ProviderRunFailure {
  const safeStopReason = stopReason.slice(0, MAX_STOP_REASON_CHARS);
  return {
    reason: "provider-error",
    message: `Gemini stopped with reason: ${safeStopReason}.`,
    technicalDetail: `Stop reason: ${safeStopReason}`,
    phase: "turn",
    terminalEvent: `session/prompt:${safeStopReason}`,
  };
}

export interface GeminiRuntimeFailureContext {
  child: ChildProcessWithoutNullStreams;
  processError?: Error;
  wireError?: Error;
  diagnostic: string;
  phase: string;
  terminalEvent: string;
  workspaceRoot: string;
}

export function geminiRuntimeFailure(
  error: unknown,
  context: GeminiRuntimeFailureContext,
): ProviderRunFailure {
  const detail = [
    geminiErrorDetail(error, "Gemini ACP stopped unexpectedly."),
    context.wireError
      ? geminiErrorDetail(context.wireError, "Gemini ACP wire error.")
      : "",
    context.processError
      ? geminiErrorDetail(context.processError, "Gemini ACP process error.")
      : "",
    context.diagnostic,
  ].filter(Boolean).join("\n");
  const isAuth = /auth_required|not authenticated|authentication required|login required|unauthorized|gemini api key is missing or not configured/iu
    .test(detail);
  const unsupportedTerminalAuth = /advertised terminal authentication without client terminal support/iu
    .test(detail);
  const rejectedLocalConfiguration = /does not advertise (?:the selected reasoning effort|the selected model|a plan mode|its permission-reporting default mode)|did not advertise image prompt support|does not support the attached image type/iu
    .test(detail);
  const reason: ProviderRunFailure["reason"] = unsupportedTerminalAuth
    ? "provider-error"
    : isAuth
    ? "provider-error"
    : rejectedLocalConfiguration
      ? "provider-error"
    : /oversized|bounded (?:approval|input|tool activity|event|protocol)|safety limit|more than \d+ input options/iu.test(detail)
      ? "protocol-overflow"
      : /malformed|unexpected token|json-rpc frame|protocol version|not gemini cli|required session\/load capability|invalid .* identity|invalid utf|not valid.*utf-?8|did not return a session id|replayed session history/iu.test(detail)
        ? "malformed-protocol"
        : /timed out|timeout|deadline|stopped responding/iu.test(detail)
          ? "rpc-timeout"
          : context.child.signalCode
            ? "process-signal"
            : context.child.exitCode !== null || context.processError
              ? "process-exit"
              : /stream (?:was )?closed|connection (?:was )?closed|transport|end of (?:file|stream)|\beof\b|epipe|econnreset|broken pipe/iu.test(detail)
                ? "transport-closed"
                : "provider-error";
  const message = unsupportedTerminalAuth
    ? "Gemini ACP advertised unsupported terminal authentication."
    : isAuth
    ? "Gemini CLI is not authenticated. Run 'gemini' to connect an account and try again."
    : reason === "protocol-overflow"
      ? "Gemini ACP exceeded Inertia's bounded protocol limits."
      : reason === "malformed-protocol"
        ? "Gemini ACP returned a malformed protocol message."
        : reason === "rpc-timeout"
          ? "Gemini ACP stopped responding."
          : reason === "transport-closed"
            ? "The Gemini ACP connection closed before the turn completed."
            : reason === "process-signal" || reason === "process-exit"
              ? "Gemini ACP stopped before the turn completed."
              : sanitizeProviderFailureSummary(
                  detail,
                  "Gemini ACP stopped unexpectedly.",
                  { workspaceRoot: context.workspaceRoot },
                );
  const technicalDetail = sanitizeProviderActivityDetail(detail, {
    workspaceRoot: context.workspaceRoot,
    maxChars: MAX_TECHNICAL_DETAIL_CHARS,
  }) ?? undefined;
  const phase = isAuth ? "auth" : context.phase;
  const terminalEvent = isAuth
    ? "session/new:auth"
    : reason === "protocol-overflow" || reason === "malformed-protocol"
      ? "transport/frame"
      : reason === "transport-closed"
        ? "transport/closed"
        : reason === "process-exit" || reason === "process-signal"
          ? "process/exit"
          : context.terminalEvent;
  return {
    reason,
    message,
    phase,
    terminalEvent,
    ...(technicalDetail && technicalDetail !== message
      ? { technicalDetail }
      : {}),
  };
}

export function geminiErrorDetail(
  error: unknown,
  fallback: string,
  sanitize: (value: string) => string = (value) => value,
): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && !seen.has(current); depth += 1) {
    seen.add(current);
    if (current instanceof Error) {
      if (current.name && current.name !== "Error") parts.push(current.name);
      if (current.message) parts.push(current.message);
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
    }
    current = record.cause;
  }
  return sanitize(parts.join("\n") || fallback).slice(
    0,
    MAX_ERROR_DETAIL_CHARS,
  );
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
