import type { Detail } from "../types";

export function ActivitySummary({ detail }: { detail: Detail }): React.JSX.Element | null {
  const activities = (detail.activities ?? []).slice(-6);
  const subagents = detail.subagents ?? [];
  const steps = detail.plan?.steps ?? [];
  if (activities.length === 0 && subagents.length === 0 && steps.length === 0) return null;
  return (
    <details className="work-summary">
      <summary>Current work</summary>
      {steps.length > 0 && (
        <section><h3>Plan</h3><ol>{steps.map((step, index) => <li key={`${index}-${step.label}`} data-status={step.status}>{step.label}</li>)}</ol></section>
      )}
      {activities.length > 0 && (
        <section><h3>Recent activity</h3><ul>{activities.map((activity) => <li key={activity.id}><span>{activity.title}</span><small>{activity.status}</small></li>)}</ul></section>
      )}
      {subagents.length > 0 && (
        <section><h3>Delegated agents</h3><ul>{subagents.map((subagent) => <li key={subagent.id}><span>{subagent.name ?? subagent.providerLabel}</span><small>{subagent.status}</small></li>)}</ul></section>
      )}
    </details>
  );
}
