import {
  memo,
  useId,
  type JSX,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { Check, Star } from "lucide-react";

import type { ModelSearchRoute } from "../utils/modelSearch";

export type ModelChooserCompatibilityState = "verified" | "partial" | "unknown";

export interface ModelChooserSelectionCompatibility {
  /**
   * Compatibility is only surfaced when it changes what selecting this route
   * can do. Informational capability metadata belongs in route details.
   */
  affectsSelection: boolean;
  state: ModelChooserCompatibilityState;
  explanation: string | null;
}

export interface ModelChooserRowShortcut {
  /** Stable, platform-formatted label from modelShortcuts.ts. */
  label: string;
  /** WAI-ARIA key syntax, for example "Meta+1" or "Control+1". */
  ariaKeyShortcuts: string;
}

interface ModelChooserRowBase {
  key: string;
  displayName: string;
  modelId: string;
  reasoningEffort: string | null;
  harnessLabel: string;
  backendProfileName: string;
  source: "built-in" | "custom";
  active: boolean;
  favorite: boolean;
  shortcut: ModelChooserRowShortcut | null;
  compatibility: ModelChooserSelectionCompatibility | null;
}

export type ModelChooserRowData = ModelChooserRowBase & (
  | { selectable: true; disabledReason: null }
  | { selectable: false; disabledReason: string }
);

export interface ModelChooserRowState {
  active: boolean;
  favorite: boolean;
  shortcut?: ModelChooserRowShortcut | null;
  compatibility?: ModelChooserSelectionCompatibility | null;
}

export interface ModelChooserRowProps {
  row: ModelChooserRowData;
  /** Stable ID for searchbox aria-activedescendant; generated when omitted. */
  optionId?: string;
  /** Result-action tab index; search owns ordinary chooser navigation. */
  tabIndex?: 0 | -1;
  onSelect: (row: ModelChooserRowData) => void;
  onFavoriteToggle?: (row: ModelChooserRowData) => void;
}

export interface ModelChooserFavoriteButtonProps {
  row: ModelChooserRowData;
  onFavoriteToggle: (row: ModelChooserRowData) => void;
}

const compatibilityLabels: Readonly<Record<ModelChooserCompatibilityState, string>> = {
  verified: "Verified",
  partial: "Partial",
  unknown: "Unknown",
};

/**
 * Adapts the completed search contract without accepting providerLabel.
 * Custom routes therefore cannot accidentally inherit an official-provider
 * identity in the result row.
 */
export function modelChooserRowFromRoute(
  route: ModelSearchRoute,
  state: ModelChooserRowState,
): ModelChooserRowData {
  const disabledReason = route.selectable ? null : route.unavailableReason?.trim() || null;
  if (!route.selectable && !disabledReason) {
    throw new Error("A disabled model chooser row requires a compatibility explanation.");
  }
  const base: ModelChooserRowBase = {
    key: route.key,
    displayName: route.displayName,
    modelId: route.modelId,
    reasoningEffort: route.reasoningEffort ?? null,
    harnessLabel: route.harnessLabel,
    backendProfileName: route.backendProfileName,
    source: route.source,
    active: state.active,
    favorite: state.favorite,
    shortcut: state.shortcut ?? null,
    compatibility: state.compatibility ?? null,
  };
  return route.selectable
    ? { ...base, selectable: true, disabledReason: null }
    : { ...base, selectable: false, disabledReason: disabledReason! };
}

export function modelChooserSecondaryIdentity(
  row: Pick<
    ModelChooserRowData,
    "harnessLabel" | "backendProfileName" | "reasoningEffort"
  >,
): string {
  return [
    row.harnessLabel,
    row.backendProfileName,
    row.reasoningEffort
      ? `${row.reasoningEffort} reasoning`
      : "Provider default reasoning",
  ].join(" · ");
}

export function modelChooserShowsRawModelId(
  row: Pick<ModelChooserRowData, "displayName" | "modelId">,
): boolean {
  return row.displayName !== row.modelId;
}

export function modelChooserCompatibilityLabel(
  compatibility: ModelChooserSelectionCompatibility | null,
): string | null {
  if (!compatibility?.affectsSelection) return null;
  return compatibilityLabels[compatibility.state];
}

export function isModelChooserSelectionKey(
  event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey">,
): boolean {
  return !event.altKey
    && !event.ctrlKey
    && !event.metaKey
    && !event.shiftKey
    && (event.key === "Enter" || event.key === " ");
}

export function activateModelChooserFavorite(
  event: Pick<ReactMouseEvent, "preventDefault" | "stopPropagation">,
  row: ModelChooserRowData,
  onFavoriteToggle: ModelChooserFavoriteButtonProps["onFavoriteToggle"],
): void {
  event.preventDefault();
  event.stopPropagation();
  onFavoriteToggle(row);
}

export function activateModelChooserRow(
  row: ModelChooserRowData,
  onSelect: ModelChooserRowProps["onSelect"],
): boolean {
  if (!row.selectable) return false;
  onSelect(row);
  return true;
}

export const ModelChooserRow = memo(function ModelChooserRow({
  row,
  optionId,
  tabIndex = -1,
  onSelect,
  onFavoriteToggle,
}: ModelChooserRowProps): JSX.Element {
  const reactId = useId().replaceAll(":", "");
  const reasonId = `${reactId}-model-disabled-reason`;
  const compatibilityId = `${reactId}-model-compatibility`;
  const secondaryIdentity = modelChooserSecondaryIdentity(row);
  const showRawModelId = modelChooserShowsRawModelId(row);
  const compatibilityLabel = modelChooserCompatibilityLabel(row.compatibility);
  const describedBy = [
    row.disabledReason ? reasonId : null,
    compatibilityLabel && row.compatibility?.explanation ? compatibilityId : null,
  ].filter((value): value is string => value !== null).join(" ") || undefined;

  const select = (): void => { activateModelChooserRow(row, onSelect); };

  return (
    <div
      className={`model-chooser-row${row.active ? " is-active" : ""}${row.selectable ? "" : " is-disabled"}`}
    >
      <button
        type="button"
        id={optionId ?? `${reactId}-model-option`}
        className="model-chooser-row-option"
        aria-current={row.active ? "true" : undefined}
        aria-disabled={!row.selectable}
        aria-describedby={describedBy}
        aria-keyshortcuts={row.shortcut?.ariaKeyShortcuts}
        data-model-route-key={row.key}
        data-model-source={row.source}
        tabIndex={tabIndex}
        title={row.disabledReason ?? undefined}
        onClick={select}
      >
        <span className="model-chooser-row-main">
          <span className="model-chooser-row-primary">
            <strong title={row.displayName}>{row.displayName}</strong>
            {row.shortcut && (
              <kbd title={`Shortcut ${row.shortcut.label}`}>{row.shortcut.label}</kbd>
            )}
          </span>
          <span className="model-chooser-row-secondary">
            <span title={secondaryIdentity}>{secondaryIdentity}</span>
            {row.source === "custom" && <em>Custom</em>}
            {compatibilityLabel && (
              <span
                id={compatibilityId}
                className={`model-chooser-row-compatibility is-${row.compatibility!.state}`}
                title={row.compatibility?.explanation ?? undefined}
                aria-label={`Selection compatibility: ${compatibilityLabel}${row.compatibility?.explanation ? `. ${row.compatibility.explanation}` : ""}`}
              >
                {compatibilityLabel}
              </span>
            )}
          </span>
          {showRawModelId && (
            <code className="model-chooser-row-model-id" title={row.modelId}>{row.modelId}</code>
          )}
          {row.disabledReason && (
            <small id={reasonId} className="model-chooser-row-disabled-reason">
              {row.disabledReason}
            </small>
          )}
        </span>

        {row.active && (
          <span className="model-chooser-row-active" title="Active model">
            <Check size={14} aria-hidden="true" />
            <span className="visually-hidden">Active model</span>
          </span>
        )}
      </button>
      {onFavoriteToggle && (
        <ModelChooserFavoriteButton
          row={row}
          onFavoriteToggle={onFavoriteToggle}
        />
      )}
    </div>
  );
});

export const ModelChooserFavoriteButton = memo(function ModelChooserFavoriteButton({
  row,
  onFavoriteToggle,
}: ModelChooserFavoriteButtonProps): JSX.Element {
  return (
    <button
      type="button"
      className="model-chooser-row-favorite"
      aria-label={`${row.favorite ? "Remove" : "Add"} ${row.displayName} on ${row.backendProfileName} ${row.favorite ? "from" : "to"} favorites`}
      aria-pressed={row.favorite}
      title={row.favorite ? "Remove from favorites" : "Add to favorites"}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => activateModelChooserFavorite(event, row, onFavoriteToggle)}
    >
      <Star size={13} fill={row.favorite ? "currentColor" : "none"} aria-hidden="true" />
    </button>
  );
});
