import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode, RefObject } from "react";
import { GitMerge, Undo2 } from "lucide-react";
import { conversationRollbackResultSchema, type ConversationRollbackResult } from "@shared/orchestration-history";
import { mergeBackResultSchema, type MergeBackResult } from "@shared/orchestration-merge-back";
import type { ForkSurface } from "./fork-surface-model";
import {
  closeStartRollback,
  noteRollbackFiles,
  offerStartRollback,
  useFilesRestored,
  useForkLineage,
  useStartRollbackRequest,
  type StartRollbackRequest,
} from "./history-session";
import "./history-actions.css";

const QUIET = { reportError: false } as const;

interface RollbackOutcome { context: string; files: string; warning: boolean }

function turns(count: number): string {
  return `${count} later ${count === 1 ? "turn" : "turns"}`;
}

function contextMessage(result: ConversationRollbackResult): string {
  const start = result.retainedTurnId === null;
  if (result.transfer === "unchanged") {
    return start ? "Nothing in this chat needed rolling back." : "Nothing after this turn needed rolling back.";
  }
  const rolledBack = start
    ? `Rolled back ${result.rolledBackTurns} ${result.rolledBackTurns === 1 ? "turn" : "turns"} to the chat start.`
    : `Rolled back ${turns(result.rolledBackTurns)}.`;
  if (result.transfer === "native") {
    return `${rolledBack} The provider session continues from ${start ? "the chat start" : "this turn"}.`;
  }
  return `${rolledBack} The next message starts a fresh provider session${start ? "." : " with the retained history."}`;
}

function filesMessage({ outcome, message }: ConversationRollbackResult["files"]): string {
  const detail = message ? ` ${message}` : "";
  if (outcome === "restored") return `Files restored.${detail}`;
  if (outcome === "unchanged") return `Files unchanged.${detail}`;
  if (outcome === "refused") return message ? `Files were not restored: ${message}` : "Files were not restored.";
  return message ? `Restoring files failed: ${message}` : "Restoring files failed.";
}

function rollbackOutcome(result: ConversationRollbackResult): RollbackOutcome {
  return {
    context: contextMessage(result),
    files: filesMessage(result.files),
    warning: result.files.outcome === "refused" || result.files.outcome === "failed",
  };
}

function mergeBackMessage(result: MergeBackResult): string {
  const omitted = result.omittedMessageCount > 0 ? ` ${result.omittedMessageCount} older messages were left out.` : "";
  return `Attached ${result.messageCount} messages from ${result.turnCount} ${result.turnCount === 1 ? "turn" : "turns"} `
    + `to the source chat's next message.${omitted}`;
}

function failureMessage(failure: unknown, fallback: string): string {
  return failure instanceof Error && failure.message ? failure.message : fallback;
}

async function rollBack(surface: ForkSurface, turnId: string | null, restoreFiles: boolean): Promise<RollbackOutcome> {
  const response = await surface.run("conversation.rollback", { type: "conversation.rollback",
    payload: { conversationId: surface.conversationId, turnId, restoreFiles } }, QUIET);
  if (response.type !== "request.result" || response.result.kind !== "conversation.rollback") {
    throw new Error("The service did not confirm the rollback. Reload this chat before trying again.");
  }
  const result = conversationRollbackResultSchema.parse(response.result);
  if (result.conversationId !== surface.conversationId) throw new Error("The rollback belongs to another chat.");
  noteRollbackFiles(surface.conversationId, result.files.outcome === "restored" ? result.retainedTurnId : null);
  return rollbackOutcome(result);
}

async function mergeBack(surface: ForkSurface, throughTurnId?: string): Promise<string> {
  const response = await surface.run("conversation.merge-back", { type: "conversation.merge-back",
    payload: throughTurnId ? { forkConversationId: surface.conversationId, throughTurnId }
      : { forkConversationId: surface.conversationId } }, QUIET);
  if (response.type !== "request.result" || response.result.kind !== "conversation.merge-back") {
    throw new Error("The service did not confirm the merge-back. Check the source chat before trying again.");
  }
  const result = mergeBackResultSchema.parse(response.result);
  if (result.forkConversationId !== surface.conversationId) throw new Error("The merge-back belongs to another fork.");
  return mergeBackMessage(result);
}

function useTwoStep() {
  const [phase, setPhase] = useState<"idle" | "confirming" | "busy">("idle");
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
  const settle = () => { restoreFocus.current = true; setPhase("idle"); };
  return { phase, setPhase, trigger, confirm, settle };
}

function escapeCancels(cancel: () => void) {
  return (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    cancel();
  };
}

function RollbackOutcomeText({ outcome }: { outcome: RollbackOutcome }) {
  return <span role="status">
    {outcome.context}{" "}
    <span className={outcome.warning ? "history-notice" : undefined}>{outcome.files}</span>
  </span>;
}

function RollbackConfirmation({ start, confirm, busy, onConfirm, onCancel }: {
  start: boolean; confirm: RefObject<HTMLButtonElement | null>; busy: boolean;
  onConfirm: (restoreFiles: boolean) => void; onCancel: () => void;
}) {
  const [restore, setRestore] = useState(false);
  const describedBy = useId();
  const scope = start ? "Every turn stays visible but leaves this chat's context."
    : "Later turns stay visible but leave this chat's context.";
  const files = !restore ? "Workspace files are not changed."
    : start ? "Files changed in this chat are restored when it is safe."
      : "Files changed by later turns are restored when it is safe.";
  return <span className="history-rollback-confirm" role="group"
    aria-label={start ? "Confirm rollback to chat start" : "Confirm rollback"} onKeyDown={escapeCancels(onCancel)}>
    <span id={describedBy}>{scope} {files}</span>
    <label className="history-files-toggle">
      <input type="checkbox" checked={restore} disabled={busy} onChange={(event) => setRestore(event.currentTarget.checked)} />
      <span>Also restore files to this point</span>
    </label>
    <button ref={confirm} type="button" className="history-turn-action" aria-describedby={describedBy} disabled={busy}
      onClick={() => onConfirm(restore)}>
      {busy ? "Rolling back…" : restore ? "Roll back context and files" : "Roll back context"}
    </button>
    <button type="button" className="history-turn-action" disabled={busy} onClick={onCancel}>Cancel</button>
  </span>;
}

function HistoryRollbackAction({ surface, turnId }: { surface: ForkSurface; turnId: string }) {
  const { phase, setPhase, trigger, confirm, settle } = useTwoStep();
  const [outcome, setOutcome] = useState<RollbackOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rollback = async (restoreFiles: boolean) => {
    setPhase("busy"); setError(null); setOutcome(null);
    try { setOutcome(await rollBack(surface, turnId, restoreFiles)); }
    catch (failure) { setError(failureMessage(failure, "This chat could not be rolled back.")); }
    finally { settle(); }
  };
  if (phase === "confirming") {
    return <RollbackConfirmation start={false} confirm={confirm} busy={false}
      onConfirm={(restoreFiles) => { void rollback(restoreFiles); }} onCancel={settle} />;
  }
  return <>
    <button ref={trigger} type="button" className="history-turn-action" disabled={phase === "busy"}
      onClick={() => { setError(null); setOutcome(null); setPhase("confirming"); }}>
      <Undo2 size={14} aria-hidden="true" /><span>{phase === "busy" ? "Rolling back…" : "Roll back to here"}</span>
    </button>
    {outcome && <RollbackOutcomeText outcome={outcome} />}
    {error && <span role="alert" className="history-notice">{error}</span>}
  </>;
}

function MergeThroughAction({ surface, turnId }: { surface: ForkSurface; turnId: string }) {
  const { phase, setPhase, trigger, confirm, settle } = useTwoStep();
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const merge = async () => {
    setPhase("busy"); setError(null); setStatus(null);
    try { setStatus(await mergeBack(surface, turnId)); }
    catch (failure) { setError(failureMessage(failure, "The fork's findings could not be merged back.")); }
    finally { settle(); }
  };
  if (phase === "confirming") {
    return <span className="history-rollback-confirm" role="group" aria-label="Confirm merge" onKeyDown={escapeCancels(settle)}>
      <span>Findings from this fork up to this turn are attached to the source chat's next message.</span>
      <button ref={confirm} type="button" className="history-turn-action" onClick={() => { void merge(); }}>Merge findings</button>
      <button type="button" className="history-turn-action" onClick={settle}>Cancel</button>
    </span>;
  }
  return <>
    <button ref={trigger} type="button" className="history-turn-action" disabled={phase === "busy"}
      onClick={() => { setError(null); setStatus(null); setPhase("confirming"); }}>
      <GitMerge size={14} aria-hidden="true" /><span>{phase === "busy" ? "Merging…" : "Merge findings up to here"}</span>
    </button>
    {status && <span role="status">{status}</span>}
    {error && <span role="alert" className="history-notice">{error}</span>}
  </>;
}

export function HistoryTurnActions({ surface, turnId }: { surface: ForkSurface; turnId: string }) {
  const fork = useForkLineage(surface.conversationId);
  const restored = useFilesRestored(surface.conversationId, turnId);
  return <>
    {restored && <span className="history-files-restored">Files restored</span>}
    <HistoryRollbackAction surface={surface} turnId={turnId} />
    {fork && <MergeThroughAction surface={surface} turnId={turnId} />}
  </>;
}

function StartRollbackConfirmation({ surface, request, onSettled }: {
  surface: ForkSurface; request: StartRollbackRequest; onSettled: (outcome: ReactNode) => void;
}) {
  const [busy, setBusy] = useState(false);
  const confirm = useRef<HTMLButtonElement>(null);
  useEffect(() => { confirm.current?.focus(); }, []);
  const close = () => {
    const target = request.returnFocus?.isConnected ? request.returnFocus
      : confirm.current?.closest<HTMLElement>(".message-scroll") ?? null;
    target?.focus({ preventScroll: true });
    closeStartRollback(request);
  };
  const rollback = async (restoreFiles: boolean) => {
    setBusy(true);
    onSettled(null);
    let settled: ReactNode;
    try { settled = <RollbackOutcomeText outcome={await rollBack(surface, null, restoreFiles)} />; }
    catch (failure) {
      settled = <span role="alert" className="history-notice">{failureMessage(failure, "This chat could not be rolled back.")}</span>;
    }
    onSettled(settled);
    close();
  };
  return <RollbackConfirmation start confirm={confirm} busy={busy}
    onConfirm={(restoreFiles) => { void rollback(restoreFiles); }} onCancel={() => { if (!busy) close(); }} />;
}

export function HistoryStartRollback({ surface }: { surface: ForkSurface }) {
  const { conversationId, canRollBackToStart } = surface;
  useEffect(() => canRollBackToStart ? offerStartRollback(conversationId) : undefined, [canRollBackToStart, conversationId]);
  const request = useStartRollbackRequest(conversationId);
  const [outcome, setOutcome] = useState<ReactNode>(null);
  if (!request && !outcome) return null;
  return <div className="history-start" aria-label="Chat start rollback" role="region">
    {request ? <StartRollbackConfirmation key={request.sequence} surface={surface} request={request} onSettled={setOutcome} />
      : outcome}
  </div>;
}

export function MergeBackAction({ surface }: { surface: ForkSurface }) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const merge = async () => {
    setBusy(true); setError(null); setStatus(null);
    try { setStatus(await mergeBack(surface)); }
    catch (failure) { setError(failureMessage(failure, "The fork's findings could not be merged back.")); }
    finally { setBusy(false); }
  };
  return <div className="fork-merge-back">
    <button type="button" className="subtle-button" disabled={busy} onClick={() => { void merge(); }}>
      <GitMerge size={14} aria-hidden="true" /><span>{busy ? "Merging…" : "Merge findings into source chat"}</span>
    </button>
    {status && <p role="status">{status}</p>}
    {error && <p role="alert" className="history-notice">{error}</p>}
  </div>;
}
