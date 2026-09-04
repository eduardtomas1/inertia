import clsx from "clsx";
import { Folder, FolderOpen } from "lucide-react";
import type { Project } from "@shared/contracts";

const PROJECT_STATUS_LABELS: Record<
  Exclude<Project["status"], "ready">,
  string
> = {
  working: "Working",
  attention: "Needs attention",
};

export function sidebarChatEntranceStyle(index: number): React.CSSProperties {
  return { "--chat-index": Math.min(index, 8) } as React.CSSProperties;
}

export function SidebarProjectDisclosure({
  expanded,
  projectName,
  onToggle,
}: {
  expanded: boolean;
  projectName: string;
  onToggle: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="project-expand"
      aria-label={`${expanded ? "Collapse" : "Expand"} ${projectName}`}
      aria-expanded={expanded}
      onClick={onToggle}
    >
      {expanded
        ? <FolderOpen size={15} aria-hidden="true" />
        : <Folder size={15} aria-hidden="true" />}
    </button>
  );
}

export function SidebarProjectState({
  status,
  conversationCount,
}: {
  status: Project["status"];
  conversationCount: number;
}): React.JSX.Element {
  return (
    <>
      {status === "ready" ? null : (
        <span className={clsx("project-state", `state-${status}`)}>
          <span
            className={clsx("project-status", `status-${status}`)}
            aria-hidden="true"
          />
          {PROJECT_STATUS_LABELS[status]}
        </span>
      )}
      {conversationCount > 0 && (
        <>
          <span className="project-count" aria-hidden="true">
            {conversationCount}
          </span>
          <span className="visually-hidden">
            {conversationCount} {
            conversationCount === 1 ? "chat" : "chats"
            }
          </span>
        </>
      )}
    </>
  );
}
