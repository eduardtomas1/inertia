import { useEffect, useRef, type KeyboardEvent, type PointerEvent, type RefObject } from "react";

type PaneResizeHandleProps = {
  label: string;
  controls: string;
  containerRef: RefObject<HTMLElement | null>;
  orientation: "horizontal" | "vertical";
  pane?: "before" | "after";
  unit?: "percent" | "pixels";
  value: number;
  min: number;
  max: number;
  defaultValue: number;
  onChange: (value: number) => void;
  onCommit?: (value: number) => void;
  valueText?: (value: number) => string;
  className?: string;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function PaneResizeHandle({
  label,
  controls,
  containerRef,
  orientation,
  pane = "before",
  unit = "pixels",
  value,
  min,
  max,
  defaultValue,
  onChange,
  onCommit,
  valueText,
  className,
}: PaneResizeHandleProps): React.JSX.Element {
  const draggingRef = useRef(false);
  const latestValueRef = useRef(value);

  useEffect(() => {
    latestValueRef.current = value;
  }, [value]);

  useEffect(() => () => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    document.documentElement.classList.remove("is-resizing-horizontal", "is-resizing-vertical");
  }, []);

  const updateFromPointer = (event: PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    const bounds = containerRef.current?.getBoundingClientRect();
    if (!bounds) return;

    const length = orientation === "vertical" ? bounds.width : bounds.height;
    if (length <= 0) return;
    const coordinate = orientation === "vertical" ? event.clientX - bounds.left : event.clientY - bounds.top;
    const paneLength = pane === "before" ? coordinate : length - coordinate;
    const next = clamp(unit === "percent" ? (paneLength / length) * 100 : paneLength, min, max);
    latestValueRef.current = next;
    onChange(next);
  };

  const finishPointer = (event: PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    updateFromPointer(event);
    draggingRef.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    document.documentElement.classList.remove("is-resizing-horizontal", "is-resizing-vertical");
    onCommit?.(latestValueRef.current);
  };

  const commit = (next: number) => {
    const clamped = clamp(next, min, max);
    latestValueRef.current = clamped;
    onChange(clamped);
    onCommit?.(clamped);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = unit === "percent" ? (event.shiftKey ? 5 : 2) : (event.shiftKey ? 32 : 12);
    let next: number | null = null;

    if (event.key === "Home") next = min;
    else if (event.key === "End") next = max;
    else if (event.key === "Enter") next = defaultValue;
    else if (orientation === "vertical" && event.key === "ArrowLeft") next = value + (pane === "before" ? -step : step);
    else if (orientation === "vertical" && event.key === "ArrowRight") next = value + (pane === "before" ? step : -step);
    else if (orientation === "horizontal" && event.key === "ArrowUp") next = value + (pane === "before" ? -step : step);
    else if (orientation === "horizontal" && event.key === "ArrowDown") next = value + (pane === "before" ? step : -step);

    if (next === null) return;
    event.preventDefault();
    commit(next);
  };

  const roundedValue = Math.round(value);

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-controls={controls}
      aria-orientation={orientation}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={roundedValue}
      aria-valuetext={valueText?.(roundedValue) ?? `${roundedValue}${unit === "percent" ? "%" : " pixels"}`}
      className={`pane-resize-handle is-${orientation}${className ? ` ${className}` : ""}`}
      onDoubleClick={() => commit(defaultValue)}
      onKeyDown={handleKeyDown}
      onPointerDown={(event) => {
        if (event.button !== 0 || !event.isPrimary) return;
        event.preventDefault();
        latestValueRef.current = value;
        draggingRef.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        document.documentElement.classList.add(`is-resizing-${orientation}`);
      }}
      onPointerMove={updateFromPointer}
      onPointerUp={finishPointer}
      onPointerCancel={finishPointer}
      onLostPointerCapture={() => {
        if (!draggingRef.current) return;
        draggingRef.current = false;
        document.documentElement.classList.remove("is-resizing-horizontal", "is-resizing-vertical");
        onCommit?.(latestValueRef.current);
      }}
    />
  );
}
