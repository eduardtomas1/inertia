import { lazy, Suspense, useId, useState } from "react";
import type {
  AgentTurn,
  SubagentTrace,
} from "@shared/contracts";
import {
  subagentRelationshipLabel,
  subagentRouteLabel,
} from "../utils/subagentDisclosure";
import type { ObservedChildCommandRunner } from "./orchestration/delegation-model";

const ObservedChildView = lazy(async () => ({ default: (await import("./orchestration/observed-child-view")).ObservedChildView }));

interface SubagentTraceDetailsProps {
  id: string;
  trace: SubagentTrace;
  traces: readonly SubagentTrace[];
  turns: readonly AgentTurn[];
  run?: ObservedChildCommandRunner;
}

function ObservedTraceToggle({ trace, turns, run }: {
  trace: SubagentTrace;
  turns: readonly AgentTurn[];
  run: ObservedChildCommandRunner;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const turnIndex = turns.findIndex(({ id }) => id === trace.turnId);
  return (
    <div className="subagent-observed">
      <button
        type="button"
        className="turn-run-details-toggle"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((current) => !current)}
      >
        {open ? "Hide provider view" : "Provider view"}
      </button>
      <div id={panelId} hidden={!open}>
        {open && (
          <Suspense fallback={null}>
            <ObservedChildView
              conversationId={trace.conversationId}
              turnId={trace.turnId}
              focusTraceId={trace.id}
              turnLabel={turnIndex < 0 ? "Turn" : `Turn ${turnIndex + 1}`}
              run={run}
            />
          </Suspense>
        )}
      </div>
    </div>
  );
}

export function SubagentTraceDetails({
  id,
  trace,
  traces,
  turns,
  run,
}: SubagentTraceDetailsProps): React.JSX.Element {
  const details = [
    ["Route", subagentRouteLabel(trace, turns)],
    ["Relationship", subagentRelationshipLabel(trace, traces)],
    ["Task", trace.description],
    ["Recent activity", trace.progress],
    ["Outcome", trace.result],
    ["Provider state", trace.providerStatus],
  ];

  const list = (
    <dl id={id} className="subagent-trace-details">
      {details.map(([label, value]) => value && (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
  if (!run) return list;
  return (
    <>
      {list}
      <ObservedTraceToggle trace={trace} turns={turns} run={run} />
    </>
  );
}
