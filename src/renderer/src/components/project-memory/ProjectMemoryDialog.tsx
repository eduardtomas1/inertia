import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useNativePreviewSuspension } from "../../hooks/useNativePreviewSuspension";
import { captureModalFocus, trapModalFocus } from "../../utils/modalFocus";
import { IconButton } from "../ui";
import ProjectMemoryPanel from "./ProjectMemoryPanel";
import type { ProjectMemoryPanelProps } from "./types";

export default function ProjectMemoryDialog({ turnId, onClose, ...props }: ProjectMemoryPanelProps & {
  turnId?: string;
  onClose(): void;
}): React.JSX.Element {
  const titleId = useId();
  const descriptionId = useId();
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
    if (hasDraft && !window.confirm("Discard this unsaved rule or decision?")) return;
    onClose();
  };
  const title = turnId ? "Project context" : "Rules & decisions";
  return createPortal(<div className="dialog-backdrop">
    <div ref={root} tabIndex={-1} className="commit-dialog project-memory-dialog" role="dialog" aria-modal="true"
      aria-labelledby={titleId} aria-describedby={descriptionId}
      onKeyDown={(event) => {
        trapModalFocus(event, event.currentTarget);
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
      }}>
      <header>
        <div>
          <h2 id={titleId}>{title}</h2>
          <p id={descriptionId}>{turnId ? "Saved when this turn started. Later edits do not change it." : props.projectName}</p>
        </div>
        <IconButton label={`Close ${turnId ? "project context" : "rules & decisions"}`} disabled={busy} onClick={close}>
          <X size={16} aria-hidden="true" />
        </IconButton>
      </header>
      <div className="project-memory-dialog-body">
        {turnId
          ? error ? <p className="project-memory-error" role="status">{error}</p>
            : context === undefined ? <p className="project-memory-help" role="status">Loading saved context…</p>
              : context === null ? <p className="project-memory-empty">No rules or decisions were included in this turn.</p>
                : <pre className="project-memory-code" tabIndex={0} aria-label="Saved project context">{context}</pre>
          : <ProjectMemoryPanel {...props} onBusyChange={setBusy} onDraftChange={setHasDraft} />}
      </div>
    </div>
  </div>, document.body);
}
