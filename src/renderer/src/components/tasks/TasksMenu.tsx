import { useCallback, useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check } from "lucide-react";
import clsx from "clsx";

import { navigateMenuItems } from "../../utils/menuKeyboard";

export type TasksMenuDismissReason = "escape" | "selection" | "outside";

export interface TasksMenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  checked?: boolean;
  danger?: boolean;
  disabled?: boolean;
  restoreFocus?: boolean;
  onSelect: () => void;
}

export interface TasksMenuProps {
  id: string;
  label: string;
  anchor: { x: number; y: number };
  items: readonly TasksMenuItem[];
  radio?: boolean;
  trigger: HTMLElement | null;
  onDismiss: (reason: TasksMenuDismissReason) => void;
}

function focusTrigger(trigger: HTMLElement | null): void {
  if (trigger?.isConnected) trigger.focus({ preventScroll: true });
}

export function TasksMenu({
  id,
  label,
  anchor,
  items,
  radio = false,
  trigger,
  onDismiss,
}: TasksMenuProps): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  const triggerRef = useRef(trigger);
  triggerRef.current = trigger;

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const position = (): void => {
      menu.style.left = `${Math.max(8, Math.min(anchor.x, window.innerWidth - menu.offsetWidth - 8))}px`;
      menu.style.top = `${Math.max(8, Math.min(anchor.y, window.innerHeight - menu.offsetHeight - 8))}px`;
    };
    position();
    window.addEventListener("resize", position);
    const checked = menu.querySelector<HTMLButtonElement>('[aria-checked="true"]:not(:disabled)');
    (checked ?? menu.querySelector<HTMLButtonElement>("button:not(:disabled)"))?.focus({ preventScroll: true });
    return () => window.removeEventListener("resize", position);
  }, [anchor]);

  useEffect(() => {
    const inside = (target: EventTarget | null): boolean => target instanceof Node
      && (menuRef.current?.contains(target) === true || triggerRef.current?.contains(target) === true);
    const onFocusIn = (event: FocusEvent): void => {
      if (!inside(event.target)) dismissRef.current("outside");
    };
    const onPointerDown = (event: PointerEvent): void => {
      if (!inside(event.target)) dismissRef.current("outside");
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      focusTrigger(triggerRef.current);
      dismissRef.current("escape");
    };
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, []);

  const select = useCallback((item: TasksMenuItem): void => {
    if (item.disabled) return;
    if (item.restoreFocus !== false) focusTrigger(triggerRef.current);
    dismissRef.current("selection");
    item.onSelect();
  }, []);

  return createPortal(
    <div
      ref={menuRef}
      id={id}
      className="conversation-menu tasks-menu"
      role="menu"
      aria-label={label}
      onKeyDown={(event) => {
        if (event.key === "Tab") {
          event.preventDefault();
          focusTrigger(triggerRef.current);
          dismissRef.current("escape");
          return;
        }
        navigateMenuItems(event);
      }}
    >
      {items.map((item) => (
        <button
          type="button"
          key={item.id}
          role={radio ? "menuitemradio" : "menuitem"}
          aria-checked={radio ? item.checked === true : undefined}
          tabIndex={-1}
          disabled={item.disabled}
          className={clsx(item.danger && "is-danger")}
          onClick={() => select(item)}
        >
          {item.icon}
          {item.label}
          {radio && item.checked && <Check size={14} className="tasks-menu-check" aria-hidden="true" />}
        </button>
      ))}
    </div>,
    document.body,
  );
}
