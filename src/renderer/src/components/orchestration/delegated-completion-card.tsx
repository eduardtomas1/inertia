import { useId, useState } from "react";
import { ChevronDown, Split } from "lucide-react";
import clsx from "clsx";
import type { ChatMessage } from "@shared/contracts";
import { completionSummary, taskChip, taskOutcomeLabel } from "./delegation-model";
import { useDelegationSurface } from "./delegation-surface";
import "./delegation-panel.css";

const MAX_EXPANDED_ENTRIES = 500;
const expandedByCard = new Map<string, boolean>();

function readExpanded(key: string): boolean {
  return expandedByCard.get(key) ?? false;
}

function writeExpanded(key: string, expanded: boolean): void {
  expandedByCard.delete(key);
  expandedByCard.set(key, expanded);
  if (expandedByCard.size > MAX_EXPANDED_ENTRIES) {
    const oldest = expandedByCard.keys().next().value;
    if (oldest !== undefined) expandedByCard.delete(oldest);
  }
}

export function clearDelegatedCompletionCardState(): void {
  expandedByCard.clear();
}

export function DelegatedCompletionCard({ message, turnId, followUp = false, onBeforeToggle, onAfterToggle }: {
  message: ChatMessage; turnId?: string; followUp?: boolean; onBeforeToggle?: () => void; onAfterToggle?: () => void;
}): React.JSX.Element | null {
  const surface = useDelegationSurface();
  const stateKey = `${message.conversationId}:${message.id}`;
  const [trackedKey, setTrackedKey] = useState(stateKey);
  const [expanded, setExpanded] = useState(() => readExpanded(stateKey));
  if (trackedKey !== stateKey) {
    setTrackedKey(stateKey);
    setExpanded(readExpanded(stateKey));
  }
  const panelId = useId();
  const attribution = message.delegatedCompletion;
  if (!attribution) return null;
  const { title, headline, labels, tasks } = completionSummary(attribution.taskIds, surface?.delegation, message.content);
  const toggle = () => {
    onBeforeToggle?.();
    const next = !expanded;
    writeExpanded(stateKey, next);
    setExpanded(next);
    window.requestAnimationFrame(() => onAfterToggle?.());
  };
  return <article
    className={clsx("delegated-completion-card", followUp ? "is-follow-up" : "turn-user-request")}
    aria-label={`Delegated results: ${title}`}
    data-delegated-generation={attribution.generation}
    {...(followUp ? { "data-follow-up-message-id": message.id } : {
      "data-turn-layer": "user-request", "data-turn-request-context": turnId, "data-turn-jump-target": "request",
      "data-message-search-id": message.id,
    })}
    tabIndex={-1}
  >
    <p className="delegated-completion-row">
      <Split size={14} aria-hidden="true" />
      <strong>{headline}</strong>
      {labels && <span className="delegated-completion-labels">{labels}</span>}
      <button type="button" className="delegated-completion-toggle" aria-expanded={expanded} aria-controls={panelId}
        aria-label={`${expanded ? "Hide results" : "Show results"}: ${title}`}
        onClick={toggle}>
        {expanded ? "Hide results" : "Show results"}<ChevronDown size={14} aria-hidden="true" />
      </button>
    </p>
    <div id={panelId} hidden={!expanded}>
      {expanded && <ul className="delegated-completion-tasks" aria-label="Delivered delegated tasks">
        {tasks.map(({ taskId, label, status, summary }) => <li key={taskId} data-task-status={status ?? undefined}>
          <span className="delegated-completion-task-heading">
            <strong>{label ?? "Delegated task"}</strong>
            <span>{status ? taskOutcomeLabel(status) : "Details unavailable"}</span>
            {summary && <span className="delegation-chip" data-tone={taskChip(summary).tone}>{taskChip(summary).label}</span>}
          </span>
          {summary?.resultPreview && <p>{summary.resultPreview}</p>}
        </li>)}
      </ul>}
    </div>
  </article>;
}
