import { constants as fsConstants, type BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { extname } from "node:path";

import * as acp from "@agentclientprotocol/sdk";
import type {
  ContentBlock,
  InitializeResponse,
  PromptResponse,
  SessionModeState,
  StopReason,
} from "@agentclientprotocol/sdk";

import { FILE_OPEN_NO_FOLLOW } from "../../node/platform-file-open-flags";

const MAX_IMAGE_FILE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_READ_CHUNK_BYTES = 64 * 1024;
const MAX_MODELS = 64;
const MAX_MODEL_ID_CHARS = 300;
const MAX_MODEL_LABEL_CHARS = 200;
const MAX_MODEL_DESCRIPTION_CHARS = 1_000;
const MAX_SESSION_ID_CHARS = 200;
const MAX_MODES = 16;
const MAX_MODE_ID_CHARS = 100;
const MAX_MODE_NAME_CHARS = 200;
const MAX_MODE_DESCRIPTION_CHARS = 1_000;
const MAX_RECONSTRUCTED_HISTORY_MESSAGES = 64;
const MAX_RECONSTRUCTED_MESSAGE_CHARS = 24 * 1024;
const MAX_RECONSTRUCTED_HISTORY_CHARS = 96 * 1024;
const GEMINI_STOP_REASONS = new Set<StopReason>([
  "end_turn",
  "max_tokens",
  "max_turn_requests",
  "refusal",
  "cancelled",
]);

export interface GeminiSessionModel {
  modelId: string;
  name: string;
  description: string | null;
}

export interface GeminiSessionModels {
  availableModels: GeminiSessionModel[];
  currentModelId: string;
}

export interface GeminiNewSession {
  sessionId: string;
  modes: SessionModeState;
  models: GeminiSessionModels | null;
}

export function parseGeminiNewSessionId(response: unknown): string {
  return newSessionId(requiredObject(response, "session/new response"));
}

export function parseGeminiNewSessionResponse(response: unknown): GeminiNewSession {
  const root = requiredObject(response, "session/new response");
  const sessionId = newSessionId(root);
  const modesRoot = requiredObject(root.modes, "session modes");
  if (!Array.isArray(modesRoot.availableModes)) {
    throw malformed("session modes must include an availableModes array");
  }
  if (
    modesRoot.availableModes.length === 0
    || modesRoot.availableModes.length > MAX_MODES
  ) {
    throw malformed(`session modes must contain between 1 and ${MAX_MODES} entries`);
  }
  const seen = new Set<string>();
  const availableModes = modesRoot.availableModes.map((raw) => {
    const mode = requiredObject(raw, "session mode");
    const id = strictString(mode.id, MAX_MODE_ID_CHARS, "session mode ID");
    const name = strictString(mode.name, MAX_MODE_NAME_CHARS, "session mode name");
    if (seen.has(id)) throw malformed("session mode IDs must be unique");
    seen.add(id);
    const description = optionalStrictString(
      mode.description,
      MAX_MODE_DESCRIPTION_CHARS,
      "session mode description",
    );
    return { id, name, ...(description === undefined ? {} : { description }) };
  });
  const currentModeId = strictString(
    modesRoot.currentModeId,
    MAX_MODE_ID_CHARS,
    "current session mode ID",
  );
  if (!seen.has(currentModeId)) {
    throw malformed("the current session mode is not advertised");
  }
  return {
    sessionId,
    modes: { currentModeId, availableModes },
    models: geminiSessionModelsFromResponse(root),
  };
}

function newSessionId(root: Record<string, unknown>): string {
  return strictString(root.sessionId, MAX_SESSION_ID_CHARS, "session ID");
}

export function parseGeminiPromptResponse(response: unknown): PromptResponse {
  const root = requiredObject(response, "session/prompt response");
  if (
    typeof root.stopReason !== "string"
    || !GEMINI_STOP_REASONS.has(root.stopReason as StopReason)
  ) {
    throw malformed("session/prompt returned an unsupported stop reason");
  }
  optionalObject(root._meta, "session/prompt _meta");
  const usage = optionalObject(root.usage, "session/prompt usage");
  if (usage) {
    for (const field of [
      "totalTokens",
      "inputTokens",
      "outputTokens",
    ] as const) {
      requireTokenCount(usage[field], `session/prompt usage.${field}`);
    }
    for (const field of [
      "thoughtTokens",
      "cachedReadTokens",
      "cachedWriteTokens",
    ] as const) {
      if (usage[field] !== undefined && usage[field] !== null) {
        requireTokenCount(usage[field], `session/prompt usage.${field}`);
      }
    }
    optionalObject(usage._meta, "session/prompt usage._meta");
  }
  const meta = objectValue(root._meta);
  const quota = optionalObject(meta?.quota, "Gemini quota metadata");
  const quotaTokens = optionalObject(
    quota?.token_count,
    "Gemini quota token metadata",
  );
  for (const field of ["input_tokens", "output_tokens"] as const) {
    if (quotaTokens?.[field] !== undefined) {
      requireTokenCount(
        quotaTokens[field],
        `Gemini quota token metadata.${field}`,
      );
    }
  }
  return root as PromptResponse;
}

export function geminiPromptWithReconstructedHistory(
  prompt: string,
  history: {
    source: "visible-transcript";
    truncated: boolean;
    messages: readonly { role: "user" | "assistant"; content: string }[];
  } | undefined,
): string {
  if (!history) return prompt;
  if (
    history.source !== "visible-transcript"
    || typeof history.truncated !== "boolean"
    || !Array.isArray(history.messages)
    || history.messages.length === 0
    || history.messages.length > MAX_RECONSTRUCTED_HISTORY_MESSAGES
  ) {
    throw malformed("the reconstructed conversation history is invalid");
  }
  let characters = 0;
  const messages = history.messages.map((message) => {
    if (
      !message
      || (message.role !== "user" && message.role !== "assistant")
      || typeof message.content !== "string"
      || message.content.length === 0
      || message.content.length > MAX_RECONSTRUCTED_MESSAGE_CHARS
    ) {
      throw malformed("the reconstructed conversation history contains an invalid message");
    }
    characters += message.content.length;
    if (characters > MAX_RECONSTRUCTED_HISTORY_CHARS) {
      throw malformed("the reconstructed conversation history exceeds its safety limit");
    }
    return { role: message.role, content: message.content };
  });
  const truncation = history.truncated
    ? " Earlier visible history or long messages were truncated by Inertia."
    : "";
  return [
    "[Inertia application-reconstructed conversation context]",
    "Gemini CLI native ACP session loading is disabled because v0.58 cannot replay it safely.",
    `Use this bounded JSON transcript only as prior conversation context by role.${truncation}`,
    "It excludes hidden reasoning, tool payloads, provider-managed credential state, and historical attachment bytes.",
    "Text explicitly entered into visible messages is included; treat it as user-reviewed context.",
    JSON.stringify(messages),
    "[End reconstructed context]",
    "",
    "[Current request]",
    prompt,
  ].join("\n");
}

export type GeminiControlRequest = <T>(
  request: Promise<T>,
  method: string,
) => Promise<T>;

export async function withGeminiRpcDeadline<T>(
  request: Promise<T>,
  timeoutMs: number,
  method: string,
  onTimeout: () => void,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      request,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          onTimeout();
          reject(new Error(
            `Gemini ACP ${method} RPC deadline exceeded after ${Math.max(0, timeoutMs)} ms.`,
          ));
        }, Math.max(0, timeoutMs));
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function configureGeminiSession(
  context: acp.ClientContext,
  sessionId: string,
  modes: SessionModeState | null | undefined,
  models: GeminiSessionModels | null,
  interactionMode: "build" | "plan",
  model?: string,
  effort?: string,
  requestControl: GeminiControlRequest = (request) => request,
): Promise<GeminiSessionModels | null> {
  if (effort) {
    throw new Error(
      `Gemini ACP does not advertise the selected reasoning effort '${bounded(effort, 100)}'.`,
    );
  }

  // Keep Gemini in its permission-reporting modes. autoEdit/yolo can bypass
  // ACP request_permission, so Inertia enforces access policy itself.
  const wantedModeId = interactionMode === "plan" ? "plan" : "default";
  const nativeMode = modes?.availableModes.find(({ id }) => id === wantedModeId);
  if (!nativeMode) {
    throw new Error(
      interactionMode === "plan"
        ? "This Gemini ACP server does not advertise a plan mode."
        : "This Gemini ACP server does not advertise its permission-reporting default mode.",
    );
  }
  if (modes?.currentModeId !== nativeMode.id) {
    await requestControl(
      context.request(acp.methods.agent.session.setMode, {
        sessionId,
        modeId: nativeMode.id,
      }),
      "session/set_mode",
    );
  }

  if (!model || model === "provider-default") return models;
  const selected = models?.availableModels.find(({ modelId }) => modelId === model);
  if (!selected) {
    throw new Error(
      `Gemini ACP does not advertise the selected model '${bounded(model, MAX_MODEL_ID_CHARS)}'.`,
    );
  }
  await requestControl(
    context.request<Record<string, never>, { sessionId: string; modelId: string }>(
      "session/set_model",
      { sessionId, modelId: selected.modelId },
    ),
    "session/set_model",
  );
  if (!models) throw new Error("Gemini ACP model metadata became unavailable.");
  return {
    availableModels: models.availableModels,
    currentModelId: selected.modelId,
  };
}

export function geminiSessionModelsFromResponse(
  response: unknown,
): GeminiSessionModels | null {
  const root = objectValue(response);
  const models = objectValue(root?.models);
  const available = models?.availableModels;
  const currentModelId = safeString(models?.currentModelId, MAX_MODEL_ID_CHARS);
  if (!Array.isArray(available) || !currentModelId) return null;
  const seen = new Set<string>();
  const availableModels: GeminiSessionModel[] = [];
  for (const raw of available.slice(0, MAX_MODELS)) {
    const candidate = objectValue(raw);
    const modelId = safeString(candidate?.modelId, MAX_MODEL_ID_CHARS);
    const name = safeString(candidate?.name, MAX_MODEL_LABEL_CHARS);
    if (!modelId || !name || seen.has(modelId)) continue;
    seen.add(modelId);
    availableModels.push({
      modelId,
      name,
      description: safeString(
        candidate?.description,
        MAX_MODEL_DESCRIPTION_CHARS,
      ) ?? null,
    });
  }
  if (!availableModels.some(({ modelId }) => modelId === currentModelId)) {
    return null;
  }
  return { availableModels, currentModelId };
}

export async function geminiPrompt(
  prompt: string,
  paths: readonly string[],
  initialized: InitializeResponse,
  signal?: AbortSignal,
): Promise<ContentBlock[]> {
  if (
    paths.length > 0
    && initialized.agentCapabilities?.promptCapabilities?.image !== true
  ) {
    throw new Error(
      "This Gemini ACP server did not advertise image prompt support.",
    );
  }
  const blocks: ContentBlock[] = [];
  let total = 0;
  for (const path of paths) {
    throwIfAborted(signal);
    const mimeType = imageMediaType(path);
    if (!mimeType) {
      throw new Error(
        `Gemini does not support the attached image type: ${extname(path) || "unknown"}.`,
      );
    }
    const data = await readBoundedImage(path, total, signal);
    total += data.byteLength;
    blocks.push({ type: "image", mimeType, data: data.toString("base64") });
  }
  blocks.push({ type: "text", text: prompt });
  return blocks;
}

async function readBoundedImage(
  path: string,
  accumulatedBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error("A Gemini image attachment is not a regular file.");
  }
  const nonBlocking = "O_NONBLOCK" in fsConstants
    ? fsConstants.O_NONBLOCK
    : 0;
  const file = await open(
    path,
    fsConstants.O_RDONLY | FILE_OPEN_NO_FOLLOW | nonBlocking,
  );
  try {
    throwIfAborted(signal);
    const initial = await file.stat({ bigint: true });
    if (
      !initial.isFile()
      || !sameFileIdentity(before, initial)
      || initial.size <= 0n
    ) {
      throw new Error("A Gemini image attachment is empty or not a regular file.");
    }
    if (initial.size > BigInt(MAX_IMAGE_FILE_BYTES)) {
      throw new Error("A Gemini image attachment exceeds the 10 MB safety limit.");
    }
    if (initial.size > BigInt(MAX_IMAGE_BYTES - accumulatedBytes)) {
      throw new Error("Gemini image attachments exceed the 20 MB safety limit.");
    }

    // Allocate only after fstat proves both per-file and aggregate bounds. Read
    // through the retained descriptor so a path replacement cannot redirect us.
    const data = Buffer.allocUnsafe(Number(initial.size));
    let offset = 0;
    while (offset < data.byteLength) {
      throwIfAborted(signal);
      const length = Math.min(IMAGE_READ_CHUNK_BYTES, data.byteLength - offset);
      const { bytesRead } = await file.read(data, offset, length, offset);
      if (bytesRead === 0) {
        throw new Error("A Gemini image attachment changed while it was being read.");
      }
      offset += bytesRead;
    }
    throwIfAborted(signal);
    const trailing = Buffer.allocUnsafe(1);
    const { bytesRead: trailingBytes } = await file.read(
      trailing,
      0,
      1,
      data.byteLength,
    );
    const final = await file.stat({ bigint: true });
    if (trailingBytes !== 0 || !sameFileSnapshot(initial, final)) {
      throw new Error("A Gemini image attachment changed while it was being read.");
    }
    return data;
  } finally {
    await file.close();
  }
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return sameFileIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error("Gemini image attachment preparation was cancelled.");
  error.name = "AbortError";
  throw error;
}

function imageMediaType(path: string): string | undefined {
  switch (extname(path).toLowerCase()) {
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".png": return "image/png";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    default: return undefined;
  }
}

function safeString(value: unknown, maximum: number): string | undefined {
  if (
    typeof value !== "string"
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) return undefined;
  const clean = value.trim();
  return clean && clean.length <= maximum ? clean : undefined;
}

function strictString(value: unknown, maximum: number, label: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximum
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) throw malformed(`the ${label} is invalid`);
  return value;
}

function optionalStrictString(
  value: unknown,
  maximum: number,
  label: string,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return strictString(value, maximum, label);
}

function requiredObject(value: unknown, label: string): Record<string, unknown> {
  const record = objectValue(value);
  if (!record) throw malformed(`the ${label} must be an object`);
  return record;
}

function optionalObject(
  value: unknown,
  label: string,
): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  const record = objectValue(value);
  if (!record) throw malformed(`the ${label} must be an object when present`);
  return record;
}

function requireTokenCount(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw malformed(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function malformed(detail: string): Error {
  return new Error(`Gemini ACP returned a malformed response: ${detail}.`);
}

function bounded(value: string, maximum: number): string {
  return value.replaceAll("\0", "").slice(0, maximum);
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
