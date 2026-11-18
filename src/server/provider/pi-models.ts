import type { ProviderModel } from "../../shared/contracts";
import { objectValue } from "../codex/protocol";
import type { ProviderUsageEvent } from "./contracts";
import { piLaunchConfiguration, piRpcArguments } from "./pi-launch";
import { openPiRpcConnection } from "./pi-rpc";
import { AcpSecretRedactor } from "./acp-redaction";

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function piModels(value: unknown, selected?: unknown): ProviderModel[] {
  const models = objectValue(value)?.models;
  const current = objectValue(selected);
  if (!Array.isArray(models) || models.length > 2_000) throw new Error("Pi returned an invalid model catalog.");
  const seen = new Set<string>();
  return models.map((item): ProviderModel => {
    const model = objectValue(item);
    if (!model || typeof model.provider !== "string" || !model.provider || model.provider.includes("/")
      || typeof model.id !== "string" || !model.id || model.id.length > 400) throw new Error("Pi returned an invalid model identity.");
    const id = `${model.provider}/${model.id}`;
    if (id.length > 512 || /[\u0000-\u001f]/u.test(id) || seen.has(id)) throw new Error("Pi returned duplicate or invalid models.");
    seen.add(id);
    const map = objectValue(model.thinkingLevelMap);
    const levels = model.reasoning === true ? LEVELS.filter((level) => map?.[level] !== null
      && (!["xhigh", "max"].includes(level) || map?.[level] !== undefined)) : ["off"];
    return {
      id, label: typeof model.name === "string" ? model.name.slice(0, 200) : id,
      description: `Pi · ${model.provider}`, isDefault: current?.provider === model.provider && current.id === model.id,
      inputModalities: Array.isArray(model.input) && model.input.includes("image") ? ["text", "image"] : ["text"],
      reasoningOptions: levels.map((level) => ({ value: level, label: level, description: "" })),
      defaultReasoningEffort: "off", fastMode: null, reasoningObserved: true,
    };
  });
}

function tokens(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function piUsage(value: unknown): ProviderUsageEvent["usage"] {
  const stats = objectValue(value); const usage = objectValue(stats?.tokens); const context = objectValue(stats?.contextUsage);
  return {
    usedTokens: tokens(context?.tokens), maxTokens: tokens(context?.contextWindow),
    totalProcessedTokens: tokens(usage?.total), totalProcessedScope: "session",
    inputTokens: tokens(usage?.input), outputTokens: tokens(usage?.output),
    cachedInputTokens: tokens(usage?.cacheRead), cacheWriteInputTokens: tokens(usage?.cacheWrite),
    reasoningOutputTokens: null, compactsAutomatically: null,
  };
}

export async function readPiModels(executable: string, environment: NodeJS.ProcessEnv, cwd: string,
  options: { signal?: AbortSignal } = {}): Promise<ProviderModel[]> {
  const config = piLaunchConfiguration(environment, executable);
  // Discovery never loads explicitly configured extension code or project resources.
  const connection = openPiRpcConnection({ executable: config.executable, environment, cwd, signal: options.signal,
    args: piRpcArguments({ ...config, args: [] }, { ephemeral: true }), timeoutMs: 10_000 });
  try {
    const state = objectValue(await connection.request("get_state"));
    const redact = new AcpSecretRedactor(environment);
    return piModels(await connection.request("get_available_models"), state?.model)
      .filter((model) => redact.payload(model.id) === model.id).map((model) => redact.payload(model));
  } finally { await connection.close(); }
}
