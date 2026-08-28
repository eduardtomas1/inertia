import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Maximize2, RotateCcw, TerminalSquare, X } from "lucide-react";
import type { ProviderTerminalResumeDescriptor, ServerEvent } from "@shared/contracts";
import { runtimeCommandDelivery } from "../utils/connectionMessages";
import { terminalInputChunks } from "../utils/terminalInputChunks";
import type { ProviderTerminalResumeOption } from "./providerResumeOptions";
import {
  command,
  MAX_PERSISTED_TERMINAL_TABS,
  providerTerminalExitPresentation,
  TERMINAL_CREATE_RETRY_DELAYS_MS,
  TERMINAL_SETTLING_RETRY_DELAYS_MS,
  terminalTheme,
  type TerminalPanelProps,
  type TerminalReplacement,
  waitForTerminalRetry,
} from "./TerminalPanelSupport";
import { IconButton, LoadingMark } from "./ui";

const TerminalResumeStatus = lazy(async () => ({
  default: (await import("./TerminalResumeStatus")).TerminalResumeStatus,
}));

type TerminalSessionProps = TerminalPanelProps & {
  initialTerminalId: string | null;
  siblingResumedConversationIds: ReadonlySet<string>;
  onRestorableTerminalChange: (
    terminalId: string | null,
  ) => void;
  onTerminalReplaced: (replacement: TerminalReplacement) => boolean;
  onProviderResumeStarted: (terminalId: string, conversationId: string) => void;
};
const MAX_PENDING_TERMINAL_OUTPUT = 256 * 1_024 + 256;
const MAX_PENDING_TERMINAL_EXITS = 8;

export function TerminalSession({
  projectId,
  conversationId,
  projectName,
  status,
  fontSize,
  theme,
  colorTheme,
  sendCommand,
  subscribe,
  actionId,
  onActionStarted,
  providerResume,
  providerResumes,
  resumeRequestConversationId,
  onResumeRequestHandled,
  initialTerminalId,
  siblingResumedConversationIds,
  onRestorableTerminalChange,
  onTerminalReplaced,
  onProviderResumeStarted,
  onClose,
  visible = true,
}: TerminalSessionProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const terminalIdRef = useRef<string | null>(initialTerminalId);
  const terminalReadyRef = useRef(false);
  const managedActionTerminalRef = useRef(false);
  const resumedProviderRef = useRef<ProviderTerminalResumeDescriptor | null>(null);
  const actionInFlightRef = useRef<string | null>(null);
  const ownerRef = useRef(`${projectId}:${conversationId ?? ""}`);
  const statusRef = useRef(status);
  const pendingOutputRef = useRef(new Map<string, string>());
  const pendingExitRef = useRef(new Map<string, number>());
  const operationInFlightRef = useRef(false);
  const reattachPendingRef = useRef(false);
  const reconciliationNoticeRef = useRef<{
    message: string;
    source: "action" | "provider";
  } | null>(null);
  const replacementReconciliationRef = useRef<{
    requestId: string;
    source: "action" | "provider";
    phase: "pending" | "reconciling";
  } | null>(null);
  const resumeAttemptRef = useRef(0);
  const mountedRef = useRef(false);
  const initialOptionsRef = useRef({ fontSize, theme });
  const lastSizeRef = useRef({ cols: 0, rows: 0 });
  const [instanceReady, setInstanceReady] = useState(false);
  const [sessionKey, setSessionKey] = useState(0);
  const [sessionState, setSessionState] = useState<"starting" | "ready" | "closed" | "error">("starting");
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const [resumeInFlight, setResumeInFlight] = useState(false);
  const [activeResume, setActiveResume] = useState<ProviderTerminalResumeDescriptor | null>(null);
  const resumeOptions = useMemo<readonly ProviderTerminalResumeOption[]>(() => {
    if (providerResumes && providerResumes.length > 0) return providerResumes;
    if (!providerResume || !conversationId) return [];
    return [{
      projectId,
      projectName,
      conversationId,
      conversationTitle: "Current chat",
      availability: providerResume,
    }];
  }, [conversationId, projectId, projectName, providerResume, providerResumes]);
  const [selectedResumeConversationId, setSelectedResumeConversationId] = useState(
    conversationId ?? "",
  );
  const selectedResumeOption = resumeOptions.find(
    ({ conversationId: candidateId }) => candidateId === selectedResumeConversationId,
  ) ?? resumeOptions.find(({ availability }) => availability.kind === "available")
    ?? resumeOptions[0]
    ?? null;
  const resumeBlockedBySibling = selectedResumeOption !== null
    && siblingResumedConversationIds.has(selectedResumeOption.conversationId);
  const [terminalId, setTerminalId] = useState<string | null>(initialTerminalId);
  const resumeProviderSessionRef = useRef<() => boolean>(() => false);
  const handledResumeRequestRef = useRef<string | null>(null);
  const onRestorableTerminalChangeRef = useRef(onRestorableTerminalChange);
  const onTerminalReplacedRef = useRef(onTerminalReplaced);
  const onProviderResumeStartedRef = useRef(onProviderResumeStarted);
  onRestorableTerminalChangeRef.current = onRestorableTerminalChange;
  onTerminalReplacedRef.current = onTerminalReplaced;
  onProviderResumeStartedRef.current = onProviderResumeStarted;
  ownerRef.current = `${projectId}:${conversationId ?? ""}`;
  statusRef.current = status;
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (
      selectedResumeOption
      && selectedResumeOption.conversationId !== selectedResumeConversationId
    ) {
      setSelectedResumeConversationId(selectedResumeOption.conversationId);
    }
  }, [selectedResumeConversationId, selectedResumeOption]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: true,
      cursorBlink: true,
      cursorStyle: "bar",
      disableStdin: true,
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      fontSize: initialOptionsRef.current.fontSize,
      lineHeight: 1.35,
      scrollback: 4_000,
      theme: terminalTheme(initialOptionsRef.current.theme),
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    terminalRef.current = terminal;
    fitRef.current = fitAddon;
    fitAddon.fit();
    setInstanceReady(true);

    const inputDisposable = terminal.onData((data) => {
      const terminalId = terminalIdRef.current;
      if (
        !terminalId
        || !terminalReadyRef.current
        || statusRef.current !== "online"
      ) return;
      for (const chunk of terminalInputChunks(data)) {
        void sendCommand(command({ type: "terminal.input", payload: { terminalId, data: chunk } })).catch(() => undefined);
      }
    });

    let frame: number | undefined;
    const observer = new ResizeObserver(() => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        try {
          fitAddon.fit();
          const next = { cols: Math.max(20, terminal.cols), rows: Math.max(4, terminal.rows) };
          const previous = lastSizeRef.current;
          if (next.cols === previous.cols && next.rows === previous.rows) return;
          lastSizeRef.current = next;
          const terminalId = terminalIdRef.current;
          if (
            terminalId
            && terminalReadyRef.current
            && statusRef.current === "online"
          ) {
            void sendCommand(command({ type: "terminal.resize", payload: { terminalId, ...next } })).catch(() => undefined);
          }
        } catch {
          // The terminal may be between responsive layouts; the next observation will fit it.
        }
      });
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      inputDisposable.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      setInstanceReady(false);
      terminal.dispose();
    };
  }, [sendCommand]);

  useLayoutEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.disableStdin = sessionState !== "ready" || status !== "online";
  }, [sessionState, status]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => {
      terminal.options.fontSize = fontSize;
      terminal.options.theme = terminalTheme(theme);
      try {
        fitRef.current?.fit();
      } catch {
        // A resize observation will retry once the panel has dimensions again.
      }
    };
    update();
    if (theme === "system") media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [colorTheme, fontSize, theme]);

  useEffect(() => {
    if (!visible) return;
    let secondFrame: number | undefined;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        try {
          fitRef.current?.fit();
          const terminal = terminalRef.current;
          const terminalId = terminalIdRef.current;
          if (
            !terminal
            || !terminalId
            || !terminalReadyRef.current
            || statusRef.current !== "online"
          ) return;
          const next = { cols: Math.max(20, terminal.cols), rows: Math.max(4, terminal.rows) };
          lastSizeRef.current = next;
          void sendCommand(command({ type: "terminal.resize", payload: { terminalId, ...next } })).catch(() => undefined);
        } catch {
          // ResizeObserver will retry after the revealed panel has settled.
        }
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame !== undefined) window.cancelAnimationFrame(secondFrame);
    };
  }, [sendCommand, visible]);

  useEffect(() => subscribe((event) => {
    const replacementReconciliation = replacementReconciliationRef.current;
    if (
      replacementReconciliation
      && replacementReconciliation.phase === "pending"
      && "requestId" in event
      && event.requestId === replacementReconciliation.requestId
      && event.type === "terminal.created"
    ) {
      replacementReconciliationRef.current = {
        ...replacementReconciliation,
        phase: "reconciling",
      };
      setSessionKey((value) => value + 1);
      return;
    }
    if (
      replacementReconciliation
      && "requestId" in event
      && event.requestId === replacementReconciliation.requestId
      && event.type === "request.error"
    ) {
      replacementReconciliationRef.current = null;
      setSessionKey((value) => value + 1);
      return;
    }
    if (event.type === "terminal.output") {
      if (
        event.terminalId === terminalIdRef.current
        && terminalReadyRef.current
        && statusRef.current === "online"
      ) {
        terminalRef.current?.write(event.data);
      } else if (
        event.terminalId === terminalIdRef.current
        || operationInFlightRef.current
      ) {
        const buffered = pendingOutputRef.current.get(event.terminalId) ?? "";
        if (
          !pendingOutputRef.current.has(event.terminalId)
          && pendingOutputRef.current.size >= MAX_PERSISTED_TERMINAL_TABS
        ) {
          const oldest = pendingOutputRef.current.keys().next().value;
          if (oldest) pendingOutputRef.current.delete(oldest);
        }
        pendingOutputRef.current.set(
          event.terminalId,
          `${buffered}${event.data}`.slice(-MAX_PENDING_TERMINAL_OUTPUT),
        );
      }
    }
    if (event.type === "terminal.exit" && operationInFlightRef.current) {
      if (
        !pendingExitRef.current.has(event.terminalId)
        && pendingExitRef.current.size >= MAX_PENDING_TERMINAL_EXITS
      ) {
        const oldest = pendingExitRef.current.keys().next().value;
        if (oldest) pendingExitRef.current.delete(oldest);
      }
      pendingExitRef.current.set(event.terminalId, event.exitCode);
      return;
    }
    if (event.type === "terminal.exit") {
      pendingOutputRef.current.delete(event.terminalId);
      pendingExitRef.current.delete(event.terminalId);
    }
    if (event.type === "terminal.exit" && event.terminalId === terminalIdRef.current) {
      const resumedProvider = resumedProviderRef.current;
      terminalRef.current?.writeln(`\r\n\x1b[2mProcess exited with code ${event.exitCode}.\x1b[0m`);
      terminalIdRef.current = null;
      terminalReadyRef.current = false;
      managedActionTerminalRef.current = false;
      resumedProviderRef.current = null;
      setActiveResume(null);
      setTerminalId(null);
      onRestorableTerminalChangeRef.current(null);
      if (resumedProvider) {
        const exit = providerTerminalExitPresentation(resumedProvider, event.exitCode);
        setSessionError(exit.message);
        setSessionState(exit.state);
      } else {
        setSessionError(null);
        setSessionState("closed");
      }
    }
  }), [subscribe]);

  useEffect(() => {
    resumeAttemptRef.current += 1;
    if (!instanceReady) return;
    terminalReadyRef.current = false;
    if (status !== "online") {
      setSessionState(status === "offline" ? "error" : "starting");
      return;
    }

    let cancelled = false;
    const terminal = terminalRef.current;
    const fitAddon = fitRef.current;
    const pendingOutput = pendingOutputRef.current;
    const pendingExit = pendingExitRef.current;
    setSessionState("starting");
    setSessionError(null);
    setResumeError(null);
    setResumeInFlight(false);
    setActiveResume(null);
    pendingOutput.clear();
    pendingExit.clear();
    operationInFlightRef.current = true;
    terminal?.clear();
    terminal?.writeln(
      terminalIdRef.current
        ? `\x1b[2mReconnecting the local terminal for ${projectName}…\x1b[0m`
        : `\x1b[2mStarting a local terminal for ${projectName}…\x1b[0m`,
    );

    try {
      fitAddon?.fit();
    } catch {
      // Safe defaults below will be corrected by ResizeObserver.
    }
    const size = {
      cols: Math.max(20, terminal?.cols ?? 80),
      rows: Math.max(4, terminal?.rows ?? 24),
    };
    lastSizeRef.current = size;

    const finishTerminal = (
      event: Extract<ServerEvent, { type: "terminal.created" }>,
      managedAction = false,
    ): void => {
      terminalIdRef.current = event.terminalId;
      reattachPendingRef.current = false;
      managedActionTerminalRef.current = managedAction;
      resumedProviderRef.current = event.providerResume ?? null;
      setActiveResume(event.providerResume ?? null);
      setTerminalId(event.terminalId);
      onRestorableTerminalChangeRef.current(event.terminalId);
      if (event.providerResume && event.providerResumeConversationId) {
        onProviderResumeStartedRef.current(
          event.terminalId,
          event.providerResumeConversationId,
        );
      }
      const bufferedOutput = pendingOutputRef.current.get(event.terminalId);
      const earlyExitCode = pendingExit.get(event.terminalId);
      pendingOutput.clear();
      pendingExit.clear();
      operationInFlightRef.current = false;
      if (earlyExitCode !== undefined) {
        terminalIdRef.current = null;
        managedActionTerminalRef.current = false;
        resumedProviderRef.current = null;
        setActiveResume(null);
        setTerminalId(null);
        onRestorableTerminalChangeRef.current(null);
        if (bufferedOutput) terminal?.write(bufferedOutput);
        terminal?.writeln(`\r\n\x1b[2mProcess exited with code ${earlyExitCode}.\x1b[0m`);
        setSessionState("closed");
        return;
      }
      terminalReadyRef.current = true;
      setSessionState("ready");
      if (bufferedOutput) terminal?.write(bufferedOutput);
      const reconciliationNotice = reconciliationNoticeRef.current;
      reconciliationNoticeRef.current = null;
      if (reconciliationNotice) {
        terminal?.writeln(`\r\n\x1b[31m${reconciliationNotice.message}\x1b[0m`);
        setSessionError(reconciliationNotice.message);
        if (reconciliationNotice.source === "provider") {
          setResumeError(reconciliationNotice.message);
        }
      }
    };

    const startTerminal = async (): Promise<void> => {
      const reattachId = terminalIdRef.current;
      const replacementReconciliation = replacementReconciliationRef.current;
      if (replacementReconciliation?.phase === "pending") {
        replacementReconciliationRef.current = {
          ...replacementReconciliation,
          phase: "reconciling",
        };
      }
      for (let attempt = 0; ; attempt += 1) {
        try {
          if (reattachId) {
            terminal?.clear();
            pendingOutput.delete(reattachId);
          }
          const event = await sendCommand(command(reattachId
              ? {
                  type: "terminal.attach" as const,
                  payload: {
                    projectId,
                    conversationId,
                    terminalId: reattachId,
                    replacementRequestId: replacementReconciliation?.requestId,
                    ...size,
                  },
                }
              : {
                  type: "terminal.create" as const,
                  payload: { projectId, conversationId, ...size },
                }));
          if (
            event.type !== "terminal.created"
            || (
              reattachId
              && event.terminalId !== reattachId
              && replacementReconciliation === null
            )
          ) {
            throw new Error("The terminal service returned an unexpected response.");
          }
          if (cancelled) {
            operationInFlightRef.current = false;
            if (!reattachId) void sendCommand(command({
              type: "terminal.close",
              payload: { terminalId: event.terminalId },
            })).catch(() => undefined);
            return;
          }
          if (event.providerResume && !event.providerResumeConversationId) {
            throw new Error("The terminal service omitted its resumed chat identity.");
          }
          if (
            reattachId
            && event.terminalId !== reattachId
            && !onTerminalReplacedRef.current({
              previousTerminalId: reattachId,
              terminalId: event.terminalId,
              preservePrevious: !pendingExitRef.current.has(reattachId),
            })
          ) {
            const message = "The recovered terminal could not open because the terminal tab limit was reached.";
            replacementReconciliationRef.current = null;
            reconciliationNoticeRef.current = {
              message,
              source: replacementReconciliation?.source ?? "action",
            };
            try {
              await sendCommand(command({
                type: "terminal.close",
                payload: { terminalId: event.terminalId },
              }));
            } catch {
              // The exact replacement remains bounded by detached cleanup.
            }
            if (!cancelled) setSessionKey((value) => value + 1);
            return;
          }
          if (!reattachId) terminal?.clear();
          replacementReconciliationRef.current = null;
          if (replacementReconciliation) {
            reconciliationNoticeRef.current = null;
            setSessionError(null);
            setResumeError(null);
          }
          finishTerminal(event, replacementReconciliation?.source === "action");
          return;
        } catch (terminalError) {
          if (cancelled) return;
          const delivery = runtimeCommandDelivery(terminalError);
          if (
            replacementReconciliation
            && delivery === "rejected"
            && terminalError instanceof Error
            && terminalError.message.includes("Terminal replacement not found")
          ) {
            replacementReconciliationRef.current = null;
            setSessionKey((value) => value + 1);
            return;
          }
          const retryDelay = TERMINAL_CREATE_RETRY_DELAYS_MS[attempt];
          if (reattachId && delivery === "rejected") {
            if (
              terminalError instanceof Error
              && terminalError.message.includes("is still stopping")
            ) {
              const settlingRetryDelay = TERMINAL_SETTLING_RETRY_DELAYS_MS[attempt];
              if (settlingRetryDelay !== undefined) {
                terminal?.writeln(`\r\n\x1b[2mTerminal cleanup is still settling. Retrying reconnect (${attempt + 2}/${TERMINAL_SETTLING_RETRY_DELAYS_MS.length + 1})…\x1b[0m`);
                await waitForTerminalRetry(settlingRetryDelay);
                continue;
              }
              operationInFlightRef.current = false;
              reattachPendingRef.current = true;
              setSessionState("error");
              setSessionError(terminalError.message);
              return;
            }
            if (
              terminalError instanceof Error
              && /(?:could not be confirmed stopped|could not be retired|has not been confirmed stopped)/iu
                .test(terminalError.message)
            ) {
              operationInFlightRef.current = false;
              setSessionState("error");
              setSessionError(terminalError.message);
              return;
            }
            operationInFlightRef.current = false;
            terminalIdRef.current = null;
            setTerminalId(null);
            onRestorableTerminalChangeRef.current(null);
            setSessionKey((value) => value + 1);
            return;
          }
          if (
            retryDelay === undefined
            || (delivery !== "not-sent" && (!reattachId || delivery !== "ambiguous"))
          ) {
            setSessionState("error");
            setSessionError(terminalError instanceof Error
              ? terminalError.message
              : reattachId
                ? "The terminal could not be reconnected."
                : "The terminal could not be started.");
            operationInFlightRef.current = false;
            return;
          }
          terminal?.writeln(`\r\n\x1b[2mConnection interrupted. Retrying terminal (${attempt + 2}/3)…\x1b[0m`);
          await waitForTerminalRetry(retryDelay);
        }
      }
    };
    void startTerminal();

    return () => {
      resumeAttemptRef.current += 1;
      cancelled = true;
      pendingOutput.clear();
      pendingExit.clear();
      operationInFlightRef.current = false;
    };
  }, [
    conversationId,
    instanceReady,
    projectId,
    projectName,
    sendCommand,
    sessionKey,
    status,
  ]);

  useEffect(() => {
    const owner = `${projectId}:${conversationId ?? ""}`;
    const actionIdentity = `${owner}:${actionId ?? ""}`;
    if (!actionId) {
      actionInFlightRef.current = null;
      return;
    }
    if (
      actionInFlightRef.current === actionIdentity
      || resumeInFlight
      || sessionState !== "ready"
      || status !== "online"
      || !terminalIdRef.current
    ) return;
    actionInFlightRef.current = actionIdentity;
    const previousId = terminalIdRef.current;
    const ownsResponse = (): boolean => (
      mountedRef.current
      && ownerRef.current === owner
      && actionInFlightRef.current === actionIdentity
    );
    const size = {
      cols: Math.max(20, terminalRef.current?.cols ?? lastSizeRef.current.cols ?? 80),
      rows: Math.max(4, terminalRef.current?.rows ?? lastSizeRef.current.rows ?? 24),
    };
    terminalReadyRef.current = false;
    operationInFlightRef.current = true;
    setSessionState("starting");
    terminalRef.current?.clear();
    terminalRef.current?.writeln(`\x1b[2mStarting ${actionId}…\x1b[0m`);
    const actionCommand = command({
      type: "project.action.run",
      payload: {
        projectId,
        conversationId,
        actionId,
        terminalId: previousId,
        ...size,
      },
      });
    void sendCommand(actionCommand)
      .then((event) => {
        if (event.type !== "terminal.created") {
          throw new Error("The action terminal returned an unexpected response.");
        }
        if (!ownsResponse()) {
          if (actionInFlightRef.current === actionIdentity) {
            actionInFlightRef.current = null;
          }
          pendingOutputRef.current.delete(event.terminalId);
          pendingExitRef.current.delete(event.terminalId);
          operationInFlightRef.current = false;
          if (event.terminalId !== previousId) {
            void sendCommand(command({
              type: "terminal.close",
              payload: { terminalId: event.terminalId },
            })).catch(() => undefined);
          }
          return;
        }
        const terminalReplaced = event.terminalId !== previousId;
        if (
          terminalReplaced
          && !onTerminalReplacedRef.current({
            previousTerminalId: previousId,
            terminalId: event.terminalId,
            preservePrevious: !pendingExitRef.current.has(previousId),
          })
        ) {
          void sendCommand(command({
            type: "terminal.close",
            payload: { terminalId: event.terminalId },
          })).catch(() => undefined);
          throw new Error(
            "The action could not open because the terminal tab limit was reached.",
          );
        }
        terminalIdRef.current = event.terminalId;
        managedActionTerminalRef.current = true;
        resumedProviderRef.current = null;
        setActiveResume(null);
        setTerminalId(event.terminalId);
        if (!terminalReplaced) {
          onRestorableTerminalChangeRef.current(event.terminalId);
        }
        const bufferedOutput = pendingOutputRef.current.get(event.terminalId);
        const earlyExitCode = pendingExitRef.current.get(event.terminalId);
        pendingOutputRef.current.clear();
        pendingExitRef.current.clear();
        operationInFlightRef.current = false;
        terminalRef.current?.clear();
        if (bufferedOutput) terminalRef.current?.write(bufferedOutput);
        if (earlyExitCode !== undefined) {
          terminalIdRef.current = null;
          managedActionTerminalRef.current = false;
          setTerminalId(null);
          onRestorableTerminalChangeRef.current(null);
          terminalRef.current?.writeln(`\r\n\x1b[2mProcess exited with code ${earlyExitCode}.\x1b[0m`);
          setSessionState("closed");
          actionInFlightRef.current = null;
          onActionStarted?.();
          return;
        }
        terminalReadyRef.current = true;
        setSessionState("ready");
        actionInFlightRef.current = null;
        onActionStarted?.();
      })
      .catch((error) => {
        if (!ownsResponse()) {
          if (actionInFlightRef.current === actionIdentity) {
            actionInFlightRef.current = null;
          }
          return;
        }
        const delivery = runtimeCommandDelivery(error);
        const message = error instanceof Error
          ? error.message
          : "The project action could not be started.";
        const visibleMessage = delivery === "ambiguous"
          ? `${message} The action may still be running; check Work before retrying.`
          : message;
        reconciliationNoticeRef.current = {
          message: visibleMessage,
          source: "action",
        };
        replacementReconciliationRef.current = delivery === "ambiguous"
          ? { requestId: actionCommand.requestId, source: "action", phase: "pending" }
          : null;
        if (delivery !== "ambiguous") {
          operationInFlightRef.current = false;
        }
        onActionStarted?.();
        if (delivery !== "ambiguous") {
          setSessionKey((value) => value + 1);
        }
      });
  }, [actionId, conversationId, onActionStarted, projectId, resumeInFlight, sendCommand, sessionState, status]);

  const resumeProviderSession = (): boolean => {
    if (
      selectedResumeOption?.availability.kind !== "available"
      || resumeBlockedBySibling
      || resumeInFlight
      || sessionState !== "ready"
      || status !== "online"
      || !terminalIdRef.current
    ) return false;
    const resume = selectedResumeOption.availability.resume;
    const size = {
      cols: Math.max(20, terminalRef.current?.cols ?? lastSizeRef.current.cols ?? 80),
      rows: Math.max(4, terminalRef.current?.rows ?? lastSizeRef.current.rows ?? 24),
    };
    const previousId = terminalIdRef.current;
    const attempt = resumeAttemptRef.current + 1;
    resumeAttemptRef.current = attempt;
    terminalReadyRef.current = false;
    operationInFlightRef.current = true;
    setSessionState("starting");
    setResumeInFlight(true);
    setResumeError(null);
    terminalRef.current?.writeln(
      `\r\n\x1b[2mResuming ${resume.providerLabel} session ${resume.sessionId}…\x1b[0m`,
    );
    const resumeCommand = command({
      type: "terminal.provider.resume",
      payload: {
        projectId: selectedResumeOption.projectId,
        conversationId: selectedResumeOption.conversationId,
        terminalId: previousId,
        ...size,
      },
    });
    void sendCommand(resumeCommand)
      .then((event) => {
        if (event.type !== "terminal.created") {
          throw new Error("The provider terminal returned an unexpected response.");
        }
        if (!event.providerResume || !event.providerResumeConversationId) {
          void sendCommand(command({
            type: "terminal.close",
            payload: { terminalId: event.terminalId },
          })).catch(() => undefined);
          throw new Error("The provider terminal omitted its authoritative session identity.");
        }
        if (!mountedRef.current || attempt !== resumeAttemptRef.current) {
          if (event.terminalId !== terminalIdRef.current) {
            void sendCommand(command({
              type: "terminal.close",
              payload: { terminalId: event.terminalId },
            })).catch(() => undefined);
          }
          return;
        }
        const terminalReplaced = event.terminalId !== previousId;
        if (
          terminalReplaced
          && !onTerminalReplacedRef.current({
            previousTerminalId: previousId,
            terminalId: event.terminalId,
            preservePrevious: !pendingExitRef.current.has(previousId),
          })
        ) {
          void sendCommand(command({
            type: "terminal.close",
            payload: { terminalId: event.terminalId },
          })).catch(() => undefined);
          throw new Error(
            "The provider could not open because the terminal tab limit was reached.",
          );
        }
        const authoritativeResume = event.providerResume;
        terminalIdRef.current = event.terminalId;
        managedActionTerminalRef.current = false;
        resumedProviderRef.current = authoritativeResume;
        setActiveResume(authoritativeResume);
        setTerminalId(event.terminalId);
        if (!terminalReplaced) {
          onRestorableTerminalChangeRef.current(event.terminalId);
        }
        const bufferedOutput = pendingOutputRef.current.get(event.terminalId);
        const earlyExitCode = pendingExitRef.current.get(event.terminalId);
        pendingOutputRef.current.clear();
        pendingExitRef.current.clear();
        operationInFlightRef.current = false;
        terminalRef.current?.clear();
        terminalRef.current?.writeln(
          `\x1b[2mResuming ${authoritativeResume.providerLabel} session ${authoritativeResume.sessionId} in ${selectedResumeOption.projectName}…\x1b[0m`,
        );
        if (bufferedOutput) terminalRef.current?.write(bufferedOutput);
        if (earlyExitCode !== undefined) {
          terminalIdRef.current = null;
          managedActionTerminalRef.current = false;
          resumedProviderRef.current = null;
          setActiveResume(null);
          setTerminalId(null);
          onRestorableTerminalChangeRef.current(null);
          terminalRef.current?.writeln(`\r\n\x1b[2mProcess exited with code ${earlyExitCode}.\x1b[0m`);
          const exit = providerTerminalExitPresentation(authoritativeResume, earlyExitCode);
          setSessionError(exit.message);
          setSessionState(exit.state);
          return;
        }
        onProviderResumeStartedRef.current(
          event.terminalId,
          event.providerResumeConversationId,
        );
        terminalReadyRef.current = true;
        setSessionState("ready");
      })
      .catch((error) => {
        const delivery = runtimeCommandDelivery(error);
        if (!mountedRef.current) return;
        if (
          delivery === "ambiguous"
          && terminalIdRef.current === previousId
        ) {
          replacementReconciliationRef.current = {
            requestId: resumeCommand.requestId,
            source: "provider",
            phase: "pending",
          };
        }
        if (attempt !== resumeAttemptRef.current) return;
        if (delivery !== "ambiguous") {
          operationInFlightRef.current = false;
        }
        const message = error instanceof Error
          ? error.message
          : `${resume.providerLabel} could not resume this session.`;
        terminalRef.current?.writeln(`\r\n\x1b[31m${message}\x1b[0m`);
        reconciliationNoticeRef.current = { message, source: "provider" };
        if (delivery !== "ambiguous") {
          replacementReconciliationRef.current = null;
        }
        if (delivery !== "ambiguous") {
          setSessionKey((value) => value + 1);
        }
      })
      .finally(() => {
        if (mountedRef.current && attempt === resumeAttemptRef.current) {
          setResumeInFlight(false);
        }
      });
    return true;
  };

  resumeProviderSessionRef.current = resumeProviderSession;

  /*
   * A resume chosen from the composer arrives as a request rather than a call,
   * because resuming needs a live terminal session that may still be starting.
   * Selection is applied first and the resume fires on the following pass, once
   * the session is ready, mirroring how queued project actions are handled.
   */
  useEffect(() => {
    if (!resumeRequestConversationId) {
      handledResumeRequestRef.current = null;
      return;
    }
    if (handledResumeRequestRef.current === resumeRequestConversationId) return;
    if (!resumeOptions.some(({ conversationId: candidateId }) =>
      candidateId === resumeRequestConversationId)) return;
    if (selectedResumeConversationId !== resumeRequestConversationId) {
      setResumeError(null);
      setSelectedResumeConversationId(resumeRequestConversationId);
      return;
    }
    if (
      selectedResumeOption?.availability.kind !== "available"
      || resumeBlockedBySibling
      || sessionState !== "ready"
      || status !== "online"
      || resumeInFlight
      || activeResume
    ) return;
    if (!resumeProviderSessionRef.current()) return;
    handledResumeRequestRef.current = resumeRequestConversationId;
    onResumeRequestHandled?.();
  }, [
    activeResume,
    onResumeRequestHandled,
    resumeBlockedBySibling,
    resumeInFlight,
    resumeOptions,
    resumeRequestConversationId,
    selectedResumeOption?.availability.kind,
    selectedResumeConversationId,
    sessionState,
    status,
  ]);

  const restartTerminal = () => {
    const attempt = resumeAttemptRef.current + 1;
    resumeAttemptRef.current = attempt;
    setResumeInFlight(false);
    const terminalId = terminalIdRef.current;
    terminalReadyRef.current = false;
    setSessionState("starting");
    if (reattachPendingRef.current) {
      reattachPendingRef.current = false;
      setSessionKey((value) => value + 1);
      return;
    }
    const restart = (): void => {
      if (!mountedRef.current || resumeAttemptRef.current !== attempt) return;
      terminalIdRef.current = null;
      managedActionTerminalRef.current = false;
      resumedProviderRef.current = null;
      setActiveResume(null);
      setTerminalId(null);
      onRestorableTerminalChangeRef.current(null);
      setSessionKey((value) => value + 1);
    };
    if (!terminalId || managedActionTerminalRef.current) {
      restart();
      return;
    }
    void sendCommand(command({
      type: "terminal.close",
      payload: { terminalId },
    })).then(restart, (error: unknown) => {
      if (!mountedRef.current || resumeAttemptRef.current !== attempt) return;
      const message = error instanceof Error
        ? error.message
        : "The terminal could not be confirmed stopped.";
      setSessionError(message);
      setSessionState("error");
    });
  };

  const fitTerminal = () => {
    try {
      fitRef.current?.fit();
      terminalRef.current?.focus();
    } catch {
      setSessionError("The terminal will fit itself when the panel settles.");
    }
  };

  return (
    <aside
      className="terminal-panel"
      aria-label="Terminal panel"
      aria-busy={sessionState === "starting"}
      data-terminal-id={terminalId ?? undefined}
      data-terminal-state={sessionState}
      data-terminal-font-size={fontSize}
    >
      <div className="terminal-header">
        <div className="terminal-title">
          <TerminalSquare size={16} />
          <span>Terminal</span>
          <span className="terminal-project">{projectName}</span>
        </div>
        <div className="terminal-actions">
          <IconButton label="Fit terminal" onClick={fitTerminal}><Maximize2 size={15} /></IconButton>
          <IconButton label="Restart terminal" onClick={restartTerminal} disabled={status !== "online" || resumeInFlight}>
            <RotateCcw size={15} />
          </IconButton>
          <IconButton label="Close terminal" onClick={onClose}><X size={16} /></IconButton>
        </div>
      </div>
      {selectedResumeOption && (
        <Suspense fallback={(
          <div className="terminal-resume-status" role="status">
            Loading provider resume controls…
          </div>
        )}>
          <TerminalResumeStatus
            selectedResumeOption={selectedResumeOption}
            resumeOptions={resumeOptions}
            activeResume={activeResume}
            siblingResumedConversationIds={siblingResumedConversationIds}
            resumeBlockedBySibling={resumeBlockedBySibling}
            resumeInFlight={resumeInFlight}
            sessionState={sessionState}
            status={status}
            projectName={projectName}
            resumeError={resumeError}
            onSelect={(conversationId) => {
              setResumeError(null);
              setSelectedResumeConversationId(conversationId);
            }}
            onResume={resumeProviderSession}
          />
        </Suspense>
      )}
      <div className="terminal-stage">
        <div className="terminal-mount" ref={containerRef} />
        {sessionState !== "ready" && (
          <div className="terminal-overlay" role="status">
            {sessionState === "starting" ? (
              <><LoadingMark label="Starting terminal" /><span>Starting terminal…</span></>
            ) : (
              <>
                <TerminalSquare size={19} />
                <span>{status !== "online" ? "Terminal will return when the local service reconnects." : sessionError ?? "Terminal session ended."}</span>
                {status === "online" && (
                  <button type="button" className="secondary-button" onClick={restartTerminal}>Start again</button>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
