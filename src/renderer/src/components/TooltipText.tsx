import { useRef, type ComponentPropsWithoutRef } from "react";

import { Tooltip, useTooltip } from "./Tooltip";

export function TooltipText({
  tooltip: label,
  children,
  ...props
}: ComponentPropsWithoutRef<"span"> & { tooltip: string }): React.JSX.Element {
  const anchor = useRef<HTMLSpanElement>(null);
  const tooltip = useTooltip(anchor, {});
  return (
    <>
      <span
        ref={anchor}
        {...props}
        onPointerEnter={tooltip.handlers.onPointerEnter}
        onPointerLeave={tooltip.handlers.onPointerLeave}
        onPointerDown={tooltip.handlers.onPointerDown}
      >
        {children}
      </span>
      {tooltip.layer && <Tooltip anchor={anchor} layer={tooltip.layer} label={label} />}
    </>
  );
}
