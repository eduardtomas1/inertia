import {
  ChevronDown,
  CloudCog,
} from "lucide-react";
import {
  forwardRef,
  type AriaAttributes,
  type JSX,
} from "react";

import {
  selectedModelChipIdentity,
  type SelectedModelChipRoute,
} from "../utils/selectedModelChip";
import { ProviderBrandIcon } from "./ProviderBrandIcon";

export interface SelectedModelChipProps {
  route: SelectedModelChipRoute;
  expanded: boolean;
  controlsId: string;
  onOpen: () => void;
  disabled?: boolean;
  showSourceGlyph?: boolean;
  ariaHasPopup?: Extract<
    AriaAttributes["aria-haspopup"],
    "dialog" | "listbox"
  >;
}

export const SelectedModelChip = forwardRef<
  HTMLButtonElement,
  SelectedModelChipProps
>(function SelectedModelChip({
  route,
  expanded,
  controlsId,
  onOpen,
  disabled = false,
  showSourceGlyph = true,
  ariaHasPopup = "dialog",
}, ref): JSX.Element {
  const identity = selectedModelChipIdentity(route);

  return (
    <button
      ref={ref}
      type="button"
      className={`selected-model-chip${expanded ? " is-open" : ""}`}
      title={identity.title}
      aria-label={identity.accessibleName}
      aria-haspopup={ariaHasPopup}
      aria-controls={controlsId}
      aria-expanded={expanded}
      disabled={disabled}
      data-model-route-key={identity.routeKey}
      data-model-source={identity.source}
      onClick={onOpen}
    >
      {showSourceGlyph && (
        <span className="selected-model-chip-glyph" aria-hidden="true">
          {identity.glyph === "custom"
            ? <CloudCog size={13} strokeWidth={1.8} />
            : <ProviderBrandIcon providerId={identity.glyph} size={13} decorative />}
        </span>
      )}
      <span className="selected-model-chip-label">{identity.label}</span>
      <ChevronDown
        className="selected-model-chip-chevron"
        size={12}
        aria-hidden="true"
      />
    </button>
  );
});
