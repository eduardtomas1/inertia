import { useCallback, useId, useRef, type ComponentPropsWithRef } from "react";

import { Tooltip, useTooltip } from "./Tooltip";

export function TooltipButton({
  tooltip: label,
  shortcut,
  describeTooltip = true,
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
  shortcut?: string;
  describeTooltip?: boolean;
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
  const hint = describeTooltip && label !== (named ?? (typeof children === "string" ? children : undefined)) ? label : undefined;
  const describedText = "aria-describedby" in props ? "" : [hint, shortcut].filter(Boolean).join(" ");
  const description = describedText
    ? <span id={descriptionId} className="visually-hidden">{describedText}</span>
    : null;
  return (
    <>
      <button
        ref={setButton}
        type="button"
        aria-describedby={description ? descriptionId : undefined}
        {...props}
        {...tooltip.handlers}
      >
        {children}
        {named !== undefined && description}
      </button>
      {named === undefined && description}
      {tooltip.layer && <Tooltip anchor={button} layer={tooltip.layer} label={label} shortcut={shortcut} />}
    </>
  );
}
