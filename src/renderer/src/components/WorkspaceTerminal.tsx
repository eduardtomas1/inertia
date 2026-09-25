import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { createPortal } from "react-dom";
import { usePersistedSize } from "../hooks/usePersistedSize";
import { PaneResizeHandle } from "./PaneResizeHandle";
import type { TerminalPanelProps } from "./TerminalPanelSupport";
import { TerminalPanel } from "./TerminalPanel";

const TERMINAL_DOCK_MIN_HEIGHT = 140;
const TERMINAL_DOCK_MAX_HEIGHT = 640;
const TERMINAL_DOCK_DEFAULT_HEIGHT = 260;

/** Keeps one mounted terminal panel while its DOM moves between dock and surface. */
export function WorkspaceTerminal({
  terminal,
  terminalKey,
  inSurface,
  containerRef,
  surfaceTarget,
}: {
  terminal: TerminalPanelProps;
  terminalKey: string;
  inSurface: boolean;
  containerRef: RefObject<HTMLDivElement | null>;
  surfaceTarget: HTMLDivElement | null;
}): React.JSX.Element {
  const id = useId();
  const [persistedHeight, setPersistedHeight] = usePersistedSize(
    "inertia:layout:terminal-dock-height:v1",
    TERMINAL_DOCK_DEFAULT_HEIGHT,
    { min: TERMINAL_DOCK_MIN_HEIGHT, max: TERMINAL_DOCK_MAX_HEIGHT },
  );
  const [height, setHeight] = useState(persistedHeight);
  useEffect(() => setHeight(persistedHeight), [persistedHeight]);
  const open = Boolean(terminal.visible) && !inSurface;
  const dockTarget = useRef<HTMLDivElement>(null);
  // One stable portal host preserves xterm instances, selection and ownership
  // when the same terminals move between the dock and a panel surface.
  const [host] = useState(() => {
    const element = document.createElement("div");
    element.className = "workspace-terminal-host";
    return element;
  });
  useLayoutEffect(() => {
    const target = inSurface ? surfaceTarget : dockTarget.current;
    target?.append(host);
    return () => host.remove();
  }, [host, inSurface, surfaceTarget, terminalKey, terminal.visible]);
  return (
    <>
      {open && (
        <PaneResizeHandle
          label="Resize terminal"
          controls={id}
          containerRef={containerRef}
          orientation="horizontal"
          pane="after"
          value={height}
          min={TERMINAL_DOCK_MIN_HEIGHT}
          max={TERMINAL_DOCK_MAX_HEIGHT}
          defaultValue={TERMINAL_DOCK_DEFAULT_HEIGHT}
          onChange={setHeight}
          onCommit={setPersistedHeight}
          className="terminal-dock-resize-handle"
        />
      )}
      <section
        id={id}
        className="terminal-dock"
        aria-label="Terminal"
        hidden={!open}
        style={{ "--terminal-dock-height": `${height}px` } as CSSProperties}
      >
        <div ref={dockTarget} className="terminal-dock-slot" />
        {createPortal(
          <TerminalPanel key={terminalKey} {...terminal} />,
          host,
        )}
      </section>
    </>
  );
}
