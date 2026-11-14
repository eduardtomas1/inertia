import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";

import { navigateMenuItems } from "../../utils/menuKeyboard";

export interface UsageFilterOption {
  id: string;
  label: string;
  checked: boolean;
  icon?: ReactNode;
  separated?: boolean;
}

export function UsageFilterMenu({
  label,
  value,
  options,
  multiple = false,
  onSelect,
}: {
  label: string;
  value: string;
  options: readonly UsageFilterOption[];
  multiple?: boolean;
  onSelect(id: string): void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  useLayoutEffect(() => {
    if (!open) return;
    const items = menu.current?.querySelectorAll<HTMLButtonElement>("button") ?? [];
    ([...items].find((item) => item.getAttribute("aria-checked") === "true") ?? items[0])?.focus({ preventScroll: true });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event): void => {
      if (event.target instanceof Node && !anchor.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside);
    };
  }, [open]);
  const close = (): void => {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  };
  return (
    <span ref={anchor} className="usage-filter">
      <button
        ref={trigger}
        type="button"
        className="usage-filter-trigger"
        aria-label={`${label}: ${value}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen(!open)}
      >
        <span>{value}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <div
          ref={menu}
          id={menuId}
          className="conversation-menu usage-filter-menu"
          role="menu"
          aria-label={label}
          onKeyDown={(event) => {
            if (event.key === "Escape" || event.key === "Tab") {
              event.preventDefault();
              event.stopPropagation();
              close();
              return;
            }
            navigateMenuItems(event);
          }}
        >
          {options.map((option) => (
            <Fragment key={option.id}>
              {option.separated && <span role="separator" />}
              <button
                type="button"
                role={multiple ? "menuitemcheckbox" : "menuitemradio"}
                aria-checked={option.checked}
                tabIndex={-1}
                onClick={() => {
                  onSelect(option.id);
                  if (!multiple) close();
                }}
              >
                <span className="usage-filter-check" aria-hidden="true">{option.checked && <Check size={14} />}</span>
                {option.icon}
                <span>{option.label}</span>
              </button>
            </Fragment>
          ))}
        </div>
      )}
    </span>
  );
}
