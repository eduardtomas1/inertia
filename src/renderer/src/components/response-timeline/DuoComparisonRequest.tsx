import { useId, useState } from "react";
import { Ban, Check, ChevronDown, CircleAlert, type LucideIcon } from "lucide-react";
import type { DuoComparisonBrief, DuoComparisonBriefSide } from "@shared/duo-comparison-brief";

import type { ResponseTurn } from "../../utils/response-timeline/model";
import { providerIconDefinition } from "../../utils/providerIcons";
import { DUO_COMPARISON_REQUEST_LABEL } from "../../utils/response-timeline/virtualization";
import { messageContextMenu } from "./messageContextMenu";
import { ProviderBrandIcon } from "../ProviderBrandIcon";
import "./DuoComparisonRequest.css";

const STATUS: Record<DuoComparisonBriefSide["status"], { label: string; icon: LucideIcon }> = {
  completed: { label: "Completed", icon: Check },
  failed: { label: "Failed", icon: CircleAlert },
  cancelled: { label: "Cancelled", icon: Ban },
  interrupted: { label: "Interrupted", icon: CircleAlert },
};

function duoComparisonFilesLabel(count: number | null): string | null {
  if (count === null) return null;
  if (count === 0) return "No changes";
  return `${count} ${count === 1 ? "file" : "files"}`;
}

function ComparedSide({ label, side }: { label: "A" | "B"; side: DuoComparisonBriefSide }): React.JSX.Element {
  const status = STATUS[side.status];
  const StatusIcon = status.icon;
  const provider = side.providerId ? providerIconDefinition(side.providerId) : undefined;
  const files = duoComparisonFilesLabel(side.filesChanged);
  const title = side.title || "Untitled chat";
  return (
    <li className="duo-comparison-side" data-status={side.status}>
      <span className="duo-comparison-role" aria-hidden="true">{label}</span>
      <span className="duo-comparison-chat">
        <span className="visually-hidden">Chat {label}: </span>
        {side.providerId && (
          <ProviderBrandIcon providerId={side.providerId} label={provider?.label ?? side.providerId} size={14} />
        )}
        <span className="duo-comparison-title" title={title}>{title}</span>
      </span>
      <span className="duo-comparison-status">
        <StatusIcon size={13} aria-hidden="true" />
        {status.label}
      </span>
      {files && <span className="duo-comparison-files">{files}</span>}
    </li>
  );
}

export function DuoComparisonRequest({
  turn,
  brief,
  meta,
  footer,
  onBeforeToggle,
  onAfterToggle,
}: {
  turn: ResponseTurn;
  brief: DuoComparisonBrief;
  meta?: React.ReactNode;
  footer?: React.ReactNode;
  onBeforeToggle?: () => void;
  onAfterToggle?: () => void;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const headingId = useId();
  const briefId = useId();
  const toggle = (): void => {
    onBeforeToggle?.();
    setExpanded((current) => !current);
    window.requestAnimationFrame(() => onAfterToggle?.());
  };
  return (
    <article
      className="turn-user-request duo-comparison-request"
      aria-labelledby={headingId}
      data-turn-layer="user-request"
      data-turn-request-context={turn.id}
      data-turn-jump-target="request"
      data-message-search-id={turn.userMessage.id}
      tabIndex={-1}
      {...messageContextMenu(turn.userMessage, turn.userMessage.content)}
    >
      {meta}
      <p id={headingId} className="duo-comparison-heading">{DUO_COMPARISON_REQUEST_LABEL}</p>
      <ul className="duo-comparison-sides" aria-label="Compared chats">
        <ComparedSide label="A" side={brief.sides[0]} />
        <ComparedSide label="B" side={brief.sides[1]} />
      </ul>
      <button
        type="button"
        className="turn-user-request-expand duo-comparison-disclosure"
        aria-expanded={expanded}
        aria-controls={briefId}
        onClick={toggle}
      >
        {expanded ? "Hide the full brief" : "Show the full brief"}
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      <div id={briefId} className="duo-comparison-brief" hidden={!expanded}>
        {expanded ? turn.userMessage.content : null}
      </div>
      {footer}
    </article>
  );
}
