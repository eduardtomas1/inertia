import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { GitFork } from "lucide-react";
import type { ServerEvent } from "@shared/contracts";
import type { ForkHistoryResult } from "@shared/orchestration-forks";
import { forkHistoryResultSchema } from "@shared/orchestration-forks";
import type { CommandWithoutId } from "../../lib/runtimeCommands";
import "./fork-surface.css";

type ForkCommand = Extract<CommandWithoutId, { type: "conversation.fork" | "conversation.fork.history" }>;
export type ForkCommandRunner = (key: ForkCommand["type"], command: ForkCommand) => Promise<ServerEvent>;
interface ForkSurface { projectId: string; conversationId: string; run: ForkCommandRunner }
const Context = createContext<ForkSurface | null>(null);

export function useForkActionsAvailable(): boolean {
  return useContext(Context) !== null;
}

export function ForkSurfaceProvider({ projectId, conversationId, run, children }: {
  projectId: string; conversationId: string; run?: ForkCommandRunner; children: ReactNode;
}) {
  const value = useMemo(() => run ? { projectId, conversationId, run } : null, [projectId, conversationId, run]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function ForkTurnAction({ turnId }: { turnId: string }) {
  const surface = useContext(Context);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!surface) return null;
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
  </span>;
}

export function ForkHistoryPanel() {
  const surface = useContext(Context);
  return surface ? <ForkHistoryView key={surface.conversationId} surface={surface} /> : null;
}

function ForkHistoryView({ surface }: { surface: ForkSurface }) {
  const [page, setPage] = useState<ForkHistoryResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { conversationId, run } = surface;
  useEffect(() => {
    let current = true;
    void run("conversation.fork.history", { type: "conversation.fork.history", payload: { conversationId, limit: 1 } })
      .then((response) => {
        if (!current) return;
        if (response.type !== "request.result") throw new Error("The inherited history response is unavailable.");
        setPage(forkHistoryResultSchema.parse(response.result));
      }).catch(() => { if (current) setError("Inherited history could not be loaded."); });
    return () => { current = false; };
  }, [conversationId, run]);
  if (!page?.lineage) return null;
  const more = async () => {
    if (busy || page.next === null) return;
    setBusy(true); setError(null);
    try {
      const response = await run("conversation.fork.history", { type: "conversation.fork.history",
        payload: { conversationId, afterRevision: page.next, limit: 4 } });
      if (response.type !== "request.result") throw new Error("History is unavailable.");
      const next = forkHistoryResultSchema.parse(response.result);
      if (next.conversationId !== conversationId) throw new Error("History belongs to another chat.");
      setPage((previous) => previous ? { ...next, parts: [...previous.parts, ...next.parts] } : next);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "History could not be loaded."); }
    finally { setBusy(false); }
  };
  return <details className="fork-history-panel">
    <summary><GitFork size={16} aria-hidden="true" /> Inherited history · {page.lineage.inheritedItems} items</summary>
    <p>This chat starts at the selected run. Choose a provider and model before sending your first message.</p>
    {page.parts.map((part) => <details className="fork-history-item" key={part.id}>
      <summary>{part.kind.replaceAll("-", " ")} · {new Date(part.createdAt).toLocaleString()}
        {part.parts > 1 ? ` · part ${part.part + 1} of ${part.parts}` : ""}</summary>
      <pre>{part.text}</pre>
    </details>)}
    {page.next !== null && <button type="button" className="subtle-button" disabled={busy} onClick={() => { void more(); }}>
      {busy ? "Loading…" : "Load more inherited history"}
    </button>}
    {error && <p role="alert">{error}</p>}
  </details>;
}
