import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  PRIVATE_CONNECT_LIMITS,
  PRIVATE_CONNECT_SOCKET_CLOSE,
  privateConnectConversationDetailSchema,
  privateConnectStateSchema,
  type PrivateConnectResponse,
} from "../../../shared/private-connect/protocol";
import {
  privateConnectScheduledTaskSchema,
  type PrivateConnectScheduledTask,
} from "../../../shared/private-connect/runtime-contract";
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
import { createPrivateConnectPairingNonce } from "../../../shared/private-connect/pairing-link";
import { WorkspaceShell } from "./workspace/WorkspaceShell";
import type { ConversationDetailWithQueue } from "./workspace/ConversationPane";
import { privateConnectQueueProjectionSchema } from "./workspace/QueueSection";
import type { Shell } from "./types";

type PairState =
  | { kind: "checking" }
  | { kind: "pair"; invitation: PairingInvitation | null; error: string | null }
  | { kind: "waiting"; requestId: string; comparisonCode: string; error: string | null }
  | { kind: "ready"; csrf: string; error: string | null };

interface PromptDraft {
  content: string;
  pendingDelivery?: { content: string; deliveryId: string };
  error?: string;
}

export default function App({
  initialPairingFragment,
  initialConversationId = null,
}: {
  initialPairingFragment: string | null;
  initialConversationId?: string | null;
}): React.JSX.Element {
  const invitation = useMemo(() => parsePairingFragment(initialPairingFragment), [initialPairingFragment]);
  const [pair, setPair] = useState<PairState>(() => ({ kind: "checking" }));
  const [browserNonce] = useState(createPrivateConnectPairingNonce);
  const [shell, setShell] = useState<Shell | null>(null);
  const [detail, setDetail] = useState<ConversationDetailWithQueue | null>(null);
  const [scheduledTasks, setScheduledTasks] = useState<PrivateConnectScheduledTask[]>([]);
  const [scheduledTasksLoading, setScheduledTasksLoading] = useState(false);
  const [scheduledTasksError, setScheduledTasksError] = useState<string | null>(null);
  const [selectedConversation, setSelectedConversation] = useState<string | null>(null);
  const [promptDrafts, setPromptDrafts] = useState<Record<string, PromptDraft>>({});
  const promptDraft = selectedConversation ? promptDrafts[selectedConversation] : undefined;
  const prompt = promptDraft?.content ?? "";
  const [busy, setBusy] = useState(false);
  const [socket, setSocket] = useState<PrivateConnectSocket | null>(null);
  const [hostUnavailable, setHostUnavailable] = useState(() => navigator.onLine === false);
  const [pairRetry, setPairRetry] = useState(0);
  const [requestedConversationId, setRequestedConversationId] = useState(initialConversationId);
  const messagesRef = useRef<HTMLDivElement>(null);
  const followLatestRef = useRef(true);
  const stateValidatorRef = useRef<string | null>(null);
  const conversationValidatorsRef = useRef(new Map<string, string>());
  const authorizedConversationIdsRef = useRef(new Set<string>());
  const selectedConversationRef = useRef<string | null>(null);
  const scheduledTasksLoadedForCsrfRef = useRef<string | null>(null);

  const clearWorkspace = useCallback((): void => {
    setShell(null);
    setDetail(null);
    setScheduledTasks([]);
    setScheduledTasksError(null);
    scheduledTasksLoadedForCsrfRef.current = null;
    setPromptDrafts({});
    setSelectedConversation(null);
    selectedConversationRef.current = null;
    stateValidatorRef.current = null;
    conversationValidatorsRef.current.clear();
    authorizedConversationIdsRef.current.clear();
  }, []);

  const noteRequestFailure = useCallback((error: unknown): void => {
    if (isSocketOnlyFailure(error) || hasHttpStatus(error)) setHostUnavailable(false);
    else setHostUnavailable(true);
  }, []);
  const demoteSocket = useCallback((candidate: PrivateConnectSocket, error: unknown): void => {
    if (!isSocketOnlyFailure(error)) return;
    setSocket((current) => current === candidate ? null : current);
    candidate.close();
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
      selectedConversationRef.current = requestedConversationId;
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
    const authorizedConversationIds = new Set(
      result.state.conversations.map(({ id }) => id),
    );
    authorizedConversationIdsRef.current = authorizedConversationIds;
    setPromptDrafts((current) => {
      const retained = Object.entries(current).filter(([id]) => authorizedConversationIds.has(id));
      return retained.length === Object.keys(current).length ? current : Object.fromEntries(retained);
    });
    const selected = selectedConversationRef.current;
    if (selected && !authorizedConversationIds.has(selected)) {
      selectedConversationRef.current = null;
      conversationValidatorsRef.current.delete(selected);
      setDetail(null);
      followLatestRef.current = true;
      setSelectedConversation(null);
    }
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
    if (
      selectedConversationRef.current !== conversationId
      || !authorizedConversationIdsRef.current.has(conversationId)
    ) return;
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
          browserNonce,
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
  }, [browserNonce, noteRequestFailure, pair.kind, pairRetry, pairingInvitation]);

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
            }
            setHostUnavailable(false);
            retry();
          }
        });
        setSocket(next);
      } catch (error) {
        if (isUnauthorized(error)) {
          clearWorkspace();
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
    const currentSocket = socket;
    try {
      const response = currentSocket
        ? await currentSocket.request(value)
        : await apiRequest(value, csrf);
      setHostUnavailable(false);
      return response;
    } catch (error) {
      if (currentSocket) demoteSocket(currentSocket, error);
      noteRequestFailure(error);
      throw error;
    }
  }, [demoteSocket, noteRequestFailure, socket]);

  useEffect(() => {
    if (pair.kind !== "waiting") return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void jsonRequest<{ status: "pending" | "approved" | "denied" | "expired" }>("/api/pair/status", { requestId: pair.requestId, browserNonce }).then((status) => {
        if (cancelled) return;
        if (status.status === "approved") return loadSession();
        else if (status.status === "denied" || status.status === "expired") setPair({ kind: "pair", invitation: null, error: "Pairing was not approved." });
      }).catch((error) => {
        if (!cancelled) {
          noteRequestFailure(error);
          setPair({ kind: "pair", invitation: null, error: error instanceof Error ? error.message : "Pairing status is unavailable." });
        }
      });
    }, 1_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [browserNonce, pair, loadSession, noteRequestFailure]);

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
      const [stateOutcome, detailOutcome] = await Promise.allSettled([
        stateRequest,
        detailRequest,
      ]);
      if (cancelled) return;
      if (stateOutcome.status === "rejected") throw stateOutcome.reason;
      applyStateResponse(stateOutcome.value);
      if (
        selectedConversation
        && authorizedConversationIdsRef.current.has(selectedConversation)
      ) {
        if (detailOutcome.status === "rejected") throw detailOutcome.reason;
        if (detailOutcome.value) {
          applyConversationResponse(detailOutcome.value, selectedConversation);
        }
      }
    };
    const timer = window.setInterval(() => {
      void refresh().catch((error) => {
        if (!cancelled) {
          demoteSocket(socket, error);
          setPair((current) => current.kind === "ready" ? { ...current, error: error instanceof Error ? error.message : "Private Connect state could not be refreshed." } : current);
        }
      });
    }, 5_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [applyConversationResponse, applyStateResponse, demoteSocket, readyCsrf, selectedConversation, socket]);

  useLayoutEffect(() => {
    const messages = messagesRef.current;
    if (messages && followLatestRef.current) messages.scrollTop = messages.scrollHeight;
  }, [detail?.messages]);

  const sendPrompt = async (): Promise<void> => {
    if (hostUnavailable || pair.kind !== "ready" || !prompt.trim() || !shell?.capabilities.scopes.includes("private:prompt") || !selectedConversation) return;
    const content = prompt.trim();
    if (content.length > PRIVATE_CONNECT_LIMITS.promptCharacters) {
      setPair((current) => current.kind === "ready"
        ? { ...current, error: `Prompts are limited to ${PRIVATE_CONNECT_LIMITS.promptCharacters.toLocaleString("en")} characters.` }
        : current);
      return;
    }
    setBusy(true);
    try {
      const deliveryId = promptDraft?.pendingDelivery?.content === content
        ? promptDraft.pendingDelivery.deliveryId
        : crypto.randomUUID();
      setPromptDrafts((current) => ({
        ...current,
        [selectedConversation]: { content: prompt, pendingDelivery: { content, deliveryId } },
      }));
      const response = await request({ protocolVersion: 1, type: "prompt.send", requestId: crypto.randomUUID(), deliveryId, conversationId: selectedConversation, content }, pair.csrf);
      if (!response.ok) {
        throw new Error(response.code === "uncertain"
          ? `${response.message} Sending again will safely check the same delivery.`
          : response.message);
      }
      setPromptDrafts((current) => {
        const draft = current[selectedConversation];
        if (draft?.pendingDelivery?.deliveryId !== deliveryId) return current;
        const next = { ...current };
        if (draft.content === prompt) delete next[selectedConversation];
        else next[selectedConversation] = { content: draft.content };
        return next;
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "The prompt was not accepted.";
      setPromptDrafts((current) => {
        const draft = current[selectedConversation];
        return draft ? { ...current, [selectedConversation]: { ...draft, error: message } } : current;
      });
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

  const refreshSelectedConversation = useCallback(async (conversationId: string, csrf: string): Promise<void> => {
    conversationValidatorsRef.current.delete(conversationId);
    const updated = await request({
      protocolVersion: 1,
      type: "conversation.get",
      requestId: crypto.randomUUID(),
      conversationId,
      ifNoneMatch: null,
    }, csrf);
    applyConversationResponse(updated, conversationId);
  }, [applyConversationResponse, request]);

  const mutateQueue = async (
    payload: Record<string, unknown>,
    fallbackError: string,
  ): Promise<boolean> => {
    if (hostUnavailable || pair.kind !== "ready" || !selectedConversation || !shell?.capabilities.scopes.includes("private:prompt")) return false;
    setBusy(true);
    setPair((current) => current.kind === "ready" ? { ...current, error: null } : current);
    try {
      const response = await request({
        protocolVersion: 1,
        requestId: crypto.randomUUID(),
        conversationId: selectedConversation,
        ...payload,
      } as Parameters<PrivateConnectSocket["request"]>[0], pair.csrf);
      if (!response.ok) {
        if (response.code === "stale") {
          await refreshSelectedConversation(selectedConversation, pair.csrf).catch(() => undefined);
        }
        throw new Error(response.message);
      }
      await refreshSelectedConversation(selectedConversation, pair.csrf).catch(() => undefined);
      return true;
    } catch (error) {
      setPair((current) => current.kind === "ready"
        ? { ...current, error: error instanceof Error ? error.message : fallbackError }
        : current);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const sendQueueItem = (id: string): Promise<void> =>
    mutateQueue({ type: "queue.send", id }, "The queued message could not be sent.").then(() => undefined);

  const editQueueItem = (id: string, expectedRevision: number, content: string): Promise<boolean> =>
    mutateQueue({ type: "queue.edit", id, expectedRevision, content }, "The queued message could not be edited.");

  const removeQueueItem = (id: string): Promise<void> =>
    mutateQueue({ type: "queue.remove", id }, "The queued message could not be removed.").then(() => undefined);

  const resumeQueue = (): Promise<void> =>
    mutateQueue({ type: "queue.resume" }, "The queue could not be resumed.").then(() => undefined);

  const refreshScheduledTasks = useCallback(async (): Promise<void> => {
    if (hostUnavailable || !readyCsrf) return;
    setScheduledTasksLoading(true);
    try {
      const response = await request(
        { protocolVersion: 1, type: "scheduled-tasks.list", requestId: crypto.randomUUID() },
        readyCsrf,
      );
      if (!response.ok) throw new Error(response.message);
      const raw = response.result as { kind?: unknown; tasks?: unknown };
      if (raw?.kind === "scheduled-tasks" && Array.isArray(raw.tasks)) {
        const parsed = raw.tasks.flatMap((entry) => {
          const item = privateConnectScheduledTaskSchema.safeParse(entry);
          return item.success ? [item.data] : [];
        });
        setScheduledTasks(parsed);
      }
      setScheduledTasksError(null);
    } catch (error) {
      setScheduledTasksError(
        error instanceof Error ? error.message : "Scheduled tasks could not be loaded.",
      );
    } finally {
      setScheduledTasksLoading(false);
    }
  }, [hostUnavailable, readyCsrf, request]);

  useEffect(() => {
    if (!readyCsrf || !shell || hostUnavailable) {
      scheduledTasksLoadedForCsrfRef.current = null;
      return;
    }
    if (scheduledTasksLoadedForCsrfRef.current === readyCsrf) return;
    scheduledTasksLoadedForCsrfRef.current = readyCsrf;
    void refreshScheduledTasks();
  }, [hostUnavailable, readyCsrf, refreshScheduledTasks, shell]);

  const mutateScheduledTask = async (
    payload:
      | { type: "scheduled-task.toggle"; taskId: string; enabled: boolean }
      | { type: "scheduled-task.run-now"; taskId: string }
      | { type: "scheduled-task.delete"; taskId: string },
    fallbackError: string,
  ): Promise<void> => {
    if (hostUnavailable || !readyCsrf || !shell?.capabilities.scopes.includes("private:prompt")) return;
    setBusy(true);
    setScheduledTasksError(null);
    try {
      const response = await request({ protocolVersion: 1, requestId: crypto.randomUUID(), ...payload }, readyCsrf);
      if (!response.ok) throw new Error(response.message);
      await refreshScheduledTasks();
    } catch (error) {
      setScheduledTasksError(error instanceof Error ? error.message : fallbackError);
    } finally {
      setBusy(false);
    }
  };

  const toggleScheduledTask = (taskId: string, enabled: boolean): Promise<void> =>
    mutateScheduledTask({ type: "scheduled-task.toggle", taskId, enabled }, "The scheduled task could not be updated.");

  const runScheduledTaskNow = (taskId: string): Promise<void> =>
    mutateScheduledTask({ type: "scheduled-task.run-now", taskId }, "The scheduled task could not be started.");

  const deleteScheduledTask = (taskId: string): Promise<void> =>
    mutateScheduledTask({ type: "scheduled-task.delete", taskId }, "The scheduled task could not be deleted.");

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
      scheduledTasks={scheduledTasks}
      scheduledTasksLoading={scheduledTasksLoading}
      error={pair.error ?? scheduledTasksError ?? promptDraft?.error ?? null}
      prompt={prompt}
      busy={busy}
      offline={hostUnavailable}
      selectedConversation={selectedConversation}
      messagesRef={messagesRef}
      onSelectConversation={(conversationId) => {
        conversationValidatorsRef.current.delete(conversationId);
        selectedConversationRef.current = conversationId;
        setSelectedConversation(conversationId);
        setDetail(null);
        followLatestRef.current = true;
      }}
      onScrollIntent={(followLatest) => { followLatestRef.current = followLatest; }}
      onPromptChange={(content) => {
        if (!selectedConversation) return;
        setPromptDrafts((current) => ({
          ...current,
          [selectedConversation]: { ...current[selectedConversation], content },
        }));
      }}
      onSendPrompt={() => void sendPrompt()}
      onAnswer={(answers) => void answerQuestions(answers)}
      onStopRun={() => void stopRun()}
      onSendQueueItem={sendQueueItem}
      onEditQueueItem={editQueueItem}
      onRemoveQueueItem={removeQueueItem}
      onResumeQueue={resumeQueue}
      onRefreshScheduledTasks={refreshScheduledTasks}
      onToggleScheduledTask={toggleScheduledTask}
      onRunScheduledTaskNow={runScheduledTaskNow}
      onDeleteScheduledTask={deleteScheduledTask}
      onSignOut={() => void signOut()}
    />
  );
}

type ProjectionResult =
  | { kind: "state"; validator: string; state: Shell }
  | { kind: "conversation"; validator: string; detail: ConversationDetailWithQueue }
  | { kind: "not-modified"; validator: string };

function parseConversationDetailWithQueue(raw: unknown): ConversationDetailWithQueue | null {
  const direct = privateConnectConversationDetailSchema.safeParse(raw);
  if (direct.success) return direct.data as ConversationDetailWithQueue;
  if (!raw || typeof raw !== "object" || !("queue" in raw)) return null;
  const { queue, ...rest } = raw as Record<string, unknown>;
  const base = privateConnectConversationDetailSchema.safeParse(rest);
  if (!base.success) return null;
  if (queue === undefined) return base.data;
  const parsedQueue = privateConnectQueueProjectionSchema.safeParse(queue);
  if (!parsedQueue.success) return null;
  return { ...base.data, queue: parsedQueue.data };
}

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
    const detail = parseConversationDetailWithQueue(result.detail);
    return detail
      ? { kind, validator: result.validator, detail }
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

function isSocketOnlyFailure(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "privateConnectTransport" in error
    && (error as { privateConnectTransport?: unknown }).privateConnectTransport
      === "private-connect-websocket",
  );
}
