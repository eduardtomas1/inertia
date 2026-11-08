import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { CornerUpLeft, ExternalLink, Send, Split, X } from "lucide-react";
import type { DelegatedTaskSummary } from "@shared/orchestration-delegation";
import {
  childStatusLabel,
  delegationTaskRows,
  failureText,
  isUndelivered,
  routeLabel,
  taskChip,
  taskOutcomeLabel,
  wakeAdjustable,
  wakeLabel,
  type DelegationCommand,
  type DelegationSurface,
} from "./delegation-model";
import "./delegation-panel.css";

const QUIET = { reportError: false } as const;

async function send(surface: DelegationSurface, key: string, command: DelegationCommand, refusal: string) {
  if (!surface.run) throw new Error(refusal);
  const response = await surface.run(key, command, QUIET);
  if (response.type !== "request.result" || !response.result.kind.startsWith("delegation.")) throw new Error(refusal);
  return response.result;
}

function OpenChat({ surface, conversationId, label, onMissing }: {
  surface: DelegationSurface; conversationId: string; label: string; onMissing: (message: string) => void;
}) {
  if (!surface.openConversation) return null;
  return <button type="button" className="turn-run-details-toggle" aria-label={label}
    onClick={() => { if (!surface.openConversation?.(conversationId)) onMissing("That chat is not available. It may be archived or deleted."); }}>
    <ExternalLink size={14} aria-hidden="true" /><span>Open</span>
  </button>;
}

function ChildBreadcrumb({ surface }: { surface: DelegationSurface }) {
  const asChild = surface.delegation?.asChild;
  const [error, setError] = useState<string | null>(null);
  if (!asChild) return null;
  const parent = asChild.parentTitle?.trim() || surface.conversations?.find(({ id }) => id === asChild.parentConversationId)?.title
    || "the parent chat";
  const status = childStatusLabel(asChild);
  return <nav className="delegation-breadcrumb" aria-label="Delegation lineage">
    <CornerUpLeft size={14} aria-hidden="true" />
    <span>Delegated by{" "}
      {surface.openConversation
        ? <button type="button" className="delegation-link" aria-label={`Open parent chat ${parent}`}
          onClick={() => { setError(null); if (!surface.openConversation?.(asChild.parentConversationId)) setError("The parent chat is not available."); }}>
          {parent}
        </button>
        : <strong>{parent}</strong>}
    </span>
    {" "}<span className="delegation-separator" aria-hidden="true">·</span>{" "}
    <span>{status}</span>
    {error && <span role="alert" className="delegation-notice">{error}</span>}
  </nav>;
}

function FullResult({ surface, task }: { surface: DelegationSurface; task: DelegatedTaskSummary }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const panelId = useId();
  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (!next || text !== null) return;
    setError(null);
    const refusal = "The full result could not be loaded.";
    try {
      const result = await send(surface, `delegation.task.read:${task.taskId}`, { type: "delegation.task.read",
        payload: { taskId: task.taskId } }, refusal);
      if (result.kind !== "delegation.task" || result.task.taskId !== task.taskId) throw new Error(refusal);
      const view = result.task.result;
      setText(view?.text ? `${view.text}${view.truncated ? "\n…" : ""}` : "This task left no result text.");
    } catch (failure) { setError(failureText(failure, refusal)); }
  };
  return <>
    <button type="button" className="turn-run-details-toggle" aria-expanded={open} aria-controls={panelId}
      aria-label={`Full result of ${task.title}`} onClick={() => { void toggle(); }}>Full result</button>
    <div id={panelId} className="delegation-full-result" hidden={!open}>
      {open && (error ? <p role="alert" className="delegation-notice">{error}</p>
        : text === null ? <p role="status">Loading result…</p> : <pre>{text}</pre>)}
    </div>
  </>;
}

function useConfirm() {
  const [confirming, setConfirming] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  const row = useRef<HTMLLIElement>(null);
  const restore = useRef(false);
  useEffect(() => {
    if (confirming) confirm.current?.focus();
    else if (restore.current) { restore.current = false; (trigger.current ?? row.current)?.focus(); }
  }, [confirming]);
  const close = () => { restore.current = true; setConfirming(false); };
  return { confirming, open: () => setConfirming(true), close, trigger, confirm, row };
}

function TaskRow({ surface, task }: { surface: DelegationSurface; task: DelegatedTaskSummary }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancel = useConfirm();
  const describedBy = useId();
  const titleId = useId();
  const chip = taskChip(task);
  const undelivered = isUndelivered(task);
  const act = async (name: string, key: string, command: DelegationCommand, refusal: string) => {
    if (busy) return;
    setBusy(name); setError(null);
    try { await send(surface, key, command, refusal); }
    catch (failure) { setError(failureText(failure, refusal)); }
    finally { setBusy(null); }
  };
  const confirmCancel = async () => {
    await act("cancel", `delegation.task.cancel:${task.taskId}`, { type: "delegation.task.cancel", payload: { taskId: task.taskId } },
      "The task could not be cancelled.");
    cancel.close();
  };
  const escape = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || busy) return;
    event.stopPropagation();
    cancel.close();
  };
  const childTitle = task.childTitle?.trim() || task.title;
  return <li ref={cancel.row} className="delegation-task" data-task-id={task.taskId} data-tone={chip.tone}
    tabIndex={-1}>
    <div className="delegation-task-heading">
      <strong id={titleId}>{task.title}</strong>
      <span className="delegation-chip" data-tone={chip.tone}>{chip.label}</span>
    </div>
    <p className="delegation-task-meta" id={describedBy}>
      <span>{childTitle}</span>
      <span>{routeLabel(task.route)}</span>
      {task.status !== "running" && task.status !== "completed" && <span>{taskOutcomeLabel(task.status)}</span>}
      {(task.status === "running" || undelivered) && <span>{wakeLabel(task)}</span>}
    </p>
    {task.resultPreview && task.status !== "running" && <p className="delegation-task-preview">{task.resultPreview}</p>}
    <div className="delegation-task-actions">
      <OpenChat surface={surface} conversationId={task.childConversationId} label={`Open chat for ${task.title}`}
        onMissing={setError} />
      {surface.run && task.status === "running" && (cancel.confirming
        ? <span className="delegation-confirm" role="group" aria-label={`Confirm cancelling ${task.title}`} onKeyDown={escape}>
          <span>The child chat's active turn stops. Results so far stay readable.</span>
          <button ref={cancel.confirm} type="button" className="turn-run-details-toggle" disabled={busy !== null}
            onClick={() => { void confirmCancel(); }}>{busy === "cancel" ? "Cancelling…" : "Cancel task"}</button>
          <button type="button" className="turn-run-details-toggle" disabled={busy !== null} onClick={cancel.close}>Keep running</button>
        </span>
        : <button ref={cancel.trigger} type="button" className="turn-run-details-toggle" aria-label={`Cancel task: ${task.title}`}
          aria-describedby={describedBy}
          disabled={busy !== null} onClick={() => { setError(null); cancel.open(); }}>
          <X size={14} aria-hidden="true" /><span>Cancel task</span>
        </button>)}
      {surface.run && task.resultTurnId && <FullResult surface={surface} task={task} />}
      {surface.run && undelivered && <button type="button" className="turn-run-details-toggle" disabled={busy !== null}
        aria-label={`Dismiss result of ${task.title}`}
        onClick={() => { void act("dismiss", `delegation.delivery.dismiss:${task.taskId}`, { type: "delegation.delivery.dismiss",
          payload: { parentConversationId: surface.conversationId, taskIds: [task.taskId] } }, "The result could not be dismissed."); }}>
        {busy === "dismiss" ? "Dismissing…" : "Dismiss result"}
      </button>}
      {surface.run && wakeAdjustable(task) && <label className="delegation-wake-toggle">
        <input type="checkbox" checked={task.wakeArmed} disabled={busy !== null} aria-describedby={titleId}
          onChange={(event) => { void act("wake", `delegation.wake.set:${task.taskId}`, { type: "delegation.wake.set",
            payload: { taskId: task.taskId, armed: event.currentTarget.checked } }, "The automatic continue could not be changed."); }} />
        <span>Continue this chat when it finishes</span>
      </label>}
    </div>
    {error && <p role="alert" className="delegation-notice">{error}</p>}
  </li>;
}

function ParentPanel({ surface }: { surface: DelegationSurface }) {
  const headingId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const tasks = delegationTaskRows(surface.delegation);
  if (tasks.length === 0) return null;
  const asParent = surface.delegation?.asParent;
  const ready = tasks.filter(isUndelivered).length;
  const resendable = tasks.some((task) => task.status !== "running" && task.resultTurnId !== null && task.delivery.state === "disposed");
  const running = tasks.filter(({ status: taskStatus }) => taskStatus === "running").length;
  const queued = asParent?.mailbox?.phase === "queued" && asParent.mailbox.taskIds.length > 0;
  const omitted = Math.max(0, (asParent?.totalTasks ?? tasks.length) - tasks.length);
  const counts = [running && `${running} working`, ready && `${ready} ready`].filter(Boolean).join(" · ");
  const continueWithResults = async () => {
    if (busy) return;
    setBusy(true); setError(null); setStatus(null);
    const refusal = "The results could not be sent to this chat.";
    try {
      const result = await send(surface, `delegation.delivery.send:${surface.conversationId}`, { type: "delegation.delivery.send",
        payload: { parentConversationId: surface.conversationId } }, refusal);
      const sent = result.kind === "delegation.delivery" ? result.taskIds.length : 0;
      setStatus(sent === 0 ? "There were no results left to send." : `Sent ${sent} ${sent === 1 ? "result" : "results"} to this chat.`);
    } catch (failure) { setError(failureText(failure, refusal)); }
    finally { setBusy(false); }
  };
  return <section className="delegation-panel" aria-labelledby={headingId}>
    <header className="delegation-panel-heading">
      <Split size={16} aria-hidden="true" />
      <h2 id={headingId}>Delegated work</h2>
      {counts && <span className="delegation-panel-count">{counts}</span>}
      {surface.run && (ready > 0 || resendable) && <button type="button" className="subtle-button delegation-continue" disabled={busy}
        onClick={() => { void continueWithResults(); }}>
        <Send size={14} aria-hidden="true" /><span>{busy ? "Sending…" : "Continue with results"}</span>
      </button>}
    </header>
    {queued && <p className="delegation-panel-note">Finished results are queued to continue this chat.</p>}
    {status && <p role="status" className="delegation-panel-note">{status}</p>}
    {error && <p role="alert" className="delegation-notice">{error}</p>}
    <ul className="delegation-tasks" aria-label="Delegated tasks">
      {tasks.map((task) => <TaskRow key={task.taskId} surface={surface} task={task} />)}
    </ul>
    {omitted > 0 && <p className="delegation-panel-note">{omitted} older {omitted === 1 ? "task is" : "tasks are"} not shown.</p>}
  </section>;
}

export function DelegationLineage({ surface }: { surface: DelegationSurface }) {
  return <><ChildBreadcrumb surface={surface} /><ParentPanel surface={surface} /></>;
}
