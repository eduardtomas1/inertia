import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type KeyboardEvent,
} from "react";

export interface TimelineMarker {
  timelineIndex: number;
  id: string;
  label: string;
  number: number;
  summary: string | null;
}

export function TimelineMinimap({
  activeIndex,
  left,
  markers,
  onNavigationIntent,
  onNavigate,
}: {
  activeIndex: number;
  left: number;
  markers: TimelineMarker[];
  onNavigationIntent?: () => void;
  onNavigate: (index: number, target: "turn") => void;
}): JSX.Element {
  const [hoveredMarkerId, setHoveredMarkerId] = useState<string | null>(null);
  const [focusedMarkerId, setFocusedMarkerId] = useState<string | null>(null);
  const trackRef = useRef<HTMLSpanElement>(null);
  const previewedMarkerId = hoveredMarkerId ?? focusedMarkerId;
  let activeMarker = 0;
  markers.forEach((marker, index) => {
    if (marker.timelineIndex <= activeIndex) activeMarker = index;
  });
  useEffect(() => {
    const active = trackRef.current?.querySelector<HTMLElement>(
      '[aria-current="true"]',
    );
    active?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeMarker]);
  const previewedMarker = markers.find(({ id }) => id === previewedMarkerId);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
    const focused = Math.max(0, buttons.indexOf(document.activeElement as HTMLButtonElement));
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? buttons.length - 1
        : event.key === "ArrowUp"
          ? Math.max(0, focused - 1)
          : Math.min(buttons.length - 1, focused + 1);
    buttons[next]?.focus();
  };
  return (
    <div
      className="timeline-minimap-anchor"
      style={{ "--timeline-minimap-left": `${left}px` } as CSSProperties}
    >
      <nav className="timeline-minimap" aria-label="Conversation minimap" onKeyDown={onKeyDown}>
        <span ref={trackRef} className="timeline-minimap-track">
          {markers.map((marker, index) => (
            <button
              type="button"
              key={marker.id}
              aria-current={index === activeMarker ? "true" : undefined}
              aria-label={`Go to turn ${marker.number}: ${marker.label}`}
              data-emphasized={
                previewedMarkerId === marker.id ? "true" : undefined
              }
              tabIndex={index === activeMarker ? 0 : -1}
              onPointerEnter={() => setHoveredMarkerId(marker.id)}
              onPointerLeave={() => setHoveredMarkerId((current) =>
                current === marker.id ? null : current)}
              onFocus={() => setFocusedMarkerId(marker.id)}
              onBlur={() => setFocusedMarkerId((current) =>
                current === marker.id ? null : current)}
              onClick={() => {
                onNavigationIntent?.();
                onNavigate(marker.timelineIndex, "turn");
              }}
            />
          ))}
        </span>
        {previewedMarker && (
          <span
            className="timeline-minimap-preview"
            data-turn={previewedMarker.number}
            aria-hidden="true"
          >
            <strong>{previewedMarker.label}</strong>
            {previewedMarker.summary && (
              <span className="timeline-minimap-preview-summary">
                {previewedMarker.summary}
              </span>
            )}
          </span>
        )}
      </nav>
    </div>
  );
}
