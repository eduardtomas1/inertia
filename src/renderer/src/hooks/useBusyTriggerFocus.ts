import { useLayoutEffect, useRef, type RefObject } from "react";

export function useBusyTriggerFocus(
  busy: boolean,
  holderRef: RefObject<HTMLElement | null>,
  triggerRef: RefObject<HTMLButtonElement | null>,
): (trigger: HTMLElement) => void {
  const hold = useRef<"idle" | "requested" | "holding">("idle");
  useLayoutEffect(() => {
    if (busy) {
      if (hold.current === "requested") hold.current = "holding";
      return;
    }
    if (hold.current !== "holding") return;
    hold.current = "idle";
    const trigger = triggerRef.current;
    if (document.activeElement === holderRef.current && trigger && !trigger.disabled) trigger.focus();
  }, [busy, holderRef, triggerRef]);
  return (trigger) => {
    if (document.activeElement !== trigger) return;
    hold.current = "requested";
    holderRef.current?.focus();
  };
}
