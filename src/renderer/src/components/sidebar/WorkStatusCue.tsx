import { useEffect, useLayoutEffect, useReducer, useState } from "react";
import {
  CheckCircle2,
  CircleX,
  MessageCircleQuestion,
  Minus,
  ShieldAlert,
  type LucideIcon,
} from "lucide-react";
import { useDocumentVisibility } from "../../hooks/useDocumentPresence";
import { formatRelativeTime, formatWorkAge } from "../../lib/format";
import type { SidebarThreadStatus } from "../../utils/sidebarModel";
import { AgentPixelGrid } from "../AgentPixelGrid";

type SettledCueStatus = Exclude<SidebarThreadStatus, "idle" | "working">;

const SETTLED_CUE_ICONS: Record<SettledCueStatus, LucideIcon> = {
  approval: ShieldAlert,
  input: MessageCircleQuestion,
  failed: CircleX,
  completed: CheckCircle2,
};

/** The label shows whole minutes, so a coarse refresh keeps it current. */
const ELAPSED_REFRESH_MS = 15_000;

/**
 * The status each thread was last shown with. Module scope keeps it across
 * the remounts a virtualized list performs while scrolling, so only a status
 * the user has not seen yet plays its arrival cue, and nothing replays on the
 * first render after launch.
 */
const lastShownStatus = new Map<string, SidebarThreadStatus>();
const MAX_REMEMBERED_STATUSES = 1_024;

function useStatusArrival(conversationId: string, status: SidebarThreadStatus): boolean {
  const [arrivedStatus, setArrivedStatus] = useState<SidebarThreadStatus | null>(null);
  useLayoutEffect(() => {
    const previous = lastShownStatus.get(conversationId);
    lastShownStatus.delete(conversationId);
    lastShownStatus.set(conversationId, status);
    // An evicted row uses first-render semantics when revisited: no false pop.
    if (lastShownStatus.size > MAX_REMEMBERED_STATUSES) {
      const oldest = lastShownStatus.keys().next().value;
      if (oldest !== undefined) lastShownStatus.delete(oldest);
    }
    if (previous !== undefined && previous !== status) setArrivedStatus(status);
  }, [conversationId, status]);
  return arrivedStatus === status;
}

function useCoarseClock(active: boolean): void {
  const documentVisible = useDocumentVisibility();
  const [, tick] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    if (!active || !documentVisible) return;
    tick();
    const timer = window.setInterval(tick, ELAPSED_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [active, documentVisible]);
}

/**
 * The trailing status of a Work row. Only Working moves: it shows the chat's
 * pixel glyph and how long the run has been going. Every other status sits
 * still after one short arrival cue.
 */
export function WorkStatusCue({
  conversationId,
  status,
  label,
  updatedAt,
  workingSince,
}: {
  conversationId: string;
  status: SidebarThreadStatus;
  label: string;
  updatedAt: string;
  /** Start of the running workspace run, when the snapshot knows it. */
  workingSince: string | null;
}): React.JSX.Element {
  const arrived = useStatusArrival(conversationId, status);
  useCoarseClock(status === "working" && workingSince !== null);

  if (status === "idle") {
    return (
      <time dateTime={updatedAt} title={formatRelativeTime(updatedAt)}>
        <span className="activity-idle-icon" data-work-status="idle"><Minus size={10} /></span>
        {formatWorkAge(updatedAt)}
      </time>
    );
  }

  if (status === "working") {
    const elapsed = workingSince ? formatWorkAge(workingSince) : null;
    const showElapsed = elapsed !== null && elapsed !== "now";
    return (
      <span
        className="activity-thread-status-label"
        data-work-elapsed={showElapsed ? "" : undefined}
      >
        <span data-work-status="working">
          <AgentPixelGrid animated rhythm="orbit" />
        </span>
        <span className="work-status-word">{label}</span>
        {showElapsed ? (
          <>
            <span className="work-status-separator">·</span>
            <span className="work-status-elapsed">{elapsed}</span>
          </>
        ) : null}
      </span>
    );
  }

  const Icon = SETTLED_CUE_ICONS[status];
  return (
    <span className="activity-thread-status-label">
      <span data-work-status={status} data-work-arrival={arrived ? "" : undefined}>
        <Icon size={12} />
      </span>
      {label}
    </span>
  );
}
