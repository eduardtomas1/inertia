import type { SubagentTrace } from "@shared/contracts";
import { isLiveSubagentTrace } from "../utils/subagentDisclosure";

interface SubagentStatusMarkProps {
  trace: SubagentTrace;
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
      data-live={isLiveSubagentTrace(trace)}
      data-status={trace.status}
      aria-hidden="true"
    />
  );
}
