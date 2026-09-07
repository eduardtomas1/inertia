import { useEffect, useId, useRef } from "react";
import { Bot, Box } from "lucide-react";

import "./ComposerCommandMenu.css";

export interface ComposerCommandMenuItem {
  id: string;
  description: string;
  section: "built-in" | "provider";
  disabled: boolean;
}

interface ComposerCommandMenuProps {
  items: readonly ComposerCommandMenuItem[];
  activeItemId: string | null;
  grouped: boolean;
  onActiveItemChange: (itemId: string) => void;
  onSelect: (itemId: string) => void;
}

const sections = [
  { id: "built-in", label: "Built-in" },
  { id: "provider", label: "Provider" },
] as const;

export function ComposerCommandMenu({
  items,
  activeItemId,
  grouped,
  onActiveItemChange,
  onSelect,
}: ComposerCommandMenuProps): React.JSX.Element {
  const reactId = useId();
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>(
      '[data-active="true"]',
    );
    active?.scrollIntoView({ block: "nearest" });
  }, [activeItemId]);

  const renderItem = (item: ComposerCommandMenuItem): React.JSX.Element => {
    const active = item.id === activeItemId;
    const Icon = item.section === "provider" ? Box : Bot;
    return (
      <button
        key={item.id}
        type="button"
        role="option"
        aria-selected={active}
        aria-disabled={item.disabled}
        data-active={active ? "true" : undefined}
        disabled={item.disabled}
        tabIndex={-1}
        onPointerEnter={() => {
          if (!item.disabled) onActiveItemChange(item.id);
        }}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onSelect(item.id)}
      >
        <Icon size={14} aria-hidden="true" />
        <span className="composer-command-copy">
          <strong>{`/${item.id}`}</strong>
          <small>{item.description}</small>
        </span>
      </button>
    );
  };

  return (
    <div className="composer-command-menu">
      <div
        ref={listRef}
        className="composer-command-list"
        role="listbox"
        aria-label="Composer commands"
      >
        {items.length === 0 ? (
          <div className="composer-command-empty" role="status">
            No matching command.
          </div>
        ) : grouped ? (
          sections.map((section, sectionIndex) => {
            const sectionItems = items.filter((item) =>
              item.section === section.id);
            if (sectionItems.length === 0) return null;
            const labelId = `${reactId}-${section.id}-label`;
            return (
              <div className="composer-command-section" key={section.id}>
                {sectionIndex > 0 && (
                  <div className="composer-command-separator" aria-hidden="true" />
                )}
                <div className="composer-command-group-label" id={labelId}>
                  {section.label}
                </div>
                <div role="group" aria-labelledby={labelId}>
                  {sectionItems.map(renderItem)}
                </div>
              </div>
            );
          })
        ) : (
          items.map(renderItem)
        )}
      </div>
    </div>
  );
}
