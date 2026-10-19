import type { ProviderId } from "../../src/shared/provider";
import type { RoutingProviderSource } from "../../src/shared/routing/routing-catalog";

export type ModelSpec = [id: string, label: string, efforts?: string[], options?: { isDefault?: boolean; fast?: string; vision?: boolean; defaultEffort?: string }];

export function routingProvider(id: ProviderId, models: ModelSpec[], overrides: Partial<RoutingProviderSource> = {}): RoutingProviderSource {
  return {
    id,
    label: id[0]!.toUpperCase() + id.slice(1),
    available: true,
    installState: "installed",
    authState: "authenticated",
    canRun: true,
    rateLimits: [],
    models: models.map(([modelId, label, efforts = [], options = {}]) => ({
      id: modelId,
      label,
      isDefault: options.isDefault ?? false,
      inputModalities: options.vision === false ? ["text"] : ["text", "image"],
      reasoningOptions: efforts.map((value) => ({ value })),
      defaultReasoningEffort: options.defaultEffort ?? (efforts.includes("medium") ? "medium" : efforts[0] ?? ""),
      fastMode: options.fast ? { providerValue: options.fast } : null,
    })),
    ...overrides,
  };
}

export const CODEX = routingProvider("codex", [
  ["gpt-5.6", "GPT-5.6", ["low", "medium", "high", "xhigh"], { isDefault: true, fast: "priority" }],
  ["gpt-5.4-mini", "GPT-5.4 Mini", ["low", "medium", "high"]],
  ["gpt-6.1-sol", "GPT-6.1 Sol", ["low", "medium", "high", "xhigh"]],
]);
export const CLAUDE = routingProvider("claude", [
  ["claude-sonnet-5", "Claude Sonnet 5", ["low", "medium", "high"], { isDefault: true, fast: "fast" }],
  ["claude-opus-5-5", "Claude Opus 5.5", ["low", "medium", "high", "max"]],
  ["claude-haiku-4-5", "Claude Haiku 4.5", ["low", "medium"]],
  ["claude-fable-5", "Claude Fable 5", ["low", "medium", "high", "xhigh", "max"]],
]);
export const CURSOR = routingProvider("cursor", [
  ["auto", "Auto", [], { isDefault: true }],
  ["composer-2", "Composer 2"],
  ["gpt-5.1-codex", "GPT-5.1 Codex"],
  ["claude-opus", "Claude Opus"],
]);
export const KIMI = routingProvider("kimi", [["kimi-for-coding", "Kimi for Coding", [], { isDefault: true }]]);
export const OPENCODE = routingProvider("opencode", [
  ["anthropic/claude-sonnet-4-5", "Claude Sonnet 4.5", [], { isDefault: true }],
  ["openai/gpt-5-nano", "GPT-5 Nano"],
  ["google/gemini-2.5-pro", "Gemini 2.5 Pro"],
]);
export const ANTIGRAVITY = routingProvider("antigravity", [
  ["gemini-3-pro", "Gemini 3 Pro", ["low", "high"], { isDefault: true, vision: false, defaultEffort: "high" }],
  ["gemini-3-flash", "Gemini 3 Flash", ["low", "high"], { vision: false }],
]);
