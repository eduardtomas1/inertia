import { useEffect, type RefObject } from "react";

export function useFocusOutDismiss(
  anchorRef: RefObject<HTMLElement | null>,
  open: boolean,
  dismiss: () => void,
): void {
  useEffect(() => {
    if (!open) return;
    const handleFocusIn = (event: FocusEvent): void => {
      const target = event.target;
      if (target instanceof Node && !anchorRef.current?.contains(target)) dismiss();
    };
    document.addEventListener("focusin", handleFocusIn);
    return () => document.removeEventListener("focusin", handleFocusIn);
  }, [anchorRef, dismiss, open]);
}
