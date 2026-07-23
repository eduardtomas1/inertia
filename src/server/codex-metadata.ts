import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

import type { ProviderModel, ProviderRateLimit, ProviderReasoningOption } from "../shared/contracts";
import { INERTIA_VERSION } from "../shared/version";
import { providerProcessInvocation } from "./provider/process";
import { clampProviderPercent, providerTimestamp } from "./provider/usage-values";

type JsonObject = Record<string, unknown>;

export interface CodexMetadata {
  models?: ProviderModel[];
  rateLimits?: ProviderRateLimit[];
}

interface PendingRequest {
  method: string;
  resolve: (value: JsonObject) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

function objectValue(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function stringValue(value: unknown, maxLength = 1_000): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replaceAll("\0", "").trim();
  return clean ? clean.slice(0, maxLength) : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function titleCase(value: string): string {
  return value.replace(/[-_]+/gu, " ").replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function reasoningOptions(value: unknown): ProviderReasoningOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const option = objectValue(entry);
    const effort = stringValue(option?.reasoningEffort, 40);
    if (!effort) return [];
    return [{
      value: effort,
      label: titleCase(effort),
      description: stringValue(option?.description, 240) ?? `${titleCase(effort)} reasoning`,
    }];
  }).slice(0, 12);
}

export function parseCodexModels(result: JsonObject): ProviderModel[] {
  if (!Array.isArray(result.data)) return [];
  return result.data.flatMap((entry) => {
    const model = objectValue(entry);
    const id = stringValue(model?.model, 160) ?? stringValue(model?.id, 160);
    if (!id || model?.hidden === true) return [];
    const options = reasoningOptions(model?.supportedReasoningEfforts);
    const inputModalities: Array<"text" | "image"> = Array.isArray(model?.inputModalities)
      ? model.inputModalities.filter((value): value is "text" | "image" => value === "text" || value === "image")
      : ["text"];
    return [{
      id,
      label: stringValue(model?.displayName, 120) ?? id,
      description: stringValue(model?.description, 300) ?? "Provider model",
      isDefault: model?.isDefault === true,
      inputModalities,
      reasoningOptions: options,
      defaultReasoningEffort: stringValue(model?.defaultReasoningEffort, 40) ?? options[0]?.value ?? "",
    }];
  }).slice(0, 64);
}

function parseLimitWindow(limitId: string, label: string, suffix: "primary" | "secondary", value: unknown): ProviderRateLimit[] {
  const window = objectValue(value);
  const usedPercent = clampProviderPercent(window?.usedPercent);
  if (usedPercent === null) return [];
  return [{
    id: `${limitId}:${suffix}`,
    label: suffix === "primary" ? label : `${label} · secondary`,
    usedPercent,
    remainingPercent: 100 - usedPercent,
    windowMinutes: numberValue(window?.windowDurationMins) ?? null,
    resetsAt: providerTimestamp(window?.resetsAt),
  }];
}

export function parseCodexRateLimits(result: JsonObject): ProviderRateLimit[] {
  const byId = objectValue(result.rateLimitsByLimitId);
  const fallback = objectValue(result.rateLimits);
  const entries: Array<[string, unknown]> = byId
    ? Object.entries(byId)
    : fallback
      ? [[stringValue(fallback.limitId, 120) ?? "codex", fallback]]
      : [];
  return entries.flatMap(([key, value]) => {
    const limit = objectValue(value);
    if (!limit) return [];
    const id = stringValue(limit.limitId, 120) ?? key;
    const label = stringValue(limit.limitName, 120) ?? (id === "codex" ? "Codex usage" : titleCase(id.replace(/^codex_/u, "")));
    return [
      ...parseLimitWindow(id, label, "primary", limit.primary),
      ...parseLimitWindow(id, label, "secondary", limit.secondary),
    ];
  }).slice(0, 12);
}

export async function readCodexMetadata(
  executable: string,
  environment: NodeJS.ProcessEnv,
  cwd: string,
  timeoutMs = 6_000,
  fields: readonly ("models" | "rateLimits")[] = ["models", "rateLimits"],
): Promise<CodexMetadata> {
  const invocation = providerProcessInvocation(executable, ["app-server"], environment);
  const child: ChildProcessWithoutNullStreams = spawn(invocation.command, invocation.args, {
    cwd,
    env: environment,
    detached: false,
    shell: false,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map<number, PendingRequest>();
  let nextId = 1;
  let closed = false;
  child.stdin.on("error", () => {
    // Spawn/exit handling rejects the active requests with a bounded public error.
  });
  child.stderr.resume();

  const close = (): void => {
    if (closed) return;
    closed = true;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(`${request.method} was interrupted.`));
    }
    pending.clear();
    if (child.exitCode === null && child.signalCode === null) child.kill();
  };

  const request = (method: string, params: JsonObject): Promise<JsonObject> => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out.`));
    }, timeoutMs);
    timer.unref();
    pending.set(id, { method, resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });

  createInterface({ input: child.stdout }).on("line", (line) => {
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { return; }
    const message = objectValue(parsed);
    const id = typeof message?.id === "number" ? message.id : undefined;
    if (id === undefined) return;
    const active = pending.get(id);
    if (!active) return;
    pending.delete(id);
    clearTimeout(active.timer);
    const error = objectValue(message?.error);
    if (error) active.reject(new Error(stringValue(error.message, 500) ?? `${active.method} failed.`));
    else active.resolve(objectValue(message?.result) ?? {});
  });

  const processError = new Promise<never>((_, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (!closed && code !== 0) reject(new Error("Codex metadata process exited early."));
    });
  });

  try {
    await Promise.race([
      request("initialize", {
        clientInfo: { name: "inertia", title: "Inertia", version: INERTIA_VERSION },
        capabilities: { experimentalApi: true, requestAttestation: false },
      }),
      processError,
    ]);
    child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    const readModels = async (): Promise<ProviderModel[]> => {
      const models: ProviderModel[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 4; page += 1) {
        const result = await request("model/list", { limit: 100, ...(cursor ? { cursor } : {}) });
        if (!Array.isArray(result.data)) throw new Error("model/list returned malformed data.");
        models.push(...parseCodexModels(result));
        cursor = stringValue(result.nextCursor, 512) ?? null;
        if (!cursor || models.length >= 256) break;
      }
      return models.slice(0, 256);
    };
    const [modelsResult, limitsResult] = await Promise.all([
      fields.includes("models") ? readModels().catch(() => undefined) : Promise.resolve(undefined),
      fields.includes("rateLimits")
        ? request("account/rateLimits/read", {}).then(parseCodexRateLimits).catch(() => undefined)
        : Promise.resolve(undefined),
    ]);
    return {
      ...(modelsResult === undefined ? {} : { models: modelsResult }),
      ...(limitsResult === undefined ? {} : { rateLimits: limitsResult }),
    };
  } finally {
    close();
  }
}
