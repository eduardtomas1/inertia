import { useRef, type ComponentPropsWithoutRef } from "react";

import { Tooltip, useTooltip } from "./Tooltip";

export function TooltipButton({
  tooltip: label,
  onPointerEnter,
  onPointerLeave,
  onPointerDown,
  onFocus,
  onBlur,
  onKeyDown,
  ...props
}: ComponentPropsWithoutRef<"button"> & {
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
  return (
    <>
      <button ref={button} type="button" {...props} {...tooltip.handlers} />
      {tooltip.open && <Tooltip anchor={button} label={label} />}
    </>
  );
}
