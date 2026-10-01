import { useEffect, useRef, useState } from "react";
import { CheckCircle2, ChevronDown, LoaderCircle, Terminal, TriangleAlert } from "lucide-react";
import type { Conversation, ServerEvent } from "@shared/contracts";
import type { WorktreeSetupSummary } from "@shared/worktree-setup";
import type { CommandWithoutId } from "../lib/runtimeCommands";
import "./WorktreeSetupCard.css";

export type WorktreeSetupCommandRunner = (key: string, command: Extract<CommandWithoutId, { type: `worktree.setup.${string}` }>, options?: { reportError?: boolean; passive?: boolean }) => Promise<ServerEvent>;
type Operation = "read" | "wait" | "retry" | "cancel" | "skip";

export function WorktreeSetupCard({ conversation, request }: { conversation: Conversation; request: WorktreeSetupCommandRunner }): React.JSX.Element | null {
  const [summary, setSummary] = useState<WorktreeSetupSummary | null>(conversation.worktreeSetup ?? null);
  const [output, setOutput] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const requestRef = useRef(request);
  requestRef.current = request;
  const active = summary?.status === "pending" || summary?.status === "running";
  const ready = summary?.status === "succeeded" || summary?.status === "skipped";

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async (): Promise<void> => {
      try {
        const event = await requestRef.current(`setup-read:${conversation.id}`, { type: "worktree.setup.read", payload: { conversationId: conversation.id } }, { reportError: false, passive: true });
        if (disposed || event.type !== "request.result" || event.result.kind !== "worktree.setup") return;
        setSummary(event.result.summary);
        setOutput(event.result.output);
        if (["pending", "running"].includes(event.result.summary?.status ?? "")) timer = setTimeout(() => { void read(); }, 1_000);
      } catch { /* Snapshot updates trigger a fresh read after reconnect. */ }
    };
    void read();
    return () => { disposed = true; if (timer) clearTimeout(timer); };
  }, [conversation.id, conversation.worktreeSetup, refresh]);

  async function act(operation: Operation): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const event = await request(`setup-${operation}:${conversation.id}`, { type: `worktree.setup.${operation}`, payload: { conversationId: conversation.id } }, { reportError: false, passive: true });
      if (event.type !== "request.result" || event.result.kind !== "worktree.setup") throw new Error("Unable to read worktree setup.");
      setSummary(event.result.summary);
      setOutput(event.result.output);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Setup could not be updated."); }
    finally {
      setBusy(false);
      // Reused chats inherit setup from its owner, so their own snapshot field
      // does not change when an action starts a new attempt. Resume polling here.
      setRefresh((current) => current + 1);
    }
  }

  if (!summary) return null;
  const title = active ? "Setting up worktree" : summary.status === "succeeded" ? "Worktree ready" : summary.status === "skipped" ? "Setup skipped" : "Worktree setup needs attention";
  return <section className="worktree-setup-card" data-state={active ? "running" : ready ? "ready" : "attention"} aria-label="Worktree setup">
    <div className="worktree-setup-heading">
      {active ? <LoaderCircle className="worktree-setup-spinner" size={18} aria-hidden="true" /> : ready ? <CheckCircle2 size={18} aria-hidden="true" /> : <TriangleAlert size={18} aria-hidden="true" />}
      <div role="status"><strong>{title}</strong><span>{summary.actionName}{summary.attempt > 1 ? ` · Attempt ${summary.attempt}` : ""}</span></div>
      <button type="button" className="subtle-button" aria-label={expanded ? "Hide setup output" : "Show setup output"} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}><Terminal size={14} /><span>Output</span><ChevronDown size={13} /></button>
    </div>
    <p>{summary.detail}</p>
    {expanded && <pre tabIndex={0} aria-label="Setup output">{output || (active ? "The command is running. Output is available when it finishes." : "No output was recorded.")}</pre>}
    {active && <div className="worktree-setup-actions"><button type="button" disabled={busy} onClick={() => { void act("cancel"); }}>Stop setup</button><span>Your first prompt will wait.</span></div>}
    {!active && !ready && <div className="worktree-setup-actions"><button type="button" disabled={busy} onClick={() => { void act("retry"); }}>Retry setup</button><button type="button" className="subtle-button" disabled={busy} onClick={() => { void act("skip"); }}>Continue without setup</button></div>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
