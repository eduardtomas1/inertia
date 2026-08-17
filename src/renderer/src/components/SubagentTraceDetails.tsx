import type {
  AgentTurn,
  SubagentTrace,
} from "@shared/contracts";
import {
  subagentRelationshipLabel,
  subagentRouteLabel,
} from "../utils/subagentDisclosure";

interface SubagentTraceDetailsProps {
  id: string;
  trace: SubagentTrace;
  traces: readonly SubagentTrace[];
  turns: readonly AgentTurn[];
}

export function SubagentTraceDetails({
  id,
  trace,
  traces,
  turns,
}: SubagentTraceDetailsProps): React.JSX.Element {
  const details = [
    ["Route", subagentRouteLabel(trace, turns)],
    ["Relationship", subagentRelationshipLabel(trace, traces)],
    ["Task", trace.description],
    ["Recent activity", trace.progress],
    ["Outcome", trace.result],
    ["Provider state", trace.providerStatus],
  ];

  return (
    <dl id={id} className="subagent-trace-details">
      {details.map(([label, value]) => value && (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
