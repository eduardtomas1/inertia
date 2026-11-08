import type { ProviderModel } from "../../shared/contracts";

const EFFORTS = [
  ["xhigh", "Extra High", "Maximum reasoning for the hardest tasks."],
  ["high", "High", "Thorough reasoning and quality. Recommended."],
  ["medium", "Medium", "Strong quality with a faster turnaround."],
  ["low", "Low", "Fastest responses. Best for simple tasks."],
] as const;

const GROK_STATIC_MODELS = [
  ["grok-4.7", "Grok 4.7", "Default Grok Build model", true, true],
  ["grok-4.7-build-fast", "Grok 4.7 Fast", "Faster Grok 4.7 at a higher price", false, true],
  ["grok-4.6", "Grok 4.6", "Previous Grok Build model", false, true],
  ["grok-4.5", "Grok 4.5", "Earlier Grok Build model", false, false],
] as const;

export function grokStaticModels(): ProviderModel[] {
  return GROK_STATIC_MODELS.map(([id, label, description, isDefault, extraHigh]) => ({
    id,
    label,
    description,
    isDefault,
    inputModalities: ["text", "image"],
    reasoningOptions: EFFORTS
      .filter(([value]) => extraHigh || value !== "xhigh")
      .map(([value, effortLabel, effortDescription]) => ({
        value,
        label: effortLabel,
        description: effortDescription,
      })),
    defaultReasoningEffort: "high",
  }));
}
