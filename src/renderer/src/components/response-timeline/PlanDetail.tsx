import { memo } from "react";
import { Check, Circle, CircleDot, ListChecks, X } from "lucide-react";
import type { AgentPlan } from "@shared/contracts";

const PLAN_STEP_STATUS_LABELS: Record<AgentPlan["steps"][number]["status"], string> = {
  pending: "Pending",
  inProgress: "In progress",
  completed: "Completed",
  cancelled: "Cancelled",
};

export const PlanDetail = memo(function PlanDetail({ plan }: { plan: AgentPlan }): React.JSX.Element {
  return (
    <div className="turn-reasoning-detail" data-turn-plan={plan.turnId ?? "legacy"}>
      <span><ListChecks size={14} aria-hidden="true" />Plan</span>
      {plan.explanation && <p>{plan.explanation}</p>}
      {plan.steps.length > 0 && (
        <ul className="turn-plan-steps">
          {plan.steps.map(({ step, status }, index) => {
            const StepIcon = status === "completed" ? Check : status === "cancelled" ? X : status === "inProgress" ? CircleDot : Circle;
            return (
              <li key={index} data-plan-step-status={status}>
                <StepIcon size={12} aria-hidden="true" />
                <span><span className="visually-hidden">{PLAN_STEP_STATUS_LABELS[status]}: </span>{step}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
});
