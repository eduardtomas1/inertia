import { createContext, lazy, Suspense, useContext, useMemo, useState, useEffect, type ReactNode } from "react";
import { BookmarkPlus, ScrollText } from "lucide-react";
import { useNativePreviewSuspension } from "../../hooks/useNativePreviewSuspension";
import type { ChatMessage } from "@shared/contracts";
import { IconButton } from "../ui";
import type { ProjectMemoryPanelProps } from "./types";

const Dialog = lazy(() => import("./ProjectMemoryDialog"));
type Selection = { message?: ChatMessage; turnId?: string };
const MemoryActions = createContext<{ open(selection: Selection): void; disabled: boolean } | null>(null);

export function ProjectMemoryHost({ children, request, ...props }: Omit<ProjectMemoryPanelProps, "request"> & {
  request?: ProjectMemoryPanelProps["request"];
  children: ReactNode;
}): React.JSX.Element {
  const [selection, setSelection] = useState<(Selection & { projectId: string; conversationId?: string }) | null>(null);
  const { projectId, conversationId } = props;
  const active = selection?.projectId === projectId && selection.conversationId === conversationId ? selection : null;
  useEffect(() => { setSelection(null); }, [projectId, conversationId]);
  useNativePreviewSuspension(active !== null);
  const actions = useMemo(() => request ? {
    open: (next: Selection) => setSelection({ ...next, projectId, conversationId }), disabled: props.disabled === true,
  } : null, [request, props.disabled, projectId, conversationId]);
  return <MemoryActions.Provider value={actions}>
    {children}
    {active && request && <Suspense fallback={null}>
      <Dialog key={`${projectId}:${conversationId}`} {...props} request={request} sourceMessage={active.message} turnId={active.turnId} onClose={() => setSelection(null)} />
    </Suspense>}
  </MemoryActions.Provider>;
}

export function ProjectMemoryButton(): React.JSX.Element | null {
  const actions = useContext(MemoryActions);
  if (!actions) return null;
  return <IconButton label="Rules & decisions" aria-haspopup="dialog" disabled={actions.disabled} onClick={() => actions.open({})}>
    <ScrollText size={15} aria-hidden="true" />
  </IconButton>;
}

export function RememberProjectMessage({ message, className = "turn-action" }: { message: ChatMessage; className?: string }): React.JSX.Element | null {
  const actions = useContext(MemoryActions);
  if (!actions || !message.content.trim()) return null;
  return <button type="button" className={className} title="Remember for this project" aria-label="Remember for this project"
    aria-haspopup="dialog" disabled={actions.disabled} onClick={() => actions.open({ message })}>
    <BookmarkPlus size={12} aria-hidden="true" /><span>Remember</span>
  </button>;
}

export function SentProjectMemoryButton({ turnId }: { turnId: string }): React.JSX.Element | null {
  const actions = useContext(MemoryActions);
  if (!actions) return null;
  return <button type="button" className="message-revert" aria-haspopup="dialog" disabled={actions.disabled} onClick={() => actions.open({ turnId })}>
    <ScrollText size={12} aria-hidden="true" /><span>Project context</span>
  </button>;
}
