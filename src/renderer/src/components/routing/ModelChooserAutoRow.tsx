import type { JSX } from "react";
import { Check, Route } from "lucide-react";

import "./routing.css";

/** The one override rule, stated wherever Auto is offered or shown. */
export const AUTO_ROUTING_OVERRIDE_HINT = "Choosing a model or effort turns Auto off for this chat.";

export interface ModelChooserAutoOption {
  /** The chat is in Auto routing mode. */
  selected: boolean;
  /** The last resolved route, for example "Claude Opus 5.5 · high". */
  currentRoute: string | null;
  onSelect: () => void | Promise<void>;
}

/**
 * The Auto entry above the concrete routes. It is a plain button so it stays
 * in the palette's tab order without joining the search's grid navigation.
 */
export function ModelChooserAutoRow({
  option,
  onChosen,
}: {
  option: ModelChooserAutoOption;
  onChosen: (completion: void | Promise<void>) => void;
}): JSX.Element {
  const detail = option.currentRoute ? `Currently ${option.currentRoute}` : "Chooses a model for each message";
  return (
    <div className="model-chooser-auto">
      <button
        type="button"
        className={option.selected ? "model-chooser-auto-option is-active" : "model-chooser-auto-option"}
        aria-pressed={option.selected}
        aria-label={`Auto: Inertia chooses the model for each message. ${detail}. ${AUTO_ROUTING_OVERRIDE_HINT}`}
        onClick={() => onChosen(option.onSelect())}
      >
        <Route size={14} aria-hidden="true" className="model-chooser-auto-glyph" />
        <span className="model-chooser-auto-copy">
          <strong>Auto</strong>
          <small>{detail}</small>
          <small>{AUTO_ROUTING_OVERRIDE_HINT}</small>
        </span>
        {option.selected && <Check size={14} aria-hidden="true" className="model-chooser-auto-check" />}
      </button>
    </div>
  );
}
