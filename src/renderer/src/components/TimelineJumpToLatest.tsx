import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { ArrowDown } from "lucide-react";
import { IconButton } from "./ui";

const JUMP_EXIT_MS = 180;
const SMOOTH_JUMP_VIEWPORTS = 3;

export function jumpToLatestBehavior(
  element: Pick<HTMLElement, "scrollHeight" | "clientHeight" | "scrollTop"> | null,
  reducedMotion: boolean,
): ScrollBehavior {
  if (!element || reducedMotion) return "auto";
  const distance = element.scrollHeight - element.clientHeight - element.scrollTop;
  return distance < element.clientHeight * SMOOTH_JUMP_VIEWPORTS ? "smooth" : "auto";
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function TimelineJumpToLatest({
  visible,
  scrollElementRef,
  onJump,
}: {
  visible: boolean;
  scrollElementRef: RefObject<HTMLElement | null>;
  onJump: (behavior: ScrollBehavior) => void;
}): React.JSX.Element | null {
  const [leaving, setLeaving] = useState(false);
  const [previousVisible, setPreviousVisible] = useState(visible);
  const containerRef = useRef<HTMLDivElement>(null);
  if (previousVisible !== visible) {
    setPreviousVisible(visible);
    setLeaving(!visible);
  }
  useLayoutEffect(() => {
    if (!leaving) return;
    if (containerRef.current?.contains(document.activeElement)) {
      scrollElementRef.current?.focus({ preventScroll: true });
    }
  }, [leaving, scrollElementRef]);
  useEffect(() => {
    if (!leaving) return undefined;
    const timer = window.setTimeout(() => setLeaving(false), JUMP_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [leaving]);
  if (!visible && !leaving) return null;
  if (!visible) {
    return (
      <div ref={containerRef} className="timeline-jump" data-state="leaving" aria-hidden="true" inert>
        <IconButton label="Jump to latest" tabIndex={-1}><ArrowDown size={16} /></IconButton>
      </div>
    );
  }
  return (
    <div ref={containerRef} className="timeline-jump timeline-follow-controls">
      <IconButton
        label="Jump to latest"
        onClick={() => onJump(jumpToLatestBehavior(scrollElementRef.current, prefersReducedMotion()))}
      >
        <ArrowDown size={16} />
      </IconButton>
    </div>
  );
}
