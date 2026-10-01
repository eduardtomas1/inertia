import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useNativePreviewSuspension } from "../../hooks/useNativePreviewSuspension";
import { captureModalFocus, trapModalFocus } from "../../utils/modalFocus";
import ProjectMemoryPanel from "./ProjectMemoryPanel";
import type { ProjectMemoryPanelProps } from "./types";

export default function ProjectMemoryDialog({ turnId, onClose, ...props }: ProjectMemoryPanelProps & {
  turnId?: string;
  onClose(): void;
}): React.JSX.Element {
  const titleId = useId();
  const root = useRef<HTMLDivElement>(null);
  const [context, setContext] = useState<string | null | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hasDraft, setHasDraft] = useState(Boolean(props.sourceMessage));
  useNativePreviewSuspension(true);
  useLayoutEffect(() => {
    const restore = captureModalFocus();
    root.current?.focus();
    return restore;
  }, []);
  const { request, projectId, conversationId } = props;
  useEffect(() => {
    if (!turnId || !conversationId) return;
    let cancelled = false;
    void request({ type: "project.memory.context", payload: {
      projectId, conversationId, turnId,
    } }).then((event) => {
      if (cancelled) return;
      if (event.type !== "request.result" || event.result.kind !== "project.memory.context"
        || event.result.projectId !== projectId || event.result.conversationId !== conversationId || event.result.turnId !== turnId) {
        throw new Error("The local service returned unexpected project context.");
      }
      setContext(event.result.context);
    }).catch((cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : "The saved context could not be loaded.");
    });
    return () => { cancelled = true; };
  }, [request, projectId, conversationId, turnId]);
  const close = (): void => {
    if (busy) return;
    if (hasDraft && !window.confirm("Discard this unsaved project memory draft?")) return;
    onClose();
  };
  return createPortal(<div className="dialog-backdrop">
    <div ref={root} tabIndex={-1} className="project-memory-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}
      onKeyDown={(event) => {
        trapModalFocus(event, event.currentTarget);
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
      }}>
      <div className="project-memory-dialog-bar"><span id={titleId}>{turnId ? "Project context for this turn" : "Project memory"}</span>
        <button type="button" className="icon-button" aria-label="Close project memory" disabled={busy} onClick={close}><X size={16} /></button></div>
      {turnId ? <section className="project-memory">
        <h2>Included when this turn started</h2><p className="project-memory-help">This is the saved context for this turn. Later project edits do not change it.</p>
        {error ? <p role="alert">{error}</p> : context === undefined ? <p role="status">Loading saved context…</p>
          : <pre className="project-memory-sent-context" aria-label="Saved project context">{context ?? "No project rules or decisions were included in this turn."}</pre>}
      </section> : <ProjectMemoryPanel {...props} onBusyChange={setBusy} onDraftChange={setHasDraft} />}
    </div>
  </div>, document.body);
}
