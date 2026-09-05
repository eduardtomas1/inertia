import { useEffect, useRef } from "react";

import type { SubagentTrace } from "@shared/contracts";
import {
  isLiveSubagentTrace,
  subagentElapsedMs,
} from "../utils/subagentDisclosure";
import { formatElapsed } from "../utils/responseTimeline";
import { useDocumentActivity } from "../hooks/useDocumentPresence";

interface SubagentElapsedProps {
  trace: SubagentTrace;
  now?: number;
  visible?: boolean;
}

const liveElapsedSubscribers = new Set<() => void>();
let liveElapsedTimer: number | null = null;

function subscribeLiveElapsed(update: () => void): () => void {
  liveElapsedSubscribers.add(update);
  update();
  liveElapsedTimer ??= window.setInterval(() => {
    for (const subscriber of liveElapsedSubscribers) subscriber();
  }, 1_000);
  return () => {
    liveElapsedSubscribers.delete(update);
    if (liveElapsedSubscribers.size > 0 || liveElapsedTimer === null) return;
    window.clearInterval(liveElapsedTimer);
    liveElapsedTimer = null;
  };
}

/**
 * Keeps live elapsed time current without reconciling an entire transcript
 * row every second. Settled rows remain frozen at their persisted update.
 */
export function SubagentElapsed({
  trace,
  now: fixedNow,
  visible = true,
}: SubagentElapsedProps): React.JSX.Element {
  const textRef = useRef<HTMLSpanElement>(null);
  const live = isLiveSubagentTrace(trace);
  const documentActive = useDocumentActivity();

  useEffect(() => {
    if (!live || fixedNow !== undefined || !visible || !documentActive) return;
    const update = (): void => {
      if (textRef.current) {
        textRef.current.textContent = formatElapsed(
          subagentElapsedMs(trace, Date.now()),
        );
      }
    };
    return subscribeLiveElapsed(update);
  }, [documentActive, fixedNow, live, trace, visible]);

  return (
    <span ref={textRef} className="subagent-elapsed">
      {formatElapsed(subagentElapsedMs(trace, fixedNow ?? Date.now()))}
    </span>
  );
}
