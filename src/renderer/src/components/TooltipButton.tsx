import { useCallback, useId, useRef, type ComponentPropsWithRef } from "react";

import { Tooltip, useTooltip } from "./Tooltip";

export function TooltipButton({
  tooltip: label,
  ref,
  children,
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
  const descriptionId = useId();
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
  const named = props["aria-label"];
  const described = label !== (named ?? (typeof children === "string" ? children : undefined));
  const description = described
    ? <span id={descriptionId} className="visually-hidden">{label}</span>
    : null;
  return (
    <>
      <button
        ref={setButton}
        type="button"
        aria-describedby={described ? descriptionId : undefined}
        {...props}
        {...tooltip.handlers}
      >
        {children}
        {named !== undefined && description}
      </button>
      {named === undefined && description}
      {tooltip.layer && <Tooltip anchor={button} layer={tooltip.layer} label={label} />}
    </>
  );
}
