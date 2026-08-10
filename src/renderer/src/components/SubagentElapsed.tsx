import { useEffect, useRef } from "react";

import type { SubagentTrace } from "@shared/contracts";
import {
  isLiveSubagentTrace,
  subagentElapsedMs,
} from "../utils/subagentDisclosure";
import { formatElapsed } from "../utils/responseTimeline";

interface SubagentElapsedProps {
  trace: SubagentTrace;
  now?: number;
}

/**
 * Keeps live elapsed time current without reconciling an entire transcript
 * row every second. Settled rows remain frozen at their persisted update.
 */
export function SubagentElapsed({
  trace,
  now: fixedNow,
}: SubagentElapsedProps): React.JSX.Element {
  const textRef = useRef<HTMLSpanElement>(null);
  const live = isLiveSubagentTrace(trace);

  useEffect(() => {
    if (!live || fixedNow !== undefined) return;
    const update = (): void => {
      if (textRef.current) {
        textRef.current.textContent = formatElapsed(
          subagentElapsedMs(trace, Date.now()),
        );
      }
    };
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [fixedNow, live, trace]);

  return (
    <span ref={textRef} className="subagent-elapsed">
      {formatElapsed(subagentElapsedMs(trace, fixedNow ?? Date.now()))}
    </span>
  );
}
