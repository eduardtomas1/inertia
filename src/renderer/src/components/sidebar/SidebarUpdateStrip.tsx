import { useEffect, useRef, useState } from "react";
import { CircleCheck, Download, RotateCw, TriangleAlert, X } from "lucide-react";
import { IconButton, LoadingMark } from "../ui";
import type { UpdateStripView } from "./updateStripView";

const EXIT_FALLBACK_MS = 220;

function StripIcon({ view }: { view: UpdateStripView }): React.JSX.Element {
  if (view.icon === "loading") return <LoadingMark size={14} aria-hidden="true" />;
  if (view.icon === "download") return <Download size={14} aria-hidden="true" />;
  if (view.icon === "restart") return <RotateCw size={14} aria-hidden="true" />;
  if (view.icon === "done") return <CircleCheck size={14} aria-hidden="true" />;
  return <TriangleAlert size={14} aria-hidden="true" />;
}

export function SidebarUpdateStrip({ view, expanded, popupId, onOpen, onDismiss, onRestart, onFocusLost }: {
  view: UpdateStripView | null;
  expanded: boolean;
  popupId: string;
  onOpen: (element: HTMLElement) => void;
  onDismiss: (view: UpdateStripView) => void;
  onRestart: () => void;
  onFocusLost: () => void;
}): React.JSX.Element | null {
  const [shown, setShown] = useState<UpdateStripView | null>(view);
  const [leaving, setLeaving] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const exitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  if (view && (view !== shown || leaving)) {
    setShown(view);
    setLeaving(false);
  } else if (!view && shown && !leaving) {
    setLeaving(true);
  }
  useEffect(() => {
    if (!leaving) return;
    if (root.current?.contains(document.activeElement)) onFocusLost();
    const finish = (): void => { setShown(null); setLeaving(false); };
    exitTimer.current = setTimeout(finish, EXIT_FALLBACK_MS);
    return () => { if (exitTimer.current) clearTimeout(exitTimer.current); };
  }, [leaving, onFocusLost]);
  if (!shown) return null;
  const label = shown.meta ? `${shown.title}, ${shown.meta}` : shown.title;
  return <div ref={root} className={`sidebar-update-strip-slot${leaving ? "" : " is-open"}`}
    onTransitionEnd={(event) => {
      if (leaving && event.target === event.currentTarget && event.propertyName === "grid-template-rows") {
        setShown(null); setLeaving(false);
      }
    }}>
    <div>
      <div className="sidebar-update-strip" data-tone={shown.tone} data-active={shown.active || undefined}
        style={shown.progress === null ? undefined : { "--progress": shown.progress } as React.CSSProperties}
        onAnimationEnd={(event) => {
          if (event.animationName === "sidebar-update-drain" && !leaving) onDismiss(shown);
        }}>
        {shown.autoDismiss && <span key={shown.key} className="sidebar-update-strip-drain" aria-hidden="true" />}
        <button type="button" className="sidebar-update-strip-main" aria-label={label}
          aria-haspopup="dialog" aria-expanded={expanded} aria-controls={expanded ? popupId : undefined} onClick={(event) => onOpen(event.currentTarget)}>
          <span key={`${shown.icon}:${shown.tone}`} className="sidebar-update-strip-icon"><StripIcon view={shown} /></span>
          <span key={shown.title} className="sidebar-update-strip-title">{shown.title}</span>
          {shown.meta && <span className={`sidebar-update-strip-meta${shown.slow ? " is-slow" : ""}`}>{shown.meta}</span>}
        </button>
        {shown.action === "restart" && <button type="button" className="sidebar-update-strip-action" onClick={onRestart}>Restart</button>}
        {shown.dismissible && <IconButton label="Dismiss update notice" onClick={() => onDismiss(shown)}><X size={14} /></IconButton>}
      </div>
    </div>
  </div>;
}
