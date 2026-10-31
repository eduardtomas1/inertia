import { createContext, lazy, Suspense, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { GitFork } from "lucide-react";
import type { ForkCommandRunner, ForkSurface } from "./fork-surface-model";
import "./fork-surface.css";

const HistoryTurnActions = lazy(async () => ({ default: (await import("./history-actions")).HistoryTurnActions }));
const ForkHistoryView = lazy(async () => ({ default: (await import("./fork-history-view")).ForkHistoryView }));

export type { ForkCommandRunner } from "./fork-surface-model";
const Context = createContext<ForkSurface | null>(null);
const NO_ROLLED_BACK_TURNS: ReadonlySet<string> = new Set();

export function useForkActionsAvailable(): boolean {
  return useContext(Context) !== null;
}

export function useTurnRolledBack(turnId: string): boolean {
  return useContext(Context)?.rolledBack.has(turnId) ?? false;
}

export function ForkSurfaceProvider({ projectId, conversationId, run, rolledBackTurnIds, canRollBackToStart = false, children }: {
  projectId: string; conversationId: string; run?: ForkCommandRunner; rolledBackTurnIds?: readonly string[];
  canRollBackToStart?: boolean; children: ReactNode;
}) {
  const rolledBack = useMemo(() => rolledBackTurnIds?.length ? new Set(rolledBackTurnIds) : NO_ROLLED_BACK_TURNS, [rolledBackTurnIds]);
  const value = useMemo(() => run ? { projectId, conversationId, run, rolledBack, canRollBackToStart } : null,
    [projectId, conversationId, run, rolledBack, canRollBackToStart]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function ForkTurnAction({ turnId }: { turnId: string }) {
  const surface = useContext(Context);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!surface) return null;
  if (surface.rolledBack.has(turnId)) {
    return <span className="fork-turn-action fork-turn-rolled-back">Rolled back · not in context</span>;
  }
  const fork = async () => {
    setBusy(true); setError(null);
    try {
      const response = await surface.run("conversation.fork", { type: "conversation.fork", payload: {
        projectId: surface.projectId, sourceConversationId: surface.conversationId, sourceTurnId: turnId, activate: true,
      } });
      if (response.type !== "request.result" || response.result.kind !== "conversation.created") {
        throw new Error("The service did not confirm the fork. Check the sidebar before trying again.");
      }
    } catch (failure) { setError(failure instanceof Error ? failure.message : "The chat could not be forked."); }
    finally { setBusy(false); }
  };
  return <span className="fork-turn-action">
    <button type="button" className="turn-run-details-toggle" disabled={busy} onClick={() => { void fork(); }}>
      <GitFork size={14} aria-hidden="true" /><span>{busy ? "Forking…" : "Fork from here"}</span>
    </button>
    {error && <span role="alert">{error}</span>}
    <Suspense fallback={null}><HistoryTurnActions surface={surface} turnId={turnId} /></Suspense>
  </span>;
}

export function ForkHistoryPanel() {
  const surface = useContext(Context);
  return surface ? <Suspense fallback={null}><ForkHistoryView key={surface.conversationId} surface={surface} /></Suspense> : null;
}
