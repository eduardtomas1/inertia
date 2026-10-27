import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { PanelTopOpen, Pin, PinOff, X } from "lucide-react";

import { IconButton } from "../ui";

export interface DetachedWindowActionsProps {
  alwaysOnTop: boolean;
  pinning: boolean;
  onToggleAlwaysOnTop: () => void;
  onDock: () => void;
  onClose: () => void;
}

export function DetachedWindowActions({
  alwaysOnTop,
  pinning,
  onToggleAlwaysOnTop,
  onDock,
  onClose,
}: DetachedWindowActionsProps): React.JSX.Element {
  return (
    <>
      <IconButton
        className="corner-toggle"
        label={alwaysOnTop ? "Unpin chat window" : "Keep chat window on top"}
        aria-pressed={alwaysOnTop}
        disabled={pinning}
        onClick={onToggleAlwaysOnTop}
      >
        {alwaysOnTop ? <PinOff size={16} /> : <Pin size={16} />}
      </IconButton>
      <IconButton className="corner-toggle" label="Return chat to main window" onClick={onDock}>
        <PanelTopOpen size={16} />
      </IconButton>
      <IconButton className="corner-toggle" label="Close chat window" onClick={onClose}>
        <X size={16} />
      </IconButton>
    </>
  );
}

function CornerControls({
  children,
  onWidthChange,
}: {
  children: ReactNode;
  onWidthChange: (width: number) => void;
}): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = rootRef.current;
    if (node) onWidthChange(Math.ceil(node.getBoundingClientRect().width));
  }, [onWidthChange]);
  return (
    <div ref={rootRef} className="workspace-corner-controls no-drag" data-panel-layout-controls>
      {children}
    </div>
  );
}

export function DetachedChromeFallback({
  title,
  windowActions,
  children,
}: {
  title: string;
  windowActions: DetachedWindowActionsProps;
  children?: ReactNode;
}): React.JSX.Element {
  const [cornerWidth, setCornerWidth] = useState(0);
  return (
    <div
      className="workspace-frame has-corner-controls"
      style={{ "--workspace-corner-controls-width": `${cornerWidth}px` } as CSSProperties}
    >
      <header className="workspace-header drag-region">
        <div className="header-leading">
          <nav className="header-breadcrumb" aria-label="Chat breadcrumb">
            <div className="header-title-wrap">
              <h1><span className="header-title-text">{title}</span></h1>
            </div>
          </nav>
        </div>
      </header>
      <CornerControls onWidthChange={setCornerWidth}>
        <DetachedWindowActions {...windowActions} />
      </CornerControls>
      <div className="workspace-body">{children}</div>
    </div>
  );
}
