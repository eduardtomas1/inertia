import { useCallback, useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check } from "lucide-react";
import clsx from "clsx";

import { navigateMenuItems } from "../../utils/menuKeyboard";

export type TasksMenuDismissReason = "selection" | "context-change";

export interface TasksMenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  marker?: ReactNode;
  checked?: boolean;
  danger?: boolean;
  restoreFocus?: boolean;
  onSelect: () => void;
}

export interface TasksMenuProps {
  id: string;
  label: string;
  anchor: { x: number; y: number };
  items: readonly TasksMenuItem[];
  radio?: boolean;
  onDismiss: (reason: TasksMenuDismissReason) => void;
  onSetPopover: (node: HTMLDivElement | null) => void;
}

export function TasksMenu({
  id,
  label,
  anchor,
  items,
  radio = false,
  onDismiss,
  onSetPopover,
}: TasksMenuProps): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null);
  const setMenuRef = useCallback((node: HTMLDivElement | null) => {
    menuRef.current = node;
    onSetPopover(node);
  }, [onSetPopover]);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const position = (): void => {
      menu.style.left = `${Math.max(8, Math.min(anchor.x, window.innerWidth - menu.offsetWidth - 8))}px`;
      menu.style.top = `${Math.max(8, Math.min(anchor.y, window.innerHeight - menu.offsetHeight - 8))}px`;
    };
    position();
    window.addEventListener("resize", position);
    const checked = menu.querySelector<HTMLButtonElement>('[aria-checked="true"]');
    (checked ?? menu.querySelector<HTMLButtonElement>("button"))?.focus({ preventScroll: true });
    return () => window.removeEventListener("resize", position);
  }, [anchor]);

  useEffect(() => {
    const dismissAfterFocusLeaves = (event: FocusEvent): void => {
      const target = event.target;
      if (target instanceof Node && !menuRef.current?.contains(target)) {
        onDismiss("context-change");
      }
    };
    document.addEventListener("focusin", dismissAfterFocusLeaves);
    return () => document.removeEventListener("focusin", dismissAfterFocusLeaves);
  }, [onDismiss]);

  return createPortal(
    <div
      ref={setMenuRef}
      id={id}
      className="conversation-menu tasks-menu"
      role="menu"
      aria-label={label}
      onKeyDown={(event) => navigateMenuItems(event)}
    >
      {items.map((item) => (
        <button
          type="button"
          key={item.id}
          role={radio ? "menuitemradio" : "menuitem"}
          aria-checked={radio ? item.checked === true : undefined}
          tabIndex={-1}
          className={clsx(item.danger && "is-danger")}
          onClick={() => {
            onDismiss(item.restoreFocus === false ? "context-change" : "selection");
            item.onSelect();
          }}
        >
          {item.icon}
          {item.marker}
          {item.label}
          {radio && item.checked && <Check size={14} className="tasks-menu-check" aria-hidden="true" />}
        </button>
      ))}
    </div>,
    document.body,
  );
}
