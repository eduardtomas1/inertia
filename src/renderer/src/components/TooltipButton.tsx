import { useCallback, useId, useRef, type ComponentPropsWithRef } from "react";

import { Tooltip, useTooltip } from "./Tooltip";

export function TooltipButton({
  tooltip: label,
  shortcut,
  describeTooltip = true,
  multilineTooltip = false,
  ref,
  children,
  onPointerEnter,
  onPointerLeave,
  onPointerDown,
  onFocus,
  onBlur,
  onKeyDown,
  "aria-describedby": describedBy,
  ...props
}: ComponentPropsWithRef<"button"> & {
  tooltip: string;
  shortcut?: string;
  describeTooltip?: boolean;
  /** Render each "\n"-separated line of the tooltip on its own line. */
  multilineTooltip?: boolean;
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
  const hint = describeTooltip && label !== "" && label !== (named ?? (typeof children === "string" ? children : undefined)) ? label : undefined;
  const describedText = describedBy !== undefined ? "" : [hint, shortcut].filter(Boolean).join(" ");
  const description = describedText
    ? <span id={descriptionId} className="visually-hidden">{describedText}</span>
    : null;
  return (
    <>
      <button
        ref={setButton}
        type="button"
        aria-describedby={describedBy ?? (description ? descriptionId : undefined)}
        {...props}
        {...tooltip.handlers}
      >
        {children}
        {named !== undefined && description}
      </button>
      {named === undefined && description}
      {tooltip.layer && label !== "" && <Tooltip anchor={button} layer={tooltip.layer} label={label} shortcut={shortcut} multiline={multilineTooltip} />}
    </>
  );
}
