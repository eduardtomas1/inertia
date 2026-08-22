import {
  Bot,
  Check,
  CloudCog,
  Code2,
  Command,
  MousePointer2,
  Star,
  type LucideIcon,
} from "lucide-react";
import type { JSX, KeyboardEvent as ReactKeyboardEvent } from "react";

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

const providerIcons: Readonly<Record<string, LucideIcon>> = {
  codex: Command,
  claude: Bot,
  cursor: MousePointer2,
  opencode: Code2,
};

export function modelSourceRailItemIcon(
  item: ModelSourceRailItem,
): LucideIcon {
  if (item.filter.kind === "favorites") return Star;
  if (item.filter.kind === "provider") {
    return providerIcons[item.filter.providerId] ?? Bot;
  }
  return item.filter.kind === "custom" ? CloudCog : Bot;
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
          const ItemIcon = modelSourceRailItemIcon(item);
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
              <span className="model-source-rail-glyph" aria-hidden="true">
                <ItemIcon size={15} strokeWidth={1.8} />
              </span>
              <span className="model-source-rail-copy">
                <strong>{item.label}</strong>
                {item.detail && <small>{item.detail}</small>}
              </span>
              {selected
                ? (
                    <span className="model-source-rail-selected">
                      <Check size={11} aria-hidden="true" />
                      <span className="visually-hidden">Selected</span>
                    </span>
                  )
                : item.routeCount > 0 && (
                    <small className="model-source-rail-count" aria-hidden="true">
                      {item.routeCount}
                    </small>
                  )}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
