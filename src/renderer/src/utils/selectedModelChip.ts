import { legacyProviderIdForHarness } from "../../../shared/model-routing";
import type { ModelSearchRoute } from "./modelSearch";

export type SelectedModelChipGlyph =
  | "codex"
  | "claude"
  | "cursor"
  | "opencode"
  | "custom"
  | "unknown";

export type SelectedModelChipRoute = Pick<
  ModelSearchRoute,
  | "alias"
  | "backendConfigurationRevision"
  | "backendProfileId"
  | "backendProfileName"
  | "displayName"
  | "harnessId"
  | "harnessLabel"
  | "key"
  | "modelId"
  | "reasoningEffort"
  | "source"
>;

export interface SelectedModelChipIdentity {
  routeKey: string;
  source: "built-in" | "custom";
  label: string;
  glyph: SelectedModelChipGlyph;
  /** Exact route identity retained for mouse users without crowding the chip. */
  title: string;
  /** Action plus exact current route identity for assistive technology. */
  accessibleName: string;
}
function cleanLabel(value: string | null | undefined): string | null {
  const cleaned = value?.trim();
  return cleaned ? cleaned : null;
}

export function selectedModelChipLabel(
  route: Pick<SelectedModelChipRoute, "alias" | "displayName" | "modelId">,
): string {
  if (route.modelId === "provider-default") return "Provider default";
  return cleanLabel(route.displayName)
    ?? cleanLabel(route.alias)
    ?? route.modelId;
}

export function selectedModelChipGlyph(
  route: Pick<SelectedModelChipRoute, "harnessId" | "source">,
): SelectedModelChipGlyph {
  if (route.source === "custom") return "custom";
  return legacyProviderIdForHarness(route.harnessId) ?? "unknown";
}

function labeledIdentity(label: string, id: string): string {
  return label === id ? id : `${label} (${id})`;
}

/**
 * Keeps the chip visually compact while retaining the exact persisted
 * harness/backend/model tuple in its title and accessible name. providerLabel
 * is deliberately absent from the input contract so a custom backend cannot
 * be presented as the harness vendor.
 */
export function selectedModelChipIdentity(
  route: SelectedModelChipRoute,
): SelectedModelChipIdentity {
  const label = selectedModelChipLabel(route);
  const harness = labeledIdentity(
    cleanLabel(route.harnessLabel) ?? route.harnessId,
    route.harnessId,
  );
  const backend = labeledIdentity(
    cleanLabel(route.backendProfileName) ?? route.backendProfileId,
    route.backendProfileId,
  );
  const model = labeledIdentity(label, route.modelId);
  const reasoning = cleanLabel(route.reasoningEffort) ?? "Provider default";
  const exactIdentity = route.source === "custom"
    ? `Custom backend ${backend} via ${harness} · Model ${model} · Reasoning ${reasoning}`
    : `${harness} · ${backend} · Model ${model} · Reasoning ${reasoning}`;

  return {
    routeKey: route.key,
    source: route.source,
    label,
    glyph: selectedModelChipGlyph(route),
    title: `Current model: ${exactIdentity}`,
    accessibleName: `Choose model. Current selection: ${exactIdentity}.`,
  };
}
