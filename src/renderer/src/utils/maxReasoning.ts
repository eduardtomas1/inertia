import type { ComposerResolvedModel } from "./composerRouteState";

// Provider catalogs need not be ordered (OpenCode variants are record keys).
// Only rank actual reasoning levels, never arbitrary named model variants.
const LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

export function isMaximumReasoning(
  model: Pick<ComposerResolvedModel, "reasoningOptions" | "defaultReasoningEffort"> | undefined,
  selected: string | null | undefined,
): boolean {
  if (!model) return false;
  const normalize = (value: string): string => value.trim().toLowerCase();
  const levels = model.reasoningOptions.map(({ value }) => normalize(value));
  const offered = LEVELS.filter((value) => levels.includes(value));
  const highest = offered.at(-1);
  return offered.length > 1
    && highest !== undefined
    && LEVELS.indexOf(highest) >= LEVELS.indexOf("high")
    && normalize(selected ?? model.defaultReasoningEffort) === highest;
}
