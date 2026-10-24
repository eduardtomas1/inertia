import { useLayoutEffect, useRef, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { navigateMenuItems } from "../../utils/menuKeyboard";

/** Kept inside the owning menu for outside-click and focus ownership. */
export function ThreadSubmenu({ label, icon, disabled, children, open, onOpenChange: setOpen }: {
  label: string; icon: ReactNode; disabled?: boolean; children: ReactNode; open: boolean; onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const pointerClose = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancelPointerClose = (): void => {
    clearTimeout(pointerClose.current);
  };
  const focusFirstItem = (): void => {
    requestAnimationFrame(() => popup.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus());
  };
  useLayoutEffect(() => {
    if (!open || !popup.current || !trigger.current) return;
    const menu = popup.current;
    const position = (): void => {
      const bounds = trigger.current?.getBoundingClientRect();
      if (!bounds) return;
      const width = menu.offsetWidth;
      const left = bounds.right + width > window.innerWidth - 8 && bounds.left > width + 8
        ? bounds.left - width - 4
        : Math.max(8, Math.min(bounds.right + 4, window.innerWidth - width - 8));
      const top = Math.max(8, Math.min(bounds.top, window.innerHeight - menu.offsetHeight - 8));
      menu.style.left = `${left}px`;
      menu.style.top = `${top}px`;
      const placed = menu.getBoundingClientRect();
      menu.style.left = `${left - (placed.left - left)}px`;
      menu.style.top = `${top - (placed.top - top)}px`;
    };
    position();
    // The parent positions after its children's layout effects on initial open.
    const frame = requestAnimationFrame(position);
    const events = ["resize", "scroll", "animationend", "animationcancel"] as const;
    for (const event of events) window.addEventListener(event, position, event !== "resize");
    return () => {
      clearTimeout(pointerClose.current);
      cancelAnimationFrame(frame);
      for (const event of events) window.removeEventListener(event, position, event !== "resize");
    };
  }, [open]);
  return <div className="thread-submenu-owner" onPointerEnter={() => {
    cancelPointerClose();
    if (!disabled) setOpen(true);
  }} onPointerLeave={() => {
    if (!open) return;
    cancelPointerClose();
    // The popup sits four pixels from its row. Give the pointer time to cross
    // that gap; entering either the row or popup cancels the pending close.
    pointerClose.current = setTimeout(() => {
      if (!popup.current?.contains(document.activeElement)) setOpen(false);
    }, 150);
  }} onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget)) {
      cancelPointerClose();
      setOpen(false);
    }
  }}>
    <button type="button" role="menuitem" tabIndex={-1} ref={trigger} disabled={disabled}
      aria-haspopup="menu" aria-expanded={open}
      onClick={(event) => {
        setOpen(true);
        if (event.detail === 0) focusFirstItem();
      }} onKeyDown={(event) => {
        if (event.key !== "ArrowRight") return;
        event.preventDefault(); event.stopPropagation(); setOpen(true);
        focusFirstItem();
      }}>{icon}<span>{label}</span><ChevronRight size={14} className="thread-submenu-chevron" /></button>
    {open && <div ref={popup} role="menu" aria-label={label} className="thread-submenu"
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") {
          event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus();
        } else navigateMenuItems(event);
      }}>{children}</div>}
  </div>;
}
