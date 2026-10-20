import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { navigateMenuItems } from "../../utils/menuKeyboard";

const MENU_ITEMS = '[role^="menuitem"]:not(:disabled)';

/**
 * A small `role="menu"` popover in the app's existing grammar: the trigger
 * owns `aria-expanded`/`aria-controls`, the first item takes focus, arrow keys
 * move between items and Escape returns focus to the trigger without
 * reaching the dock's own Escape handling.
 */
export function WatcherMenu({
  label,
  trigger,
  triggerClassName,
  menuClassName,
  disabled = false,
  children,
}: {
  label: string;
  trigger: ReactNode;
  triggerClassName?: string;
  menuClassName?: string;
  disabled?: boolean;
  children: (close: (restoreFocus?: boolean) => void) => ReactNode;
}): React.JSX.Element {
  const menuId = `${useId().replaceAll(":", "")}-watcher-menu`;
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = (restoreFocus = true): void => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
  };
  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(menuId)?.querySelector<HTMLElement>(MENU_ITEMS)?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [menuId, open]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: Event): void => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("focusin", dismiss);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("focusin", dismiss);
    };
  }, [open]);
  return (
    <div ref={rootRef} className="watcher-menu-anchor">
      <button
        ref={triggerRef}
        type="button"
        className={triggerClassName}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" || open) return;
          event.preventDefault();
          setOpen(true);
        }}
      >
        {trigger}
      </button>
      {open && (
        <div
          id={menuId}
          className={`conversation-menu watcher-menu${menuClassName ? ` ${menuClassName}` : ""}`}
          role="menu"
          aria-label={label}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              close();
              return;
            }
            if (event.key === "Tab") {
              setOpen(false);
              return;
            }
            navigateMenuItems(event, MENU_ITEMS);
          }}
        >
          {children(close)}
        </div>
      )}
    </div>
  );
}
