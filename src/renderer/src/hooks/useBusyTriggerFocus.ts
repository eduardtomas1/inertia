import { useEffect, useRef, type RefObject } from "react";

export function useBusyTriggerFocus(
  busy: boolean,
  holderRef: RefObject<HTMLElement | null>,
  triggerRef: RefObject<HTMLButtonElement | null>,
): (trigger: HTMLElement) => void {
  const restorePending = useRef(false);
  useEffect(() => {
    if (busy || !restorePending.current) return;
    restorePending.current = false;
    const trigger = triggerRef.current;
    if (document.activeElement === holderRef.current && trigger && !trigger.disabled) trigger.focus();
  }, [busy, holderRef, triggerRef]);
  return (trigger) => {
    if (document.activeElement !== trigger) return;
    restorePending.current = true;
    holderRef.current?.focus();
  };
}
