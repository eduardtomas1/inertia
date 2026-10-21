import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { navigateMenuItems } from "../../utils/menuKeyboard";

const MENU_ITEMS = '[role^="menuitem"]:not(:disabled)';
const FLOATING_GAP = 4;
const VIEWPORT_MARGIN = 8;

function floatingPosition(trigger: HTMLElement, menu: HTMLElement): CSSProperties {
  const anchor = trigger.getBoundingClientRect();
  const height = menu.offsetHeight;
  const width = menu.offsetWidth;
  const below = anchor.bottom + FLOATING_GAP;
  const top = below + height > window.innerHeight - VIEWPORT_MARGIN && anchor.top - FLOATING_GAP - height >= VIEWPORT_MARGIN
    ? anchor.top - FLOATING_GAP - height
    : below;
  const left = Math.max(VIEWPORT_MARGIN, Math.min(anchor.left, window.innerWidth - VIEWPORT_MARGIN - width));
  return { position: "fixed", top, left, right: "auto" };
}

export function WatcherMenu({
  label,
  trigger,
  triggerClassName,
  menuClassName,
  disabled = false,
  floating = false,
  children,
}: {
  label: string;
  trigger: ReactNode;
  triggerClassName?: string;
  menuClassName?: string;
  disabled?: boolean;
  floating?: boolean;
  children: (close: (restoreFocus?: boolean) => void) => ReactNode;
}): React.JSX.Element {
  const menuId = `${useId().replaceAll(":", "")}-watcher-menu`;
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = (restoreFocus = true): void => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
  };
  useLayoutEffect(() => {
    if (!open || !floating || !triggerRef.current || !menuRef.current) {
      setPosition(null);
      return;
    }
    setPosition(floatingPosition(triggerRef.current, menuRef.current));
  }, [floating, open]);
  useEffect(() => {
    if (!open || (floating && !position)) return;
    const frame = window.requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLElement>(MENU_ITEMS)?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [floating, open, position]);
  useEffect(() => {
    if (!open) return;
    const inside = (target: EventTarget | null): boolean => target instanceof Node
      && Boolean(rootRef.current?.contains(target) || menuRef.current?.contains(target));
    const dismiss = (event: Event): void => {
      if (inside(event.target)) return;
      setOpen(false);
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    const scrolled = (event: Event): void => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener("keydown", escape, true);
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("focusin", dismiss);
    if (floating) {
      window.addEventListener("scroll", scrolled, true);
      window.addEventListener("resize", scrolled);
    }
    return () => {
      document.removeEventListener("keydown", escape, true);
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("focusin", dismiss);
      window.removeEventListener("scroll", scrolled, true);
      window.removeEventListener("resize", scrolled);
    };
  }, [floating, open]);
  const menu = open ? (
    <div
      ref={menuRef}
      id={menuId}
      className={`conversation-menu watcher-menu${menuClassName ? ` ${menuClassName}` : ""}${floating ? " is-floating" : ""}`}
      role="menu"
      aria-label={label}
      style={floating ? position ?? { position: "fixed", top: 0, left: 0, visibility: "hidden" } : undefined}
      onKeyDown={(event) => {
        if (event.key === "Tab") {
          if (floating) {
            event.preventDefault();
            close();
          } else {
            setOpen(false);
          }
          return;
        }
        navigateMenuItems(event, MENU_ITEMS);
      }}
    >
      {children(close)}
    </div>
  ) : null;
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
      {floating && menu ? createPortal(menu, document.body) : menu}
    </div>
  );
}
