import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FolderGit2, GitBranch } from "lucide-react";
import type { Conversation, Project } from "@shared/contracts";
import { ProviderBrandIcon } from "../ProviderBrandIcon";
import { ProjectIcon } from "../ProjectIcon";

function ThreadPreview({ conversation, project, anchor, onEnter, onLeave }: {
  conversation: Conversation; project?: Project; anchor: HTMLElement;
  onEnter: () => void; onLeave: () => void;
}): React.JSX.Element {
  const surface = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = surface.current;
    if (!node) return;
    const rect = anchor.getBoundingClientRect();
    node.style.left = `${Math.max(8, Math.min(rect.right + 8, window.innerWidth - node.offsetWidth - 8))}px`;
    node.style.top = `${Math.max(8, Math.min(rect.top, window.innerHeight - node.offsetHeight - 8))}px`;
  }, [anchor]);
  return createPortal(<div ref={surface} role="tooltip" id={`thread-preview-${conversation.id}`}
    className="thread-hover-preview" onPointerEnter={onEnter} onPointerLeave={onLeave}>
    <strong>{conversation.title}</strong>
    <span>{project ? <ProjectIcon project={project} size={13} /> : <FolderGit2 size={13} />}{project?.name ?? "Project unavailable"}</span>
    {conversation.branch && <span><GitBranch size={13} />{conversation.branch}</span>}
    <span><ProviderBrandIcon providerId={conversation.providerId} size={14} />{conversation.modelSelection.alias || conversation.model || "Provider default"}</span>
  </div>, document.body);
}

/** One delayed preview for the whole virtualized index; no per-row timers. */
export function useThreadPreview(conversations: readonly Conversation[], projects: readonly Project[], disabled: boolean) {
  const [target, setTarget] = useState<{ id: string; anchor: HTMLElement } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimer = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const close = useCallback(() => { clearTimer(); setTarget(null); }, [clearTimer]);
  const leave = useCallback(() => {
    clearTimer(); timer.current = setTimeout(() => setTarget(null), 150);
  }, [clearTimer]);
  const enter = useCallback((id: string, anchor: HTMLElement) => {
    clearTimer(); setTarget(null);
    if (disabled) return;
    timer.current = setTimeout(() => {
      if (anchor.isConnected) setTarget({ id, anchor });
    }, 2000);
  }, [clearTimer, disabled]);
  useEffect(() => {
    if (disabled) close();
  }, [close, disabled]);
  useEffect(() => {
    const key = (event: KeyboardEvent): void => { if (event.key === "Escape") close(); };
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", key);
    return () => {
      clearTimer();
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", key);
    };
  }, [clearTimer, close]);
  const conversation = target && !disabled && target.anchor.isConnected
    ? conversations.find(({ id }) => id === target.id) : undefined;
  return {
    enter, leave, close,
    describedId: conversation ? `thread-preview-${conversation.id}` : undefined,
    conversationId: conversation?.id,
    preview: conversation && target ? <ThreadPreview key={conversation.id} conversation={conversation}
      project={projects.find(({ id }) => id === conversation.projectId)} anchor={target.anchor}
      onEnter={clearTimer} onLeave={leave} /> : null,
  };
}
