import { useCallback, useRef, type ComponentPropsWithRef } from "react";

import { Tooltip, useTooltip } from "./Tooltip";

export function TooltipButton({
  tooltip: label,
  ref,
  onPointerEnter,
  onPointerLeave,
  onPointerDown,
  onFocus,
  onBlur,
  onKeyDown,
  ...props
}: ComponentPropsWithRef<"button"> & {
  tooltip: string;
}): React.JSX.Element {
  const button = useRef<HTMLButtonElement | null>(null);
  const tooltip = useTooltip(button, {
    onPointerEnter,
    onPointerLeave,
    onPointerDown,
    onFocus,
    onBlur,
    onKeyDown,
  });
  const setButton = useCallback((node: HTMLButtonElement | null) => {
    button.current = node;
    if (typeof ref === "function") ref(node);
    else if (ref) ref.current = node;
  }, [ref]);
  return (
    <>
      <button ref={setButton} type="button" {...props} {...tooltip.handlers} />
      {tooltip.open && <Tooltip anchor={button} label={label} />}
    </>
  );
}
