import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

export const TOOLTIP_DELAY_MS = 500;
export const TOOLTIP_WARM_MS = 400;
const TOOLTIP_GAP = 4;
const VIEWPORT_PADDING = 8;

let warmUntil = 0;

interface TooltipPosition {
  top: number;
  left: number;
}

export interface TooltipTriggerHandlers<T extends HTMLElement> {
  onPointerEnter: (event: PointerEvent<T>) => void;
  onPointerLeave: (event: PointerEvent<T>) => void;
  onPointerDown: (event: PointerEvent<T>) => void;
  onFocus: (event: FocusEvent<T>) => void;
  onBlur: (event: FocusEvent<T>) => void;
  onKeyDown: (event: KeyboardEvent<T>) => void;
}

export function useTooltip<T extends HTMLElement>(
  triggerRef: RefObject<T | null>,
  handlers: Partial<TooltipTriggerHandlers<T>>,
): { open: boolean; handlers: TooltipTriggerHandlers<T>; close: () => void } {
  const [open, setOpen] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const openRef = useRef(false);

  const clearTimer = useCallback(() => {
    if (timer.current !== undefined) window.clearTimeout(timer.current);
    timer.current = undefined;
  }, []);

  const close = useCallback(() => {
    clearTimer();
    if (openRef.current) warmUntil = Date.now() + TOOLTIP_WARM_MS;
    openRef.current = false;
    setOpen(false);
  }, [clearTimer]);

  const show = useCallback(() => {
    clearTimer();
    const reveal = () => {
      timer.current = undefined;
      if (!triggerRef.current?.isConnected) return;
      openRef.current = true;
      setOpen(true);
    };
    if (Date.now() < warmUntil) reveal();
    else timer.current = window.setTimeout(reveal, TOOLTIP_DELAY_MS);
  }, [clearTimer, triggerRef]);

  useEffect(() => clearTimer, [clearTimer]);

  useEffect(() => {
    if (!open) return;
    const dismiss = () => close();
    window.addEventListener("scroll", dismiss, { capture: true, passive: true });
    window.addEventListener("pointerdown", dismiss, { capture: true });
    window.addEventListener("blur", dismiss);
    return () => {
      window.removeEventListener("scroll", dismiss, { capture: true });
      window.removeEventListener("pointerdown", dismiss, { capture: true });
      window.removeEventListener("blur", dismiss);
    };
  }, [close, open]);

  return {
    open,
    close,
    handlers: {
      onPointerEnter: (event) => {
        handlers.onPointerEnter?.(event);
        if (event.pointerType !== "touch") show();
      },
      onPointerLeave: (event) => {
        handlers.onPointerLeave?.(event);
        close();
      },
      onPointerDown: (event) => {
        handlers.onPointerDown?.(event);
        close();
      },
      onFocus: (event) => {
        handlers.onFocus?.(event);
        if (event.currentTarget.matches(":focus-visible")) show();
      },
      onBlur: (event) => {
        handlers.onBlur?.(event);
        close();
      },
      onKeyDown: (event) => {
        handlers.onKeyDown?.(event);
        if (event.key === "Escape" && openRef.current) close();
      },
    },
  };
}

export function Tooltip({
  anchor,
  label,
  shortcut,
}: {
  anchor: RefObject<HTMLElement | null>;
  label: string;
  shortcut?: string;
}): React.JSX.Element | null {
  const tooltip = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<TooltipPosition | null>(null);

  useLayoutEffect(() => {
    const trigger = anchor.current?.getBoundingClientRect();
    const box = tooltip.current?.getBoundingClientRect();
    if (!trigger || !box) return;
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
    const centered = trigger.left + trigger.width / 2 - box.width / 2;
    const left = Math.min(
      Math.max(VIEWPORT_PADDING, centered),
      Math.max(VIEWPORT_PADDING, viewportWidth - VIEWPORT_PADDING - box.width),
    );
    const below = trigger.bottom + TOOLTIP_GAP;
    const top = below + box.height > viewportHeight - VIEWPORT_PADDING
      ? Math.max(VIEWPORT_PADDING, trigger.top - TOOLTIP_GAP - box.height)
      : below;
    setPosition({ top, left });
  }, [anchor, label, shortcut]);

  return createPortal(
    <div
      ref={tooltip}
      className="tooltip"
      role="tooltip"
      aria-hidden="true"
      data-positioned={position ? "true" : undefined}
      style={position ? { top: position.top, left: position.left } : undefined}
    >
      {label}
      {shortcut && <kbd>{shortcut}</kbd>}
    </div>,
    document.body,
  );
}
