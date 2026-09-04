import type { ProviderModel, ProviderRateLimit, ProviderReasoningOption } from "../shared/contracts";
import {
  type ProcessTreeTerminator,
} from "./process-lifecycle";
import { clampProviderPercent, providerTimestamp } from "./provider/usage-values";
import {
  CODEX_CONTROL_MAX_FRAME_BYTES,
  CODEX_CONTROL_MAX_PROTOCOL_BYTES,
  withCodexControlClient,
} from "./codex/control-client";

type JsonObject = Record<string, unknown>;

export const CODEX_METADATA_MAX_FRAME_BYTES = CODEX_CONTROL_MAX_FRAME_BYTES;
export const CODEX_METADATA_MAX_PROTOCOL_BYTES =
  CODEX_CONTROL_MAX_PROTOCOL_BYTES;

export interface CodexMetadata {
  models?: ProviderModel[];
  rateLimits?: ProviderRateLimit[];
}

export interface CodexMetadataDependencies {
  terminateProcessTree?: ProcessTreeTerminator;
  signal?: AbortSignal;
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

function codexFastMode(model: JsonObject): ProviderModel["fastMode"] {
  if (!Array.isArray(model.serviceTiers)) return null;
  const tier = model.serviceTiers.find((entry) => {
    const candidate = objectValue(entry);
    return stringValue(candidate?.id, 40) === "priority"
      && stringValue(candidate?.name, 40)?.toLowerCase() === "fast";
  });
  if (!tier) return null;
  return {
    providerValue: "priority",
    label: "Fast",
    description: "Faster responses with increased usage.",
    isDefault: stringValue(model.defaultServiceTier, 40) === "priority",
  };
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
      fastMode: codexFastMode(model ?? {}),
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
  dependencies: CodexMetadataDependencies = {},
): Promise<CodexMetadata> {
  return await withCodexControlClient({
    executable,
    environment,
    cwd,
    timeoutMs,
    processLabel: "Codex metadata process tree",
    signal: dependencies.signal,
    ...(dependencies.terminateProcessTree
      ? { terminateProcessTree: dependencies.terminateProcessTree }
      : {}),
  }, async ({ request }) => {
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
  });
}
