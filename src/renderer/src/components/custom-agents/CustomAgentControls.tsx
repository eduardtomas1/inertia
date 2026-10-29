import { useEffect, useId, useRef, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import clsx from "clsx";

import { useDismissibleMenu } from "../../hooks/useDismissibleMenu";
import { navigateMenuItems } from "../../utils/menuKeyboard";

export interface CustomAgentRadioOption<T extends string> {
  id: T;
  label: string;
  content: ReactNode;
  className?: string;
  style?: CSSProperties;
}

const NEXT_KEYS = new Set(["ArrowRight", "ArrowDown"]);
const PREVIOUS_KEYS = new Set(["ArrowLeft", "ArrowUp"]);

export function CustomAgentRadioGroup<T extends string>({ label, options, value, disabled = false, className, onChange }: {
  label: string;
  options: readonly CustomAgentRadioOption<T>[];
  value: T | null;
  disabled?: boolean;
  className?: string;
  onChange: (value: T) => void;
}): React.JSX.Element {
  const buttons = useRef(new Map<T, HTMLButtonElement>());
  const focusable = options.some((option) => option.id === value) ? value : options[0]?.id;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (disabled) return;
    const index = options.findIndex((option) => buttons.current.get(option.id) === event.target);
    if (index < 0) return;
    const target = NEXT_KEYS.has(event.key) ? options[(index + 1) % options.length]
      : PREVIOUS_KEYS.has(event.key) ? options[(index - 1 + options.length) % options.length]
        : event.key === "Home" ? options[0] : event.key === "End" ? options.at(-1) : undefined;
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    buttons.current.get(target.id)?.focus();
    if (target.id !== value) onChange(target.id);
  };
  return (
    <div role="radiogroup" aria-label={label} className={className} onKeyDown={onKeyDown}>
      {options.map((option) => (
        <button
          key={option.id}
          ref={(node) => {
            if (node) buttons.current.set(option.id, node);
            else buttons.current.delete(option.id);
          }}
          type="button"
          role="radio"
          aria-checked={option.id === value}
          aria-label={option.label}
          tabIndex={option.id === focusable ? 0 : -1}
          disabled={disabled}
          className={option.className}
          style={option.style}
          onClick={() => { if (option.id !== value) onChange(option.id); }}
        >
          {option.content}
        </button>
      ))}
    </div>
  );
}

export interface CustomAgentMenuItem<T extends string> {
  id: T;
  label: string;
  hint?: string;
  leading?: ReactNode;
}

export function CustomAgentMenu<T extends string>({ label, icon, items, disabled = false, onPick }: {
  label: string;
  icon: ReactNode;
  items: readonly CustomAgentMenuItem<T>[];
  disabled?: boolean;
  onPick: (id: T) => void;
}): React.JSX.Element {
  const { menu, toggleMenu, dismissMenu, setMenuTrigger, setMenuPopover } = useDismissibleMenu<"menu">();
  const menuId = useId();
  const popover = useRef<HTMLDivElement | null>(null);
  const open = menu === "menu";
  useEffect(() => {
    if (open) popover.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({ preventScroll: true });
  }, [open]);
  return (
    <div className="custom-agent-menu-anchor">
      <button
        ref={(node) => setMenuTrigger("menu", node)}
        type="button"
        className="secondary-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        onClick={() => toggleMenu("menu")}
      >
        {icon}{label}
      </button>
      {open && (
        <div
          ref={(node) => {
            popover.current = node;
            setMenuPopover("menu", node);
          }}
          id={menuId}
          role="menu"
          aria-label={label}
          className="custom-agent-menu"
          onKeyDown={(event) => navigateMenuItems(event, '[role="menuitem"]')}
        >
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className={clsx("custom-agent-menu-item", item.leading !== undefined && "has-leading")}
              onClick={() => {
                dismissMenu("selection");
                onPick(item.id);
              }}
            >
              {item.leading}
              <span>
                <strong>{item.label}</strong>
                {item.hint && <small>{item.hint}</small>}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
