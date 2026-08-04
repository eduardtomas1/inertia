import { useCallback, useEffect, useMemo, useState } from "react";
import {
  apiRequest,
  browserDeviceId,
  connectPrivateConnectSocket,
  jsonRequest,
  parsePairingFragment,
  type PrivateConnectSocket,
  type PairingInvitation,
} from "./connection";

type PairState =
  | { kind: "checking" }
  | { kind: "pair"; invitation: PairingInvitation | null; error: string | null }
  | { kind: "waiting"; requestId: string; comparisonCode: string; error: string | null }
  | { kind: "ready"; csrf: string; error: string | null };

type Shell = {
  generatedAt: string;
  projects: Array<{ id: string; name: string }>;
  conversations: Array<{ id: string; projectId: string; title: string; providerLabel: string; status: string; pendingLocalApproval: boolean; pendingLocalAction: boolean; updatedAt: string }>;
  capabilities: { scopes: string[]; preset: "monitor" | "collaborate"; expiresAt: string };
};

type Detail = {
  conversation: Shell["conversations"][number];
  messages: Array<{ id: string; role: "user" | "assistant"; content: string; createdAt: string; turnId: string | null }>;
  questions: Array<{ id: string; label: string; options: Array<{ id: string; label: string }>; allowMultiple: boolean }>;
  inputRequestId?: string | null;
  waitingForLocalAction: boolean;
};

export default function App({ initialPairingFragment }: { initialPairingFragment: string | null }): React.JSX.Element {
  const invitation = useMemo(() => parsePairingFragment(initialPairingFragment), [initialPairingFragment]);
  const [pair, setPair] = useState<PairState>(() => ({ kind: "checking" }));
  const [shell, setShell] = useState<Shell | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [selectedConversation, setSelectedConversation] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [socket, setSocket] = useState<PrivateConnectSocket | null>(null);

  const loadSession = useCallback(async () => {
    const response = await fetch("/api/session/csrf", { credentials: "same-origin" });
    if (response.status === 401) {
      setPair({ kind: "pair", invitation, error: invitation || !initialPairingFragment ? null : "This pairing link is invalid." });
      return;
    }
    if (!response.ok) throw new Error("Private Connect is unavailable.");
    const value = await response.json() as { csrf?: string };
    if (!value.csrf) throw new Error("Private Connect did not return a session guard.");
    setPair({ kind: "ready", csrf: value.csrf, error: null });
  }, [initialPairingFragment, invitation]);

  useEffect(() => {
    void loadSession().catch((error) => setPair({ kind: "pair", invitation, error: error instanceof Error ? error.message : "Private Connect is unavailable." }));
  }, [loadSession, invitation]);

  const pairingInvitation = pair.kind === "pair" ? pair.invitation : null;
  useEffect(() => {
    if (pair.kind !== "pair" || !pairingInvitation) return;
    let cancelled = false;
    void (async () => {
      try {
        const started = await jsonRequest<{ requestId: string; comparisonCode: string }>("/api/pair/start", {
          invitation: pairingInvitation,
          deviceId: browserDeviceId(),
          deviceLabel: suggestedDeviceLabel(),
        });
        if (!cancelled) setPair({ kind: "waiting", requestId: started.requestId, comparisonCode: started.comparisonCode, error: null });
      } catch (error) {
        if (!cancelled) setPair((current) => ({ ...current, error: error instanceof Error ? error.message : "Pairing could not start." }));
      }
    })();
    return () => { cancelled = true; };
  }, [pair.kind, pairingInvitation]);

  const readyCsrf = pair.kind === "ready" ? pair.csrf : null;
  useEffect(() => {
    if (pair.kind !== "ready" || !readyCsrf) {
      setSocket(null);
      return;
    }
    let cancelled = false;
    let retryTimer: number | null = null;
    let current: PrivateConnectSocket | null = null;
    let unsubscribeClose: (() => void) | null = null;
    const retry = (): void => {
      if (cancelled || retryTimer !== null) return;
      setSocket(null);
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        void connect();
      }, 3_000);
    };
    const connect = async (): Promise<void> => {
      try {
        const next = await connectPrivateConnectSocket(readyCsrf);
        if (cancelled) { next.close(); return; }
        current = next;
        unsubscribeClose = next.onClose(retry);
        setSocket(next);
      } catch {
        retry();
      }
    };
    void connect();
    return () => {
      cancelled = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      unsubscribeClose?.();
      current?.close();
      setSocket(null);
    };
  }, [pair.kind, readyCsrf]);

  const request = useCallback(async (value: Parameters<PrivateConnectSocket["request"]>[0], csrf: string) => {
    return socket ? await socket.request(value) : await apiRequest(value, csrf);
  }, [socket]);

  useEffect(() => {
    if (pair.kind !== "waiting") return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void jsonRequest<{ status: "pending" | "approved" | "denied" | "expired" }>("/api/pair/status", { requestId: pair.requestId }).then((status) => {
        if (cancelled) return;
        if (status.status === "approved") void loadSession();
        else if (status.status === "denied" || status.status === "expired") setPair({ kind: "pair", invitation: null, error: "Pairing was not approved." });
      }).catch(() => undefined);
    }, 1_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [pair, loadSession]);

  useEffect(() => {
    if (pair.kind !== "ready") return;
    let cancelled = false;
    const load = async (): Promise<void> => {
      const response = await request({ protocolVersion: 1, type: "state.get", requestId: crypto.randomUUID() }, pair.csrf);
      if (!cancelled && response.ok && response.result && typeof response.result === "object" && "state" in response.result) setShell((response.result as { state: Shell }).state);
    };
    void load().catch((error) => { if (!cancelled) setPair((current) => current.kind === "ready" ? { ...current, error: error instanceof Error ? error.message : "State could not be loaded." } : current); });
    return () => { cancelled = true; };
  }, [pair, request]);

  useEffect(() => {
    if (pair.kind !== "ready" || !selectedConversation) return;
    void request({ protocolVersion: 1, type: "conversation.get", requestId: crypto.randomUUID(), conversationId: selectedConversation }, pair.csrf).then((response) => {
      if (response.ok && response.result && typeof response.result === "object" && "detail" in response.result) setDetail((response.result as { detail: Detail }).detail);
    }).catch(() => undefined);
  }, [pair, request, selectedConversation]);

  const sendPrompt = async (): Promise<void> => {
    if (pair.kind !== "ready" || !prompt.trim() || !shell?.capabilities.scopes.includes("private:prompt") || !selectedConversation) return;
    setBusy(true);
    try {
      await request({ protocolVersion: 1, type: "prompt.send", requestId: crypto.randomUUID(), deliveryId: crypto.randomUUID(), conversationId: selectedConversation, content: prompt.trim() }, pair.csrf);
      setPrompt("");
    } finally { setBusy(false); }
  };

  const answerQuestions = async (): Promise<void> => {
    if (pair.kind !== "ready" || !selectedConversation || !detail?.inputRequestId || !shell?.capabilities.scopes.includes("private:input")) return;
    setBusy(true);
    try {
      await request({ protocolVersion: 1, type: "input.respond", requestId: crypto.randomUUID(), conversationId: selectedConversation, inputRequestId: detail.inputRequestId, answers }, pair.csrf);
      setAnswers({});
    } finally { setBusy(false); }
  };

  if (pair.kind === "checking") return <main className="connect-card"><div className="brand-mark">I</div><h1>Inertia Private Connect</h1><p>Checking this browser’s connection…</p></main>;
  if (pair.kind === "pair") return <main className="connect-card"><div className="brand-mark">I</div><h1>Inertia Private Connect</h1><p>Pair this browser with your online Inertia computer through your private Tailscale network.</p>{pair.error && <p className="error">{pair.error}</p>}<p className="muted">Open a fresh pairing link from Connections &amp; devices on the desktop.</p></main>;
  if (pair.kind === "waiting") return <main className="connect-card"><div className="brand-mark">I</div><h1>Waiting for approval</h1><p>Approve this browser on the Inertia desktop.</p><div className="comparison-code" aria-label={`Comparison code ${pair.comparisonCode}`}>{pair.comparisonCode}</div><p className="muted">The code must match what your computer displays.</p></main>;
  return <main className="shell"><header><div><span className="eyebrow">Inertia Private Connect</span><h1>Your workspace</h1></div><button type="button" onClick={() => void jsonRequest("/api/session/logout", {}, pair.csrf).then(() => setPair({ kind: "pair", invitation: null, error: null }))}>Sign out</button></header>{pair.error && <div className="banner error">{pair.error}</div>}<div className="layout"><aside><h2>Projects</h2>{shell?.projects.map((project) => <section key={project.id}><h3>{project.name}</h3>{shell.conversations.filter((conversation) => conversation.projectId === project.id).map((conversation) => <button type="button" className={selectedConversation === conversation.id ? "conversation selected" : "conversation"} key={conversation.id} onClick={() => { setSelectedConversation(conversation.id); setAnswers({}); }}><span>{conversation.title}</span><small>{conversation.status}</small></button>)}</section>)}</aside><section className="conversation">{detail ? <><div className="conversation-heading"><div><span className="eyebrow">{detail.conversation.providerLabel}</span><h2>{detail.conversation.title}</h2></div>{shell?.capabilities.scopes.includes("private:stop") && <button type="button" onClick={() => selectedConversation && void request({ protocolVersion: 1, type: "run.stop", requestId: crypto.randomUUID(), conversationId: selectedConversation, runId: detail.conversation.id }, pair.csrf)}>Stop run</button>}</div><div className="messages">{detail.messages.map((message) => <article className={`message ${message.role}`} key={message.id}><span className="role">{message.role === "assistant" ? "Inertia" : "You"}</span><p>{message.content}</p></article>)}</div>{detail.questions.length > 0 && shell?.capabilities.scopes.includes("private:input") && <form className="question-card" onSubmit={(event) => { event.preventDefault(); void answerQuestions(); }}><h3>Inertia needs your answer</h3>{detail.questions.map((question) => <fieldset key={question.id}><legend>{question.label}</legend>{question.options.map((option) => <label key={option.id}><input type={question.allowMultiple ? "checkbox" : "radio"} name={question.id} checked={answers[question.id]?.includes(option.id) ?? false} onChange={() => setAnswers((current) => ({ ...current, [question.id]: question.allowMultiple ? current[question.id]?.includes(option.id) ? current[question.id]!.filter((id) => id !== option.id) : [...(current[question.id] ?? []), option.id] : [option.id] }))} /> {option.label}</label>)}</fieldset>)}<button type="submit" disabled={busy}>Answer</button></form>}{detail.waitingForLocalAction && <div className="banner">This conversation needs an action on the desktop. Secrets and approvals stay local.</div>}{shell?.capabilities.scopes.includes("private:prompt") && <form className="composer" onSubmit={(event) => { event.preventDefault(); void sendPrompt(); }}><textarea aria-label="Send a prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Send a supervised prompt" disabled={busy} /><button type="submit" disabled={busy || !prompt.trim()}>Send</button></form>}</> : <div className="empty"><h2>Choose a conversation</h2><p>Only projects and conversations granted by the desktop appear here.</p></div>}</section></div></main>;
}

function suggestedDeviceLabel(): string {
  const platform = navigator.platform || "browser";
  return platform.slice(0, 64);
}
