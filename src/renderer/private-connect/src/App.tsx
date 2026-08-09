import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  PRIVATE_CONNECT_LIMITS,
  PRIVATE_CONNECT_SOCKET_CLOSE,
  privateConnectConversationDetailSchema,
  privateConnectStateSchema,
  type PrivateConnectResponse,
} from "../../../shared/private-connect/protocol";
import {
  apiRequest,
  browserDeviceId,
  connectPrivateConnectSocket,
  jsonRequest,
  parsePairingFragment,
  type PrivateConnectSocket,
  type PairingInvitation,
} from "./connection";
import { CheckingScreen, OfflineScreen, PairScreen, WaitingScreen } from "./pairing/PairingScreen";
import { onPrivateConnectConversationNavigation } from "./pwa";
import { WorkspaceShell } from "./workspace/WorkspaceShell";
import type { Detail, Shell } from "./types";

type PairState =
  | { kind: "checking" }
  | { kind: "pair"; invitation: PairingInvitation | null; error: string | null }
  | { kind: "waiting"; requestId: string; comparisonCode: string; error: string | null }
  | { kind: "ready"; csrf: string; error: string | null };

export default function App({
  initialPairingFragment,
  initialConversationId = null,
}: {
  initialPairingFragment: string | null;
  initialConversationId?: string | null;
}): React.JSX.Element {
  const invitation = useMemo(() => parsePairingFragment(initialPairingFragment), [initialPairingFragment]);
  const [pair, setPair] = useState<PairState>(() => ({ kind: "checking" }));
  const [shell, setShell] = useState<Shell | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [selectedConversation, setSelectedConversation] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [socket, setSocket] = useState<PrivateConnectSocket | null>(null);
  const [hostUnavailable, setHostUnavailable] = useState(() => navigator.onLine === false);
  const [pairRetry, setPairRetry] = useState(0);
  const [requestedConversationId, setRequestedConversationId] = useState(initialConversationId);
  const [pendingPromptDelivery, setPendingPromptDelivery] = useState<{
    conversationId: string;
    content: string;
    deliveryId: string;
  } | null>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const followLatestRef = useRef(true);
  const stateValidatorRef = useRef<string | null>(null);
  const conversationValidatorsRef = useRef(new Map<string, string>());

  const clearWorkspace = useCallback((): void => {
    setShell(null);
    setDetail(null);
    setSelectedConversation(null);
    stateValidatorRef.current = null;
    conversationValidatorsRef.current.clear();
  }, []);

  const noteRequestFailure = useCallback((error: unknown): void => {
    if (hasHttpStatus(error)) setHostUnavailable(false);
    else setHostUnavailable(true);
  }, []);

  useEffect(() => {
    const offline = (): void => setHostUnavailable(true);
    const online = (): void => setHostUnavailable(false);
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    return () => {
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
    };
  }, []);

  useEffect(() => onPrivateConnectConversationNavigation(
    setRequestedConversationId,
  ), []);

  useEffect(() => {
    if (!shell || !requestedConversationId) return;
    const allowed = shell.conversations.some(({ id }) => id === requestedConversationId);
    if (allowed) {
      conversationValidatorsRef.current.delete(requestedConversationId);
      setSelectedConversation(requestedConversationId);
      setDetail(null);
      followLatestRef.current = true;
    }
    setRequestedConversationId(null);
  }, [requestedConversationId, shell]);

  const applyStateResponse = useCallback((response: PrivateConnectResponse): void => {
    if (!response.ok) throw new Error(response.message);
    const result = projectionResult(response);
    if (!result) throw new Error("Private Connect returned an invalid state projection.");
    if (result.kind === "not-modified") return;
    if (result.kind !== "state") throw new Error("Private Connect returned an invalid state projection.");
    stateValidatorRef.current = result.validator;
    setShell(result.state);
  }, []);

  const applyConversationResponse = useCallback((
    response: PrivateConnectResponse,
    conversationId: string,
  ): void => {
    if (!response.ok) throw new Error(response.message);
    const result = projectionResult(response);
    if (!result) throw new Error("Private Connect returned an invalid conversation projection.");
    if (result.kind === "not-modified") return;
    if (result.kind !== "conversation") {
      throw new Error("Private Connect returned an invalid conversation projection.");
    }
    if (result.detail.conversation.id !== conversationId) {
      throw new Error("Private Connect returned a conversation outside the requested scope.");
    }
    conversationValidatorsRef.current.set(conversationId, result.validator);
    setDetail(result.detail);
  }, []);

  const loadSession = useCallback(async () => {
    const response = await fetch("/api/session/csrf", { credentials: "same-origin" });
    setHostUnavailable(false);
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
    void loadSession().catch((error) => {
      noteRequestFailure(error);
      setPair({ kind: "pair", invitation, error: error instanceof Error ? error.message : "Private Connect is unavailable." });
    });
  }, [loadSession, invitation, noteRequestFailure]);

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
        if (!cancelled) {
          setHostUnavailable(false);
          setPair({ kind: "waiting", requestId: started.requestId, comparisonCode: started.comparisonCode, error: null });
        }
      } catch (error) {
        if (!cancelled) {
          noteRequestFailure(error);
          setPair((current) => ({ ...current, error: error instanceof Error ? error.message : "Pairing could not start." }));
        }
      }
    })();
    return () => { cancelled = true; };
  }, [noteRequestFailure, pair.kind, pairRetry, pairingInvitation]);

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
        setHostUnavailable(false);
        unsubscribeClose = next.onClose((code) => {
          if (code === PRIVATE_CONNECT_SOCKET_CLOSE.accessRevoked) {
            clearWorkspace();
            setPair({ kind: "pair", invitation: null, error: "This browser no longer has access. Pair it again from the desktop." });
          } else {
            if (code === PRIVATE_CONNECT_SOCKET_CLOSE.authorityChanged) {
              clearWorkspace();
            } else {
              setHostUnavailable(true);
            }
            retry();
          }
        });
        setSocket(next);
      } catch (error) {
        if (isUnauthorized(error)) {
          setShell(null);
          setDetail(null);
          setSelectedConversation(null);
          setPair({ kind: "pair", invitation: null, error: "This browser no longer has access. Pair it again from the desktop." });
        } else {
          noteRequestFailure(error);
          retry();
        }
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
  }, [clearWorkspace, noteRequestFailure, pair.kind, readyCsrf]);

  const request = useCallback(async (value: Parameters<PrivateConnectSocket["request"]>[0], csrf: string) => {
    try {
      const response = socket ? await socket.request(value) : await apiRequest(value, csrf);
      setHostUnavailable(false);
      return response;
    } catch (error) {
      noteRequestFailure(error);
      throw error;
    }
  }, [noteRequestFailure, socket]);

  useEffect(() => {
    if (pair.kind !== "waiting") return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void jsonRequest<{ status: "pending" | "approved" | "denied" | "expired" }>("/api/pair/status", { requestId: pair.requestId }).then((status) => {
        if (cancelled) return;
        if (status.status === "approved") void loadSession();
        else if (status.status === "denied" || status.status === "expired") setPair({ kind: "pair", invitation: null, error: "Pairing was not approved." });
      }).catch((error) => {
        if (!cancelled) {
          noteRequestFailure(error);
          setPair({ kind: "pair", invitation: null, error: error instanceof Error ? error.message : "Pairing status is unavailable." });
        }
      });
    }, 1_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [pair, loadSession, noteRequestFailure]);

  useEffect(() => {
    if (!readyCsrf) return;
    let cancelled = false;
    const load = async (): Promise<void> => {
      const response = await request({
        protocolVersion: 1,
        type: "state.get",
        requestId: crypto.randomUUID(),
        ifNoneMatch: stateValidatorRef.current,
      }, readyCsrf);
      if (!cancelled) applyStateResponse(response);
    };
    void load().catch((error) => { if (!cancelled) setPair((current) => current.kind === "ready" ? { ...current, error: error instanceof Error ? error.message : "State could not be loaded." } : current); });
    return () => { cancelled = true; };
  }, [applyStateResponse, readyCsrf, request]);

  useEffect(() => {
    if (!readyCsrf || !selectedConversation) return;
    let cancelled = false;
    void request({
      protocolVersion: 1,
      type: "conversation.get",
      requestId: crypto.randomUUID(),
      conversationId: selectedConversation,
      ifNoneMatch: conversationValidatorsRef.current.get(selectedConversation) ?? null,
    }, readyCsrf).then((response) => {
      if (!cancelled) applyConversationResponse(response, selectedConversation);
    }).catch((error) => {
      if (!cancelled) setPair((current) => current.kind === "ready" ? { ...current, error: error instanceof Error ? error.message : "Conversation could not be loaded." } : current);
    });
    return () => { cancelled = true; };
  }, [applyConversationResponse, readyCsrf, request, selectedConversation]);

  useEffect(() => {
    if (!readyCsrf || !socket) return;
    let cancelled = false;
    const refresh = async (): Promise<void> => {
      const stateRequest = socket.request({
        protocolVersion: 1,
        type: "state.get",
        requestId: crypto.randomUUID(),
        ifNoneMatch: stateValidatorRef.current,
      });
      const detailRequest = selectedConversation
        ? socket.request({
            protocolVersion: 1,
            type: "conversation.get",
            requestId: crypto.randomUUID(),
            conversationId: selectedConversation,
            ifNoneMatch: conversationValidatorsRef.current.get(selectedConversation) ?? null,
          })
        : null;
      const [stateResponse, detailResponse] = await Promise.all([
        stateRequest,
        detailRequest,
      ]);
      if (cancelled) return;
      applyStateResponse(stateResponse);
      if (detailResponse && selectedConversation) {
        applyConversationResponse(detailResponse, selectedConversation);
      }
    };
    const timer = window.setInterval(() => {
      void refresh().catch((error) => {
        if (!cancelled) setPair((current) => current.kind === "ready" ? { ...current, error: error instanceof Error ? error.message : "Private Connect state could not be refreshed." } : current);
      });
    }, 5_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [applyConversationResponse, applyStateResponse, readyCsrf, selectedConversation, socket]);

  useLayoutEffect(() => {
    const messages = messagesRef.current;
    if (messages && followLatestRef.current) messages.scrollTop = messages.scrollHeight;
  }, [detail?.messages]);

  const sendPrompt = async (): Promise<void> => {
    if (hostUnavailable || pair.kind !== "ready" || !prompt.trim() || !shell?.capabilities.scopes.includes("private:prompt") || !selectedConversation) return;
    const content = prompt.trim();
    if (content.length > PRIVATE_CONNECT_LIMITS.promptCharacters) {
      setPair((current) => current.kind === "ready"
        ? { ...current, error: `Prompts are limited to ${PRIVATE_CONNECT_LIMITS.promptCharacters.toLocaleString()} characters.` }
        : current);
      return;
    }
    setBusy(true);
    try {
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

  const answerQuestions = async (answers: Record<string, string[]>): Promise<void> => {
    if (hostUnavailable || pair.kind !== "ready" || !selectedConversation || !detail?.inputRequestId || !shell?.capabilities.scopes.includes("private:input")) return;
    setBusy(true);
    try {
      const response = await request({ protocolVersion: 1, type: "input.respond", requestId: crypto.randomUUID(), conversationId: selectedConversation, inputRequestId: detail.inputRequestId, answers }, pair.csrf);
      if (!response.ok) throw new Error(response.message);
    } catch (error) {
      setPair((current) => current.kind === "ready" ? { ...current, error: error instanceof Error ? error.message : "The answer was not accepted." } : current);
    } finally { setBusy(false); }
  };

  const stopRun = async (): Promise<void> => {
    if (hostUnavailable || pair.kind !== "ready" || !selectedConversation || !detail?.conversation.runId || !shell?.capabilities.scopes.includes("private:stop")) return;
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
      clearWorkspace();
      setPair({ kind: "pair", invitation: null, error: null });
    } catch (error) {
      setPair((current) => current.kind === "ready" ? { ...current, error: error instanceof Error ? error.message : "Sign out failed." } : current);
    }
  };

  if (hostUnavailable && pair.kind !== "ready") {
    return <OfflineScreen onRetry={() => {
      setHostUnavailable(false);
      if (pair.kind === "pair" && pair.invitation) setPairRetry((current) => current + 1);
      else void loadSession().catch((error) => noteRequestFailure(error));
    }} />;
  }
  if (pair.kind === "checking") return <CheckingScreen />;
  if (pair.kind === "pair") return <PairScreen error={pair.error} />;
  if (pair.kind === "waiting") return <WaitingScreen comparisonCode={pair.comparisonCode} />;
  return (
    <WorkspaceShell
      shell={shell}
      detail={detail}
      error={pair.error}
      prompt={prompt}
      busy={busy}
      offline={hostUnavailable}
      selectedConversation={selectedConversation}
      messagesRef={messagesRef}
      onSelectConversation={(conversationId) => {
        conversationValidatorsRef.current.delete(conversationId);
        setSelectedConversation(conversationId);
        setDetail(null);
        followLatestRef.current = true;
      }}
      onScrollIntent={(followLatest) => { followLatestRef.current = followLatest; }}
      onPromptChange={setPrompt}
      onSendPrompt={() => void sendPrompt()}
      onAnswer={(answers) => void answerQuestions(answers)}
      onStopRun={() => void stopRun()}
      onSignOut={() => void signOut()}
    />
  );
}

type ProjectionResult =
  | { kind: "state"; validator: string; state: Shell }
  | { kind: "conversation"; validator: string; detail: Detail }
  | { kind: "not-modified"; validator: string };

function projectionResult(response: Extract<PrivateConnectResponse, { ok: true }>): ProjectionResult | null {
  const result = response.result;
  if (!result || typeof result !== "object" || !("kind" in result)) return null;
  const kind = result.kind;
  if ((kind !== "state" && kind !== "conversation" && kind !== "not-modified")
    || !("validator" in result)
    || typeof result.validator !== "string"
    || !/^[A-Za-z0-9_-]{43}$/u.test(result.validator)) return null;
  if (kind === "state" && "state" in result) {
    const state = privateConnectStateSchema.safeParse(result.state);
    return state.success
      ? { kind, validator: result.validator, state: state.data }
      : null;
  }
  if (kind === "conversation" && "detail" in result) {
    const detail = privateConnectConversationDetailSchema.safeParse(result.detail);
    return detail.success
      ? { kind, validator: result.validator, detail: detail.data }
      : null;
  }
  return kind === "not-modified"
    ? { kind, validator: result.validator }
    : null;
}

function suggestedDeviceLabel(): string {
  const platform = navigator.platform || "browser";
  return platform.slice(0, 64);
}

function isUnauthorized(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "status" in error && (error as { status?: unknown }).status === 401);
}

function hasHttpStatus(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "status" in error
    && typeof (error as { status?: unknown }).status === "number",
  );
}
