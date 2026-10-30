import { useEffect, useRef, useState } from "react";
import { GitMerge, Undo2 } from "lucide-react";
import { conversationRollbackResultSchema, type ConversationRollbackResult } from "@shared/orchestration-history";
import { mergeBackResultSchema, type MergeBackResult } from "@shared/orchestration-merge-back";
import type { ForkSurface } from "./fork-surface-model";

function turns(count: number): string {
  return `${count} later ${count === 1 ? "turn" : "turns"}`;
}

function rollbackMessage(result: ConversationRollbackResult): string {
  if (result.transfer === "unchanged") return "Nothing after this turn needed rolling back.";
  return result.transfer === "native"
    ? `Rolled back ${turns(result.rolledBackTurns)}. The provider session continues from this turn.`
    : `Rolled back ${turns(result.rolledBackTurns)}. The next message starts a fresh provider session with the retained history.`;
}

function mergeBackMessage(result: MergeBackResult): string {
  const omitted = result.omittedMessageCount > 0 ? ` ${result.omittedMessageCount} older messages were left out.` : "";
  return `Attached ${result.messageCount} messages from ${result.turnCount} ${result.turnCount === 1 ? "turn" : "turns"} `
    + `to the source chat's next message.${omitted}`;
}

export function HistoryRollbackAction({ surface, turnId }: { surface: ForkSurface; turnId: string }) {
  const [phase, setPhase] = useState<"idle" | "confirming" | "busy">("idle");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (phase === "confirming") confirm.current?.focus();
    if (phase === "idle" && restoreFocus.current) {
      restoreFocus.current = false;
      trigger.current?.focus();
    }
  }, [phase]);
  const cancel = () => { restoreFocus.current = true; setPhase("idle"); };
  const rollback = async () => {
    setPhase("busy"); setError(null); setStatus(null);
    try {
      const response = await surface.run("conversation.rollback", { type: "conversation.rollback",
        payload: { conversationId: surface.conversationId, turnId } });
      if (response.type !== "request.result" || response.result.kind !== "conversation.rollback") {
        throw new Error("The service did not confirm the rollback. Reload this chat before trying again.");
      }
      const result = conversationRollbackResultSchema.parse(response.result);
      if (result.conversationId !== surface.conversationId) throw new Error("The rollback belongs to another chat.");
      setStatus(rollbackMessage(result));
    } catch (failure) { setError(failure instanceof Error ? failure.message : "This chat could not be rolled back."); }
    finally { restoreFocus.current = true; setPhase("idle"); }
  };
  if (phase === "confirming") {
    return <span className="history-rollback-confirm" role="group" aria-label="Confirm rollback"
      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); cancel(); } }}>
      <span>Later turns stay visible but leave this chat's context. Workspace files are not changed.</span>
      <button ref={confirm} type="button" className="turn-run-details-toggle" onClick={() => { void rollback(); }}>
        Roll back
      </button>
      <button type="button" className="turn-run-details-toggle" onClick={cancel}>Cancel</button>
    </span>;
  }
  return <>
    <button ref={trigger} type="button" className="turn-run-details-toggle" disabled={phase === "busy"}
      onClick={() => { setError(null); setStatus(null); setPhase("confirming"); }}>
      <Undo2 size={14} aria-hidden="true" /><span>{phase === "busy" ? "Rolling back…" : "Roll back to here"}</span>
    </button>
    {status && <span role="status">{status}</span>}
    {error && <span role="alert">{error}</span>}
  </>;
}

export function MergeBackAction({ surface }: { surface: ForkSurface }) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const merge = async () => {
    setBusy(true); setError(null); setStatus(null);
    try {
      const response = await surface.run("conversation.merge-back", { type: "conversation.merge-back",
        payload: { forkConversationId: surface.conversationId } });
      if (response.type !== "request.result" || response.result.kind !== "conversation.merge-back") {
        throw new Error("The service did not confirm the merge-back. Check the source chat before trying again.");
      }
      const result = mergeBackResultSchema.parse(response.result);
      if (result.forkConversationId !== surface.conversationId) throw new Error("The merge-back belongs to another fork.");
      setStatus(mergeBackMessage(result));
    } catch (failure) { setError(failure instanceof Error ? failure.message : "The fork's findings could not be merged back."); }
    finally { setBusy(false); }
  };
  return <div className="fork-merge-back">
    <button type="button" className="subtle-button" disabled={busy} onClick={() => { void merge(); }}>
      <GitMerge size={14} aria-hidden="true" /><span>{busy ? "Merging…" : "Merge findings into source chat"}</span>
    </button>
    {status && <p role="status">{status}</p>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
