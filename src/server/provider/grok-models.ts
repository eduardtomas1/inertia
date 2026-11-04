import type { ProviderModel } from "../../shared/contracts";

const GROK_STATIC_MODELS = [
  ["grok-4.7", "Grok 4.7", "Default Grok Build model", true],
  ["grok-4.7-build-fast", "Grok 4.7 Build Fast", "Faster Grok Build model", false],
  ["grok-4.6", "Grok 4.6", "Previous Grok Build model", false],
  ["grok-4.5", "Grok 4.5", "Earlier Grok Build model", false],
] as const;

export function grokStaticModels(): ProviderModel[] {
  return GROK_STATIC_MODELS.map(([id, label, description, isDefault]) => ({
    id,
    label,
    description,
    isDefault,
    inputModalities: ["text"],
    reasoningOptions: [],
    defaultReasoningEffort: "",
  }));
}
