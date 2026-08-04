import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
  conversations: Array<{ id: string; projectId: string; title: string; providerLabel: string; runId: string | null; status: string; pendingLocalApproval: boolean; pendingLocalAction: boolean; updatedAt: string }>;
  capabilities: { scopes: string[]; preset: "monitor" | "collaborate"; expiresAt: string };
};

type Detail = {
  conversation: Shell["conversations"][number];
  messages: Array<{ id: string; role: "user" | "assistant"; content: string; createdAt: string; turnId: string | null }>;
  activities?: Array<{ id: string; kind: string; title: string; status: string; createdAt: string }>;
  subagents?: Array<{ id: string; providerLabel: string; name: string | null; status: string; updatedAt: string }>;
  plan?: { steps: Array<{ label: string; status: "pending" | "inProgress" | "completed" }> } | null;
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
  const [pendingPromptDelivery, setPendingPromptDelivery] = useState<{
    conversationId: string;
    content: string;
    deliveryId: string;
  } | null>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const followLatestRef = useRef(true);

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
        unsubscribeClose = next.onClose((code) => {
          if (code === 1008) {
            setShell(null);
            setDetail(null);
            setSelectedConversation(null);
            setPair({ kind: "pair", invitation: null, error: "This browser no longer has access. Pair it again from the desktop." });
          } else retry();
        });
        setSocket(next);
      } catch (error) {
        if (isUnauthorized(error)) {
          setShell(null);
          setDetail(null);
          setSelectedConversation(null);
          setPair({ kind: "pair", invitation: null, error: "This browser no longer has access. Pair it again from the desktop." });
        } else retry();
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
      }).catch((error) => {
        if (!cancelled) setPair({ kind: "pair", invitation: null, error: error instanceof Error ? error.message : "Pairing status is unavailable." });
      });
    }, 1_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [pair, loadSession]);

  useEffect(() => {
    if (!readyCsrf) return;
    let cancelled = false;
    const load = async (): Promise<void> => {
      const response = await request({ protocolVersion: 1, type: "state.get", requestId: crypto.randomUUID() }, readyCsrf);
      if (!response.ok) throw new Error(response.message);
      if (!cancelled && response.result && typeof response.result === "object" && "state" in response.result) setShell((response.result as { state: Shell }).state);
    };
    void load().catch((error) => { if (!cancelled) setPair((current) => current.kind === "ready" ? { ...current, error: error instanceof Error ? error.message : "State could not be loaded." } : current); });
    return () => { cancelled = true; };
  }, [readyCsrf, request]);

  useEffect(() => {
    if (!readyCsrf || !selectedConversation) return;
    let cancelled = false;
    void request({ protocolVersion: 1, type: "conversation.get", requestId: crypto.randomUUID(), conversationId: selectedConversation }, readyCsrf).then((response) => {
      if (!response.ok) throw new Error(response.message);
      if (!cancelled && response.result && typeof response.result === "object" && "detail" in response.result) setDetail((response.result as { detail: Detail }).detail);
    }).catch((error) => {
      if (!cancelled) setPair((current) => current.kind === "ready" ? { ...current, error: error instanceof Error ? error.message : "Conversation could not be loaded." } : current);
    });
    return () => { cancelled = true; };
  }, [readyCsrf, request, selectedConversation]);

  useEffect(() => {
    if (!readyCsrf || !socket) return;
    let cancelled = false;
    const refresh = async (): Promise<void> => {
      const stateRequest = socket.request({ protocolVersion: 1, type: "state.get", requestId: crypto.randomUUID() });
      const detailRequest = selectedConversation
        ? socket.request({ protocolVersion: 1, type: "conversation.get", requestId: crypto.randomUUID(), conversationId: selectedConversation })
        : null;
      const [stateResponse, detailResponse] = await Promise.all([
        stateRequest,
        detailRequest,
      ]);
      if (cancelled) return;
      if (!stateResponse.ok) throw new Error(stateResponse.message);
      if (detailResponse && !detailResponse.ok) throw new Error(detailResponse.message);
      if (stateResponse.result && typeof stateResponse.result === "object" && "state" in stateResponse.result) {
        setShell((stateResponse.result as { state: Shell }).state);
      }
      if (detailResponse?.result && typeof detailResponse.result === "object" && "detail" in detailResponse.result) {
        setDetail((detailResponse.result as { detail: Detail }).detail);
      }
    };
    const timer = window.setInterval(() => {
      void refresh().catch((error) => {
        if (!cancelled) setPair((current) => current.kind === "ready" ? { ...current, error: error instanceof Error ? error.message : "Private Connect state could not be refreshed." } : current);
      });
    }, 5_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [readyCsrf, selectedConversation, socket]);

  useLayoutEffect(() => {
    const messages = messagesRef.current;
    if (messages && followLatestRef.current) messages.scrollTop = messages.scrollHeight;
  }, [detail?.messages]);

  const sendPrompt = async (): Promise<void> => {
    if (pair.kind !== "ready" || !prompt.trim() || !shell?.capabilities.scopes.includes("private:prompt") || !selectedConversation) return;
    setBusy(true);
    try {
      const content = prompt.trim();
      const deliveryId = pendingPromptDelivery?.conversationId === selectedConversation
        && pendingPromptDelivery.content === content
        ? pendingPromptDelivery.deliveryId
        : crypto.randomUUID();
      setPendingPromptDelivery({ conversationId: selectedConversation, content, deliveryId });
      const response = await request({ protocolVersion: 1, type: "prompt.send", requestId: crypto.randomUUID(), deliveryId, conversationId: selectedConversation, content }, pair.csrf);
      if (!response.ok) {
        throw new Error(response.code === "uncertain"
          ? `${response.message} Sending again will safely check the same delivery.`
          : response.message);
      }
      setPendingPromptDelivery(null);
      setPrompt("");
    } catch (error) {
      setPair((current) => current.kind === "ready" ? { ...current, error: error instanceof Error ? error.message : "The prompt was not accepted." } : current);
    } finally { setBusy(false); }
  };

  const answerQuestions = async (): Promise<void> => {
    if (pair.kind !== "ready" || !selectedConversation || !detail?.inputRequestId || !shell?.capabilities.scopes.includes("private:input")) return;
    setBusy(true);
    try {
      const response = await request({ protocolVersion: 1, type: "input.respond", requestId: crypto.randomUUID(), conversationId: selectedConversation, inputRequestId: detail.inputRequestId, answers }, pair.csrf);
      if (!response.ok) throw new Error(response.message);
      setAnswers({});
    } catch (error) {
      setPair((current) => current.kind === "ready" ? { ...current, error: error instanceof Error ? error.message : "The answer was not accepted." } : current);
    } finally { setBusy(false); }
  };

  const stopRun = async (): Promise<void> => {
    if (pair.kind !== "ready" || !selectedConversation || !detail?.conversation.runId || !shell?.capabilities.scopes.includes("private:stop")) return;
    try {
      const response = await request({ protocolVersion: 1, type: "run.stop", requestId: crypto.randomUUID(), conversationId: selectedConversation, runId: detail.conversation.runId }, pair.csrf);
      if (!response.ok) throw new Error(response.message);
    } catch (error) {
      setPair((current) => current.kind === "ready" ? { ...current, error: error instanceof Error ? error.message : "The run could not be stopped." } : current);
    }
  };

  const signOut = async (): Promise<void> => {
    if (pair.kind !== "ready") return;
    try {
      await jsonRequest("/api/session/logout", {}, pair.csrf);
      setPair({ kind: "pair", invitation: null, error: null });
    } catch (error) {
      setPair((current) => current.kind === "ready" ? { ...current, error: error instanceof Error ? error.message : "Sign out failed." } : current);
    }
  };

  if (pair.kind === "checking") return <main className="connect-card"><div className="brand-mark">I</div><h1>Inertia Private Connect</h1><p>Checking this browser’s connection…</p></main>;
  if (pair.kind === "pair") return <main className="connect-card"><div className="brand-mark">I</div><h1>Inertia Private Connect</h1><p>Pair this browser with your online Inertia computer through your private Tailscale network.</p>{pair.error && <p className="error">{pair.error}</p>}<p className="muted">Open a fresh pairing link from Connections &amp; devices on the desktop.</p></main>;
  if (pair.kind === "waiting") return <main className="connect-card"><div className="brand-mark">I</div><h1>Waiting for approval</h1><p>Approve this browser on the Inertia desktop.</p><div className="comparison-code" aria-label={`Comparison code ${pair.comparisonCode}`}>{pair.comparisonCode}</div><p className="muted">The code must match what your computer displays.</p></main>;
  return <main className="shell"><header><div><span className="eyebrow">Inertia Private Connect</span><h1>Your workspace</h1></div><button type="button" onClick={() => void signOut()}>Sign out</button></header>{pair.error && <div className="banner error">{pair.error}</div>}<div className="layout"><aside><h2>Projects</h2>{shell?.projects.map((project) => <section key={project.id}><h3>{project.name}</h3>{shell.conversations.filter((conversation) => conversation.projectId === project.id).map((conversation) => <button type="button" className={selectedConversation === conversation.id ? "conversation-link selected" : "conversation-link"} key={conversation.id} onClick={() => { setSelectedConversation(conversation.id); setDetail(null); setAnswers({}); followLatestRef.current = true; }}><span>{conversation.title}</span><small>{conversation.status}</small></button>)}</section>)}</aside><section className="conversation-pane">{detail ? <><div className="conversation-heading"><div><span className="eyebrow">{detail.conversation.providerLabel}</span><h2>{detail.conversation.title}</h2></div>{shell?.capabilities.scopes.includes("private:stop") && detail.conversation.runId && <button type="button" onClick={() => void stopRun()}>Stop run</button>}</div><div className="messages" ref={messagesRef} onScroll={(event) => { const element = event.currentTarget; followLatestRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80; }}>{detail.messages.map((message) => <article className={`message ${message.role}`} key={message.id}><span className="role">{message.role === "assistant" ? "Inertia" : "You"}</span><p>{message.content}</p></article>)}</div><ActivitySummary detail={detail} />{detail.questions.length > 0 && shell?.capabilities.scopes.includes("private:input") && <form className="question-card" onSubmit={(event) => { event.preventDefault(); void answerQuestions(); }}><h3>Inertia needs your answer</h3>{detail.questions.map((question) => <fieldset key={question.id}><legend>{question.label}</legend>{question.options.map((option) => <label key={option.id}><input type={question.allowMultiple ? "checkbox" : "radio"} name={question.id} checked={answers[question.id]?.includes(option.id) ?? false} onChange={() => setAnswers((current) => ({ ...current, [question.id]: question.allowMultiple ? current[question.id]?.includes(option.id) ? current[question.id]!.filter((id) => id !== option.id) : [...(current[question.id] ?? []), option.id] : [option.id] }))} /> {option.label}</label>)}</fieldset>)}<button type="submit" disabled={busy}>Answer</button></form>}{detail.waitingForLocalAction && <div className="banner">This conversation needs an action on the desktop. Secrets and approvals stay local.</div>}{shell?.capabilities.scopes.includes("private:prompt") && <form className="composer" onSubmit={(event) => { event.preventDefault(); void sendPrompt(); }}><textarea aria-label="Send a prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Send a supervised prompt" disabled={busy} /><button type="submit" disabled={busy || !prompt.trim()}>Send</button></form>}</> : <div className="empty"><h2>Choose a conversation</h2><p>Only projects and conversations granted by the desktop appear here.</p></div>}</section></div></main>;
}

function ActivitySummary({ detail }: { detail: Detail }): React.JSX.Element | null {
  const activities = (detail.activities ?? []).slice(-6);
  const subagents = detail.subagents ?? [];
  const steps = detail.plan?.steps ?? [];
  if (activities.length === 0 && subagents.length === 0 && steps.length === 0) return null;
  return (
    <details className="work-summary">
      <summary>Current work</summary>
      {steps.length > 0 && (
        <section><h3>Plan</h3><ol>{steps.map((step, index) => <li key={`${index}-${step.label}`} data-status={step.status}>{step.label}</li>)}</ol></section>
      )}
      {activities.length > 0 && (
        <section><h3>Recent activity</h3><ul>{activities.map((activity) => <li key={activity.id}><span>{activity.title}</span><small>{activity.status}</small></li>)}</ul></section>
      )}
      {subagents.length > 0 && (
        <section><h3>Delegated agents</h3><ul>{subagents.map((subagent) => <li key={subagent.id}><span>{subagent.name ?? subagent.providerLabel}</span><small>{subagent.status}</small></li>)}</ul></section>
      )}
    </details>
  );
}

function suggestedDeviceLabel(): string {
  const platform = navigator.platform || "browser";
  return platform.slice(0, 64);
}

function isUnauthorized(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "status" in error && (error as { status?: unknown }).status === 401);
}
