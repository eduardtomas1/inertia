import {
  Check,
  CircleEllipsis,
  CircleHelp,
  Clock3,
  Pause,
  TriangleAlert,
  X,
} from "lucide-react";

import type { SubagentTrace } from "@shared/contracts";
import { isLiveSubagentTrace } from "../utils/subagentDisclosure";

interface SubagentStatusMarkProps {
  trace: SubagentTrace;
}

function StatusIcon({ status }: Pick<SubagentTrace, "status">): React.JSX.Element {
  switch (status) {
    case "queued":
    case "spawned":
      return <Clock3 size={11} aria-hidden="true" />;
    case "running":
      return <CircleEllipsis size={11} aria-hidden="true" />;
    case "waiting":
      return <Pause size={10} fill="currentColor" aria-hidden="true" />;
    case "completed":
      return <Check size={12} aria-hidden="true" />;
    case "failed":
    case "lost":
      return <TriangleAlert size={11} aria-hidden="true" />;
    case "cancelled":
    case "interrupted":
      return <X size={11} aria-hidden="true" />;
    case "unknown":
      return <CircleHelp size={11} aria-hidden="true" />;
  }
}

/**
 * A compact visual state shared by transcript and Goal panel task rows. The
 * normalized status remains visible in text beside it; this mark is decorative
 * and never becomes the only state signal.
 */
export function SubagentStatusMark({
  trace,
}: SubagentStatusMarkProps): React.JSX.Element {
  return (
    <span
      className="subagent-status-mark"
      data-live={isLiveSubagentTrace(trace) ? "true" : "false"}
      data-status={trace.status}
      aria-hidden="true"
    >
      <StatusIcon status={trace.status} />
    </span>
  );
}
