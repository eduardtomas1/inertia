import { useEffect, useRef } from "react";

import { useDocumentVisibility } from "../../hooks/useDocumentPresence";
import { formatElapsed } from "../../utils/response-timeline/timing";
import { subscribeLiveElapsed } from "../SubagentElapsed";

function elapsedSince(startedAt: string, now: number): string {
  const start = Date.parse(startedAt);
  return Number.isFinite(start) ? formatElapsed(Math.max(0, now - start)) : "";
}

export function WatcherElapsed({ startedAt }: { startedAt: string | null }): React.JSX.Element | null {
  const textRef = useRef<HTMLSpanElement>(null);
  const visible = useDocumentVisibility();
  useEffect(() => {
    if (!startedAt || !visible) return;
    return subscribeLiveElapsed(() => {
      if (textRef.current) textRef.current.textContent = elapsedSince(startedAt, Date.now());
    });
  }, [startedAt, visible]);
  if (!startedAt) return null;
  return (
    <span ref={textRef} className="watcher-bar-elapsed" aria-hidden="true">
      {elapsedSince(startedAt, Date.now())}
    </span>
  );
}
