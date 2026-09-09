import {
  Bot,
  CloudCog,
  Star,
  type LucideIcon,
} from "lucide-react";
import type { JSX, KeyboardEvent as ReactKeyboardEvent } from "react";

import { ProviderBrandIcon } from "./ProviderBrandIcon";
import type { ProviderId } from "../../../shared/contracts";
import {
  isModelSourceRailActivationKey,
  type ModelSourceFilter,
  type ModelSourceRailItem,
  type ModelSourceSetupAction,
} from "../utils/modelSourceRail";
import { navigateMenuItems } from "../utils/menuKeyboard";

export interface ModelSourceRailProps {
  items: readonly ModelSourceRailItem[];
  selectedId: string | null;
  onFilterChange: (
    filter: ModelSourceFilter,
    item: ModelSourceRailItem,
  ) => void;
  onSetupAction?: (
    action: ModelSourceSetupAction,
    item: ModelSourceRailItem,
  ) => void;
  label?: string;
  resultsId?: string;
}

export type ModelSourceRailGlyph =
  | { kind: "provider"; providerId: ProviderId }
  | { kind: "icon"; Icon: LucideIcon };

export function modelSourceRailItemGlyph(
  item: ModelSourceRailItem,
): ModelSourceRailGlyph {
  if (item.filter.kind === "favorites") return { kind: "icon", Icon: Star };
  if (item.filter.kind === "provider") {
    return { kind: "provider", providerId: item.filter.providerId };
  }
  return {
    kind: "icon",
    Icon: item.filter.kind === "custom" ? CloudCog : Bot,
  };
}

export function modelSourceRailItemAccessibleLabel(
  item: ModelSourceRailItem,
): string {
  if (item.setupAction) return item.setupAction.label;
  const countLabel = `${item.routeCount} ${item.routeCount === 1 ? "model" : "models"}`;
  if (item.filter.kind === "custom") {
    return `${item.label}, custom backend via ${item.detail?.replace(/^Custom · /u, "") ?? "unknown harness"}, ${countLabel}, profile ${item.filter.backendProfileId}`;
  }
  return `${item.label}, ${countLabel}`;
}

export function activateModelSourceRailItem(
  item: ModelSourceRailItem,
  callbacks: Pick<
    ModelSourceRailProps,
    "onFilterChange" | "onSetupAction"
  >,
): boolean {
  if (item.setupAction) {
    if (!callbacks.onSetupAction) return false;
    callbacks.onSetupAction(item.setupAction, item);
    return true;
  }
  callbacks.onFilterChange(item.filter, item);
  return true;
}

export function ModelSourceRail({
  items,
  selectedId,
  onFilterChange,
  onSetupAction,
  label = "Model sources",
  resultsId,
}: ModelSourceRailProps): JSX.Element {
  const selectedIndex = items.findIndex((item) =>
    item.id === selectedId && item.setupAction === null);
  const firstEnabledIndex = items.findIndex((item) =>
    item.setupAction === null || onSetupAction !== undefined);
  const activate = (item: ModelSourceRailItem): void => {
    activateModelSourceRailItem(item, { onFilterChange, onSetupAction });
  };

  const handleNavigation = (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ): void => navigateMenuItems(
    event,
    "[data-model-source-rail-item]:not(:disabled)",
  );

  return (
    <nav className="model-source-rail" aria-label={label}>
      <div
        className="model-source-rail-toolbar"
        role="toolbar"
        aria-label={`${label} filters`}
        aria-orientation="vertical"
        onKeyDown={handleNavigation}
      >
        {items.map((item, index) => {
          const selected = item.id === selectedId && item.setupAction === null;
          const disabled = item.setupAction !== null && !onSetupAction;
          const glyph = modelSourceRailItemGlyph(item);
          const accessibleLabel = modelSourceRailItemAccessibleLabel(item);
          return (
            <button
              key={item.id}
              type="button"
              className={`model-source-rail-item${selected ? " is-selected" : ""}${item.setupAction ? " is-setup" : ""}`}
              data-model-source-rail-item={item.id}
              aria-label={accessibleLabel}
              aria-pressed={item.setupAction ? undefined : selected}
              aria-controls={item.setupAction ? undefined : resultsId}
              disabled={disabled}
              tabIndex={selectedIndex >= 0
                ? (selected ? 0 : -1)
                : (index === firstEnabledIndex ? 0 : -1)}
              title={accessibleLabel}
              onClick={() => activate(item)}
              onKeyDown={(event) => {
                if (!isModelSourceRailActivationKey(event.nativeEvent)) return;
                event.preventDefault();
                activate(item);
              }}
            >
              <span className="model-source-rail-glyph">
                {glyph.kind === "provider"
                  ? (
                      <ProviderBrandIcon
                        providerId={glyph.providerId}
                        size={16}
                        decorative
                      />
                    )
                  : <glyph.Icon size={15} strokeWidth={1.8} aria-hidden="true" />}
              </span>
              <span className="model-source-rail-mark" aria-hidden="true" />
            </button>
          );
        })}
      </div>
    </nav>
  );
}

export default ModelSourceRail;
