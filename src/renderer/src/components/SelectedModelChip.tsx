import {
  Bot,
  ChevronDown,
  CloudCog,
  Code2,
  Command,
  MousePointer2,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import {
  forwardRef,
  type AriaAttributes,
  type JSX,
} from "react";

import {
  selectedModelChipIdentity,
  type SelectedModelChipGlyph,
  type SelectedModelChipRoute,
} from "../utils/selectedModelChip";

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

const sourceIcons: Readonly<Record<SelectedModelChipGlyph, LucideIcon>> = {
  codex: Command,
  claude: Bot,
  cursor: MousePointer2,
  gemini: Sparkles,
  kimi: Bot,
  opencode: Code2,
  custom: CloudCog,
  unknown: Sparkles,
};

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
  const SourceIcon = sourceIcons[identity.glyph];

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
          <SourceIcon size={13} strokeWidth={1.8} />
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
