import type { SubagentTrace } from "@shared/contracts";
import { isLiveSubagentTrace } from "../utils/subagentDisclosure";
import { WorkingOrb } from "./working-indicator/WorkingOrb";
import { useWorkingIndicator } from "./working-indicator/WorkingIndicatorContext";
import {
  orbMotionForSubagent,
  resolveOrbMotion,
  usesActivityOrbs,
} from "./working-indicator/orbMotion";

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
  const indicator = useWorkingIndicator();
  const live = isLiveSubagentTrace(trace);
  const orb = live && usesActivityOrbs(indicator)
    ? resolveOrbMotion(indicator, orbMotionForSubagent(trace.status))
    : null;
  return (
    <span
      className="subagent-status-mark"
      data-live={live}
      data-status={trace.status}
      data-status-indicator={orb ? "orb" : undefined}
      aria-hidden="true"
    >
      {orb && <WorkingOrb size={14} design={orb.design} pace={orb.pace} />}
    </span>
  );
}
