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
    { label: "Route", value: subagentRouteLabel(trace, turns) },
    {
      label: "Relationship",
      value: subagentRelationshipLabel(trace, traces),
    },
    { label: "Task", value: trace.description },
    { label: "Recent activity", value: trace.progress },
    { label: "Outcome", value: trace.result },
    { label: "Provider state", value: trace.providerStatus },
  ].filter((detail): detail is { label: string; value: string } =>
    Boolean(detail.value));

  return (
    <dl id={id} className="subagent-trace-details">
      {details.map(({ label, value }) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
