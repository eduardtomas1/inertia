import { useId } from "react";
import { Laptop } from "lucide-react";

import {
  type EnvironmentSummarySnapshot,
} from "../utils/environmentSummary";
import { SubagentsSection, type GoalPanelProps } from "./GoalPanel";
import "./WorkspaceSurfaces.css";

export type AgentsSurfaceProps = Pick<
  GoalPanelProps,
  | "subagents"
  | "turns"
  | "canFollowUpSubagent"
  | "onFollowUpSubagent"
  | "onOpenSubagent"
  | "canStopSubagent"
  | "onStopSubagent"
> & {
  runtimeStatus: EnvironmentSummarySnapshot["runtime"]["status"];
};

export function AgentsSurface({
  runtimeStatus,
  subagents,
  turns,
  canFollowUpSubagent,
  onFollowUpSubagent,
  onOpenSubagent,
  canStopSubagent,
  onStopSubagent,
}: AgentsSurfaceProps): React.JSX.Element {
  const surfaceId = useId();
  const attention = runtimeStatus === "online"
    ? null
    : runtimeStatus === "connecting"
      ? {
          title: "Connecting to workspace",
          detail: "Live agent details may be incomplete.",
        }
      : {
          title: "Workspace runtime unavailable",
          detail: "Live agent details may be out of date.",
        };
  return (
    <section className="workspace-surface agents-surface" aria-label="Agents">
      <div className="workspace-surface-scroll">
        {attention && (
          <div
            className={`workspace-surface-attention is-${runtimeStatus}`}
            role="status"
            aria-live="polite"
          >
            <Laptop size={14} aria-hidden="true" />
            <span><strong>{attention.title}</strong><small>{attention.detail}</small></span>
          </div>
        )}
        <SubagentsSection
          key={subagents[0]?.conversationId ?? turns[0]?.conversationId ?? "empty"}
          subagents={subagents}
          turns={turns}
          canFollowUpSubagent={canFollowUpSubagent}
          onFollowUpSubagent={onFollowUpSubagent}
          onOpenSubagent={onOpenSubagent}
          canStopSubagent={canStopSubagent}
          onStopSubagent={onStopSubagent}
          headingId={`${surfaceId}-agents`}
          listId={`${surfaceId}-agent-list`}
        />
      </div>
    </section>
  );
}
