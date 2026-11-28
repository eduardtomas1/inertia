import { lazy, Suspense, useId, useState } from "react";
import { useDelegationActions } from "./delegation-surface";
import "./delegation-panel.css";

const ObservedChildView = lazy(async () => ({ default: (await import("./observed-child-view")).ObservedChildView }));

const MAX_OPEN_ENTRIES = 500;
const openByTurn = new Map<string, boolean>();

function readOpen(key: string): boolean {
  return openByTurn.get(key) ?? false;
}

function writeOpen(key: string, open: boolean): void {
  openByTurn.delete(key);
  openByTurn.set(key, open);
  if (openByTurn.size > MAX_OPEN_ENTRIES) {
    const oldest = openByTurn.keys().next().value;
    if (oldest !== undefined) openByTurn.delete(oldest);
  }
}

export function clearObservedAgentsDetailsState(): void {
  openByTurn.clear();
}

export function ObservedAgentsDetails({ conversationId, turnId, turnIndex, onBeforeToggle, onAfterToggle }: {
  conversationId: string;
  turnId: string;
  turnIndex?: number;
  onBeforeToggle?: () => void;
  onAfterToggle?: () => void;
}): React.JSX.Element | null {
  const run = useDelegationActions()?.run;
  const stateKey = `${conversationId}:${turnId}`;
  const [trackedKey, setTrackedKey] = useState(stateKey);
  const [open, setOpen] = useState(() => readOpen(stateKey));
  if (trackedKey !== stateKey) {
    setTrackedKey(stateKey);
    setOpen(readOpen(stateKey));
  }
  const panelId = useId();
  if (!run) return null;
  const toggle = () => {
    onBeforeToggle?.();
    const next = !open;
    writeOpen(stateKey, next);
    setOpen(next);
    window.requestAnimationFrame(() => onAfterToggle?.());
  };
  return (
    <div className="subagent-group-details">
      <button
        type="button"
        className="subagent-group-inspect"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={toggle}
      >
        {open ? "Hide agent details" : "Agent details"}
      </button>
      <div id={panelId} className="subagent-group-observed" hidden={!open}>
        {open && (
          <Suspense fallback={null}>
            <ObservedChildView
              conversationId={conversationId}
              turnId={turnId}
              turnLabel={turnIndex === undefined ? "Turn" : `Turn ${turnIndex}`}
              run={run}
            />
          </Suspense>
        )}
      </div>
    </div>
  );
}
