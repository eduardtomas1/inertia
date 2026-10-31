import { useEffect, useState } from "react";
import { GitFork } from "lucide-react";
import type { ForkHistoryResult } from "@shared/orchestration-forks";
import { forkHistoryResultSchema } from "@shared/orchestration-forks";
import { HistoryStartRollback, MergeBackAction } from "./history-actions";
import { noteForkLineage } from "./history-session";
import type { ForkSurface } from "./fork-surface-model";

export function ForkHistoryView({ surface }: { surface: ForkSurface }) {
  return <><ForkLineage surface={surface} /><HistoryStartRollback surface={surface} /></>;
}

function ForkLineage({ surface }: { surface: ForkSurface }) {
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
        const loaded = forkHistoryResultSchema.parse(response.result);
        noteForkLineage(conversationId, loaded.lineage !== null);
        setPage(loaded);
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
  return <section className="fork-history" aria-label="Fork lineage"><details className="fork-history-panel">
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
  </details><MergeBackAction surface={surface} /></section>;
}
