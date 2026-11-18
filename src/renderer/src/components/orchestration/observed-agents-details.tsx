import { lazy, Suspense, useId, useState } from "react";
import { useDelegationActions } from "./delegation-surface";
import "./delegation-panel.css";

const ObservedChildView = lazy(async () => ({ default: (await import("./observed-child-view")).ObservedChildView }));

export function ObservedAgentsDetails({ conversationId, turnId, turnIndex }: {
  conversationId: string;
  turnId: string;
  turnIndex?: number;
}): React.JSX.Element | null {
  const run = useDelegationActions()?.run;
  const [open, setOpen] = useState(false);
  const panelId = useId();
  if (!run) return null;
  return (
    <div className="subagent-group-details">
      <button
        type="button"
        className="subagent-group-inspect"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((current) => !current)}
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
