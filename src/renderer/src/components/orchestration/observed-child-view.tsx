import { Fragment, useCallback, useEffect, useId, useState } from "react";
import { Square } from "lucide-react";
import { observedChildReadResultSchema, type ObservedChildReadResult, type ObservedChildThread } from "@shared/observed-child-thread";
import {
  failureText,
  observedLineage,
  observedName,
  observedStatusLabel,
  usageLabel,
  type ObservedChildCommandRunner,
} from "./delegation-model";
import "./delegation-panel.css";

const QUIET = { reportError: false } as const;
const READ_ONLY = "Provider-managed · read-only";

async function readObserved(run: ObservedChildCommandRunner, conversationId: string, turnId?: string): Promise<ObservedChildReadResult> {
  const response = await run(`observed-child.read:${conversationId}:${turnId ?? ""}`, { type: "observed-child.read",
    payload: turnId ? { conversationId, turnId } : { conversationId } }, QUIET);
  if (response.type !== "request.result") throw new Error("The agents could not be read.");
  const result = observedChildReadResultSchema.parse(response.result);
  if (result.conversationId !== conversationId) throw new Error("The agents belong to another chat.");
  return result;
}

function ObservedChild({ child, result, parentTitle, turnLabel, run, onChanged }: {
  child: ObservedChildThread; result: ObservedChildReadResult; parentTitle: string; turnLabel: string;
  run: ObservedChildCommandRunner; onChanged: () => void;
}) {
  const nameId = useId();
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = observedName(child);
  const stop = (result.controls[child.id] ?? child.controls).stop;
  const usage = usageLabel(child.usage, child.toolUseCount);
  const facts: [string, string | null][] = [
    ["Status", observedStatusLabel(child.status)],
    ["Provider status", child.providerStatus],
    ["Model", child.model],
    ["Usage", usage],
    ["Task", child.description],
    ["Progress", child.progress],
    ["Result", child.result],
  ];
  const requestStop = async () => {
    if (stopping) return;
    setStopping(true); setError(null);
    try {
      const response = await run(`agent.subagent.stop:${child.id}`, { type: "agent.subagent.stop",
        payload: { conversationId: result.conversationId, traceId: child.id } }, QUIET);
      if (response.type !== "request.result") throw new Error("The agent could not be stopped.");
    } catch (failure) { setError(failureText(failure, "The agent could not be stopped.")); }
    finally { setStopping(false); onChanged(); }
  };
  return <article className="observed-child" aria-labelledby={nameId} data-observed-child-id={child.id}>
    <ol className="observed-child-lineage" aria-label="Agent lineage">
      <li>{parentTitle}</li>
      <li>{turnLabel}</li>
      {observedLineage(child, result.children).map((entry) => <li key={entry.id}
        aria-current={entry.id === child.id ? "location" : undefined}>{observedName(entry)}</li>)}
    </ol>
    <div className="observed-child-heading">
      <strong id={nameId}>{name}</strong>
      <span>{observedStatusLabel(child.status)}</span>
      <span className="observed-child-readonly">{READ_ONLY}</span>
    </div>
    <dl className="observed-child-facts">
      {facts.map(([label, value]) => value && <Fragment key={label}><dt>{label}</dt><dd>{value}</dd></Fragment>)}
    </dl>
    <div className="observed-child-actions">
      {stop.supported
        ? <button type="button" className="turn-run-details-toggle" disabled={stopping} aria-label={`${stopping ? "Stopping" : "Stop"} ${name}`}
          onClick={() => { void requestStop(); }}>
          <Square size={14} fill="currentColor" aria-hidden="true" /><span>{stopping ? "Stopping…" : "Stop"}</span>
        </button>
        : <p className="observed-child-reason">Stop unavailable: {stop.reason}</p>}
    </div>
    {error && <p role="alert" className="delegation-notice">{error}</p>}
  </article>;
}

export function ObservedChildView({ conversationId, turnId, focusTraceId, parentTitle = "This chat", turnLabel = "Turn", run }: {
  conversationId: string; turnId?: string; focusTraceId?: string; parentTitle?: string; turnLabel?: string;
  run: ObservedChildCommandRunner;
}) {
  const [result, setResult] = useState<ObservedChildReadResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((current) => current + 1), []);
  useEffect(() => {
    let current = true;
    readObserved(run, conversationId, turnId).then((loaded) => {
      if (current) { setResult(loaded); setError(null); }
    }, (failure: unknown) => { if (current) setError(failureText(failure, "The agents could not be read.")); });
    return () => { current = false; };
  }, [run, conversationId, turnId, revision]);
  const children = result ? result.children.filter(({ id }) => !focusTraceId || id === focusTraceId) : [];
  return <section className="observed-child-view" aria-label="Provider-managed agents" aria-busy={!result && !error}>
    {error && <p role="alert" className="delegation-notice">{error}</p>}
    {!result && !error && <p role="status">Loading agents…</p>}
    {result && children.length === 0 && <p>No provider-managed agents are recorded for this {focusTraceId ? "agent" : "turn"}.</p>}
    {result && children.map((child) => <ObservedChild key={child.id} child={child} result={result} parentTitle={parentTitle}
      turnLabel={turnLabel} run={run} onChanged={refresh} />)}
    {result && result.omitted > 0 && <p>{result.omitted} more {result.omitted === 1 ? "agent is" : "agents are"} not shown.</p>}
  </section>;
}
