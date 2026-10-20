import type { CSSProperties } from "react";
import { CircleX, Clock, MessageCircleQuestion, ShieldAlert, type LucideIcon } from "lucide-react";
import { PROJECT_COLOR_PALETTE } from "@shared/project-colors";
import type { InitiativeColor } from "@shared/initiatives";

import type { InitiativeAggregate } from "../../utils/sidebarInitiatives";
import { AgentPixelGrid } from "../AgentPixelGrid";
import "./initiatives.css";

/** Theme-aware initiative colour, reusing the project palette tints. */
export function initiativeTintStyle(color: InitiativeColor): CSSProperties {
  const tints = PROJECT_COLOR_PALETTE[color];
  return {
    "--initiative-tint-light": tints.light,
    "--initiative-tint-dark": tints.dark,
  } as CSSProperties;
}

export function InitiativeDot({ color, size = 8 }: { color: InitiativeColor; size?: number }): React.JSX.Element {
  return (
    <span
      className="initiative-dot"
      aria-hidden="true"
      style={{ ...initiativeTintStyle(color), width: size, height: size }}
    />
  );
}

const ATTENTION_ICONS: Partial<Record<InitiativeAggregate["status"], LucideIcon>> = {
  approval: ShieldAlert,
  input: MessageCircleQuestion,
  failed: CircleX,
  limited: Clock,
};

export function initiativeAggregateLabel(aggregate: InitiativeAggregate): string | null {
  const parts = [
    aggregate.attentionCount > 0 ? `${aggregate.attentionCount} waiting on you` : null,
    aggregate.workingCount > 0 ? `${aggregate.workingCount} working` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(", ") : null;
}

/**
 * The quiet aggregate cue on an initiative section: the count of chats that
 * need the user, in the most urgent member's colour, or the working glyph.
 */
export function InitiativeStatusBadge({ aggregate }: { aggregate: InitiativeAggregate }): React.JSX.Element | null {
  const Icon = ATTENTION_ICONS[aggregate.status];
  if (aggregate.attentionCount > 0 && Icon) {
    return (
      <span className="initiative-status-badge" data-initiative-status={aggregate.status} aria-hidden="true">
        <Icon size={13} />
        <span>{aggregate.attentionCount}</span>
      </span>
    );
  }
  if (aggregate.workingCount > 0) {
    return (
      <span className="initiative-status-badge" data-initiative-status="working" aria-hidden="true">
        <AgentPixelGrid animated rhythm="orbit" />
      </span>
    );
  }
  return null;
}
