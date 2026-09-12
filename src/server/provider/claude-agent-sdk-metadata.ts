import {
  query as claudeQuery,
  type Query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import type { ProviderModel, ProviderRateLimit } from "../../shared/contracts";
import {
  createClaudeOwnedQueryProcess,
  type ClaudeOwnedQueryDependencies,
} from "./claude-owned-query";
import type { ClaudeQueryFactory } from "./claude-skill-query";
import { CLAUDE_ISOLATED_SKILL_SETTINGS } from "./claude-skill-plugin";
import { clampProviderPercent, providerTimestamp } from "./usage-values";

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function claudeModels(
  models: Awaited<ReturnType<Query["supportedModels"]>>,
): ProviderModel[] {
  return models.slice(0, 64).map((model, index) => {
    const efforts = model.supportedEffortLevels ?? [];
    return {
      id: model.value,
      label: model.displayName || model.value,
      description: model.description || "Claude model",
      isDefault: index === 0,
      inputModalities: ["text", "image"],
      reasoningOptions: efforts.map((effort) => ({
        value: effort,
        label: effort === "xhigh" ? "Extra high" : `${effort[0]?.toUpperCase() ?? ""}${effort.slice(1)}`,
        description: `${effort === "xhigh" ? "Extra-high" : effort} reasoning effort`,
      })),
      defaultReasoningEffort: efforts.includes("high") ? "high" : efforts[0] ?? "",
      fastMode: model.supportsFastMode === true
        ? {
            providerValue: "fast",
            label: "Fast",
            description: "Faster output with premium usage.",
            isDefault: false,
          }
        : null,
    };
  });
}

export function parseClaudeRateLimits(value: unknown): ProviderRateLimit[] {
  const response = objectValue(value);
  if (response?.rate_limits_available !== true) return [];
  const limits = objectValue(response.rate_limits);
  if (!limits) return [];
  const windows: Array<{
    key: string;
    label: string;
    minutes: number | null;
    value: unknown;
  }> = [
    { key: "five_hour", label: "Claude · 5 hour", minutes: 300, value: limits.five_hour },
    { key: "seven_day", label: "Claude · 7 day", minutes: 10_080, value: limits.seven_day },
    { key: "seven_day_oauth_apps", label: "Claude apps · 7 day", minutes: 10_080, value: limits.seven_day_oauth_apps },
    { key: "seven_day_opus", label: "Claude Opus · 7 day", minutes: 10_080, value: limits.seven_day_opus },
    { key: "seven_day_sonnet", label: "Claude Sonnet · 7 day", minutes: 10_080, value: limits.seven_day_sonnet },
  ];
  const modelScoped = Array.isArray(limits.model_scoped) ? limits.model_scoped : [];
  modelScoped.slice(0, 8).forEach((entry, index) => {
    const model = objectValue(entry);
    windows.push({
      key: `model_${index}`,
      label: stringValue(model?.display_name) ?? `Claude model ${index + 1}`,
      minutes: 10_080,
      value: model,
    });
  });
  return windows.flatMap((window) => {
    const current = objectValue(window.value);
    const utilization = clampProviderPercent(current?.utilization);
    if (utilization === null) return [];
    return [{
      id: `claude:${window.key}`,
      label: window.label,
      usedPercent: utilization,
      remainingPercent: 100 - utilization,
      windowMinutes: window.minutes,
      resetsAt: providerTimestamp(current?.resets_at),
    }];
  }).slice(0, 12);
}

/**
 * Distinguishes "Claude answered and reported no limits for this account"
 * from a failed or malformed read (#344). Only explicit false can replace
 * cached quota windows with confirmed unavailability.
 */
export function claudeRateLimitReadResult(
  value: unknown,
): { rateLimits: ProviderRateLimit[]; rateLimitsUnavailable?: true } {
  return objectValue(value)?.rate_limits_available === false
    ? { rateLimits: [], rateLimitsUnavailable: true }
    : { rateLimits: parseClaudeRateLimits(value) };
}

export async function readClaudeAgentSdkMetadata(
  executable: string,
  environment: NodeJS.ProcessEnv,
  cwd: string,
  timeoutMs = 6_000,
  createQuery: ClaudeQueryFactory = claudeQuery,
  fields: readonly ("models" | "rateLimits")[] = ["models", "rateLimits"],
  lifecycleDependencies: ClaudeOwnedQueryDependencies = {},
  signal?: AbortSignal,
): Promise<{
  models?: ProviderModel[];
  rateLimits?: ProviderRateLimit[];
  rateLimitsUnavailable?: boolean;
}> {
  if (signal?.aborted) {
    throw new Error("Claude metadata discovery was cancelled.");
  }
  const abortController = new AbortController();
  const ownedProcess = createClaudeOwnedQueryProcess(
    "Claude metadata process tree",
    lifecycleDependencies,
  );
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  async function* dormantPrompt(): AsyncIterable<SDKUserMessage> {
    await hold;
    yield* [] as SDKUserMessage[];
  }
  let query: Query | undefined;
  let metadata: Awaited<ReturnType<typeof readClaudeAgentSdkMetadata>> = {};
  let completed = false;
  let timer: NodeJS.Timeout | undefined;
  let rejectCancelled!: (error: Error) => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    rejectCancelled = reject;
  });
  const cancel = (): void => {
    abortController.abort();
    rejectCancelled(new Error("Claude metadata discovery was cancelled."));
  };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  try {
    query = createQuery({
      prompt: dormantPrompt(),
      options: {
        abortController,
        cwd,
        env: environment,
        pathToClaudeCodeExecutable: executable,
        spawnClaudeCodeProcess: ownedProcess.spawnClaudeCodeProcess,
        settingSources: [],
        managedSettings: CLAUDE_ISOLATED_SKILL_SETTINGS,
      },
    });
    const usageReader = query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        abortController.abort();
        reject(new Error("Claude metadata discovery timed out."));
      }, timeoutMs);
      timer.unref();
    });
    const [modelsResult, limitsResult] = await Promise.race([
      Promise.allSettled([
        fields.includes("models") ? query.supportedModels() : Promise.resolve(undefined),
        fields.includes("rateLimits") && typeof usageReader === "function"
          ? usageReader.call(query)
          : Promise.resolve(undefined),
      ]),
      timeout,
      cancelled,
    ]);
    metadata = {
      ...(modelsResult.status === "fulfilled" && modelsResult.value !== undefined ? { models: claudeModels(modelsResult.value) } : {}),
      ...(limitsResult.status === "fulfilled" && limitsResult.value !== undefined ? claudeRateLimitReadResult(limitsResult.value) : {}),
    };
    // Ordinary SDK control errors may yield partial metadata. Every request
    // has settled here, so these also finish through EOF instead of a stop.
    completed = true;
  } finally {
    if (timer) clearTimeout(timer);
    if (completed && !abortController.signal.aborted && !ownedProcess.transportError()) {
      // A successful metadata query has no prompt to cancel. Let the SDK
      // send EOF and the provider finish before asking its guardian to stop.
      // Match the pinned SDK's bounded two-second normal-close window.
      release();
      try { query?.close(); } catch { /* The final owned barrier still proves cleanup. */ }
      await ownedProcess.waitForNaturalClose(2_000, signal);
    }
    signal?.removeEventListener("abort", cancel);
    ownedProcess.requestTermination(true);
    release();
    abortController.abort();
    try { query?.close(); } catch { /* The metadata subprocess may already have exited. */ }
    await ownedProcess.terminate(true);
  }
  if (ownedProcess.transportError()) throw ownedProcess.transportError();
  if (signal?.aborted) throw new Error("Claude metadata discovery was cancelled.");
  return metadata;
}

export async function readClaudeAgentSdkModels(
  executable: string,
  environment: NodeJS.ProcessEnv,
  cwd: string,
  timeoutMs = 6_000,
  createQuery: ClaudeQueryFactory = claudeQuery,
  lifecycleDependencies: ClaudeOwnedQueryDependencies = {},
): Promise<ProviderModel[]> {
  return (await readClaudeAgentSdkMetadata(
    executable,
    environment,
    cwd,
    timeoutMs,
    createQuery,
    ["models"],
    lifecycleDependencies,
  )).models ?? [];
}
