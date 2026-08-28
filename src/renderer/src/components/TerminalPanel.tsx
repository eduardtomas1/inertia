import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Columns2, Maximize2, Plus, RotateCcw, TerminalSquare, X } from "lucide-react";
import type {
  ClientCommand,
  ColorThemeId,
  ProviderTerminalResumeAvailability,
  ProviderTerminalResumeDescriptor,
  ServerEvent,
  ThemePreference,
} from "@shared/contracts";
import type { ConnectionStatus } from "../hooks/useInertiaConnection";
import { usePersistedSize } from "../hooks/usePersistedSize";
import { runtimeCommandDelivery } from "../utils/connectionMessages";
import { terminalInputChunks } from "../utils/terminalInputChunks";
import { PaneResizeHandle } from "./PaneResizeHandle";
import type { ProviderTerminalResumeOption } from "./providerResumeOptions";
import {
  command,
  MAX_PERSISTED_TERMINAL_TABS,
  newTerminalTab,
  nextTerminalTabIndex,
  readPersistedTerminalTabs,
  TERMINAL_CREATE_RETRY_DELAYS_MS,
  TERMINAL_SETTLING_RETRY_DELAYS_MS,
  terminalStorageKey,
  terminalTheme,
  TerminalResumeStatus,
  type TerminalTab,
  waitForTerminalRetry,
} from "./TerminalPanelSupport";
import { IconButton, LoadingMark } from "./ui";

type TerminalPanelProps = {
  projectId: string;
  conversationId?: string;
  projectName: string;
  status: ConnectionStatus;
  fontSize: number;
  theme: ThemePreference;
  colorTheme?: ColorThemeId;
  sendCommand: (command: ClientCommand) => Promise<ServerEvent>;
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
  actionId?: string | null;
  onActionStarted?: () => void;
  providerResume?: ProviderTerminalResumeAvailability | null;
  providerResumes?: readonly ProviderTerminalResumeOption[];
  resumeRequestConversationId?: string | null;
  onResumeRequestHandled?: () => void;
  onClose: () => void;
  visible?: boolean;
};

type TerminalSessionProps = TerminalPanelProps & {
  initialTerminalId: string | null;
  siblingResumedConversationIds: ReadonlySet<string>;
  onRestorableTerminalChange: (terminalId: string | null) => void;
  onProviderResumeStarted: (terminalId: string, conversationId: string) => void;
};
const MAX_PENDING_TERMINAL_OUTPUT = 256 * 1_024 + 256;

function TerminalSession({
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
  const onProviderResumeStartedRef = useRef(onProviderResumeStarted);
  onRestorableTerminalChangeRef.current = onRestorableTerminalChange;
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
        event.terminalId === terminalIdRef.current
        || pendingOutputRef.current.has(event.terminalId)
      ) {
        pendingExitRef.current.set(event.terminalId, event.exitCode);
        return;
      }
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
      if (resumedProvider && event.exitCode !== 0) {
        setSessionError(
          `${resumedProvider.providerLabel} could not resume session ${resumedProvider.sessionId}. The saved session may be stale or unavailable; review the provider output above.`,
        );
        setSessionState("error");
      } else {
        setSessionError(resumedProvider
          ? `${resumedProvider.providerLabel} session ${resumedProvider.sessionId} ended.`
          : null);
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
    ): void => {
      terminalIdRef.current = event.terminalId;
      reattachPendingRef.current = false;
      managedActionTerminalRef.current = false;
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
      for (let attempt = 0; ; attempt += 1) {
        try {
          if (reattachId) {
            terminal?.clear();
            pendingOutput.delete(reattachId);
          }
          const event = await sendCommand(command(reattachId
              ? {
                  type: "terminal.attach" as const,
                  payload: { projectId, conversationId, terminalId: reattachId, ...size },
                }
              : {
                  type: "terminal.create" as const,
                  payload: { projectId, conversationId, ...size },
                }));
          if (
            event.type !== "terminal.created"
            || (reattachId && event.terminalId !== reattachId)
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
          if (!reattachId) terminal?.clear();
          finishTerminal(event);
          return;
        } catch (terminalError) {
          if (cancelled) return;
          const delivery = runtimeCommandDelivery(terminalError);
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
    void sendCommand(command({
      type: "project.action.run",
      payload: {
        projectId,
        conversationId,
        actionId,
        terminalId: previousId,
        ...size,
      },
    }))
      .then((event) => {
        if (event.type !== "terminal.created" || event.terminalId !== previousId) {
          throw new Error("The action terminal returned an unexpected response.");
        }
        if (!ownsResponse()) {
          if (actionInFlightRef.current === actionIdentity) {
            actionInFlightRef.current = null;
          }
          pendingOutputRef.current.delete(event.terminalId);
          pendingExitRef.current.delete(event.terminalId);
          operationInFlightRef.current = false;
          return;
        }
        terminalIdRef.current = event.terminalId;
        managedActionTerminalRef.current = true;
        resumedProviderRef.current = null;
        setActiveResume(null);
        setTerminalId(event.terminalId);
        onRestorableTerminalChangeRef.current(null);
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
        operationInFlightRef.current = false;
        onActionStarted?.();
        setSessionKey((value) => value + 1);
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
    void sendCommand(command({
      type: "terminal.provider.resume",
      payload: {
        projectId: selectedResumeOption.projectId,
        conversationId: selectedResumeOption.conversationId,
        terminalId: previousId,
        ...size,
      },
    }))
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
        const authoritativeResume = event.providerResume;
        terminalIdRef.current = event.terminalId;
        managedActionTerminalRef.current = false;
        resumedProviderRef.current = authoritativeResume;
        onProviderResumeStartedRef.current(
          event.terminalId,
          event.providerResumeConversationId,
        );
        setActiveResume(authoritativeResume);
        setTerminalId(event.terminalId);
        onRestorableTerminalChangeRef.current(event.terminalId);
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
          setSessionState("closed");
          return;
        }
        terminalReadyRef.current = true;
        setSessionState("ready");
      })
      .catch((error) => {
        if (!mountedRef.current || attempt !== resumeAttemptRef.current) return;
        operationInFlightRef.current = false;
        const message = error instanceof Error
          ? error.message
          : `${resume.providerLabel} could not resume this session.`;
        terminalRef.current?.writeln(`\r\n\x1b[31m${message}\x1b[0m`);
        reconciliationNoticeRef.current = { message, source: "provider" };
        setSessionKey((value) => value + 1);
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

function ScopedTerminalPanel(props: TerminalPanelProps): React.JSX.Element {
  const subscribe = props.subscribe;
  const sendCommand = props.sendCommand;
  const resumeRequestConversationId = props.resumeRequestConversationId;
  const onResumeRequestHandled = props.onResumeRequestHandled;
  const actionRequestId = props.actionId;
  const onActionRequestHandled = props.onActionStarted;
  const actionScopeIdentity = `${props.projectId}:${props.conversationId ?? ""}`;
  const storageKey = terminalStorageKey(props.projectId, props.conversationId);
  const [initialTabs] = useState(() => readPersistedTerminalTabs(storageKey));
  const [tabs, setTabs] = useState<TerminalTab[]>(initialTabs);
  const [activeId, setActiveId] = useState(initialTabs[0].id);
  const [split, setSplit] = useState(false);
  const [persistedSplitPercent, setPersistedSplitPercent] = usePersistedSize("inertia:layout:terminal-split-percent:v1", 50, { min: 25, max: 75 });
  const [splitPercent, setSplitPercent] = useState(persistedSplitPercent);
  const [splitOrientation, setSplitOrientation] = useState<"horizontal" | "vertical">("vertical");
  const [resumedTerminals, setResumedTerminals] = useState<ReadonlyMap<string, {
    tabId: string;
    terminalId: string;
  }>>(() => new Map());
  const [closingTabIds, setClosingTabIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [actionRoutingError, setActionRoutingError] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef(tabs);
  const pageUnloadingRef = useRef(false);
  const lifecycleGenerationRef = useRef(0);
  const handledPanelResumeRequestRef = useRef<string | null>(null);
  const handledBlockedActionRef = useRef<string | null>(null);
  tabsRef.current = tabs;

  useEffect(() => {
    try {
      if (tabs.length === 0) {
        window.sessionStorage.removeItem(storageKey);
        return;
      }
      window.sessionStorage.setItem(
        storageKey,
        JSON.stringify(tabs.map(({ terminalId }) => terminalId)),
      );
    } catch {
      // Session restoration is a convenience; terminal ownership stays server-side.
    }
  }, [storageKey, tabs]);

  useEffect(() => {
    const generation = lifecycleGenerationRef.current + 1;
    lifecycleGenerationRef.current = generation;
    pageUnloadingRef.current = false;
    const markPageUnloading = (): void => {
      pageUnloadingRef.current = true;
    };
    window.addEventListener("beforeunload", markPageUnloading);
    window.addEventListener("pagehide", markPageUnloading);
    return () => {
      window.removeEventListener("beforeunload", markPageUnloading);
      window.removeEventListener("pagehide", markPageUnloading);
      window.queueMicrotask(() => {
        if (
          lifecycleGenerationRef.current !== generation
          || pageUnloadingRef.current
        ) return;
        for (const { terminalId } of tabsRef.current) {
          if (!terminalId) continue;
          void sendCommand(command({
            type: "terminal.close",
            payload: { terminalId },
          })).catch(() => undefined);
        }
        try {
          window.sessionStorage.removeItem(storageKey);
        } catch {
          // The scoped sessions are still closed authoritatively above.
        }
      });
    };
  }, [sendCommand, storageKey]);

  useEffect(() => setSplitPercent(persistedSplitPercent), [persistedSplitPercent]);

  useEffect(() => setResumedTerminals(new Map()), [
    props.conversationId,
    props.projectId,
  ]);

  useEffect(() => {
    if (props.status !== "online") setResumedTerminals(new Map());
  }, [props.status]);

  useEffect(() => subscribe((event) => {
    if (event.type !== "terminal.exit") return;
    setResumedTerminals((current) => {
      const next = new Map(current);
      for (const [conversationId, resumed] of next) {
        if (resumed.terminalId === event.terminalId) {
          next.delete(conversationId);
        }
      }
      return next.size === current.size ? current : next;
    });
  }), [subscribe]);

  const resumedTabIds = useMemo(() => new Set(
    [...resumedTerminals.values()].map(({ tabId }) => tabId),
  ), [resumedTerminals]);
  const actionTargetId = useMemo<string | null>(() => {
    if (!props.actionId) return activeId;
    if (!resumedTabIds.has(activeId)) return activeId;
    return tabs.find(({ id }) => !resumedTabIds.has(id))?.id ?? null;
  }, [activeId, props.actionId, resumedTabIds, tabs]);

  useEffect(() => {
    const actionId = actionRequestId;
    if (!actionId) {
      handledBlockedActionRef.current = null;
      return;
    }
    if (actionTargetId) {
      setActionRoutingError(null);
      if (actionTargetId !== activeId) setActiveId(actionTargetId);
      return;
    }
    if (tabs.length < MAX_PERSISTED_TERMINAL_TABS) {
      setTabs((current) => {
        if (current.length >= MAX_PERSISTED_TERMINAL_TABS) return current;
        const tab = newTerminalTab(nextTerminalTabIndex(current));
        window.queueMicrotask(() => setActiveId(tab.id));
        return [...current, tab];
      });
      return;
    }
    const identity = `${actionScopeIdentity}:${actionId}`;
    setActionRoutingError(
      "End a resumed provider terminal before starting this project action.",
    );
    if (handledBlockedActionRef.current !== identity) {
      handledBlockedActionRef.current = identity;
      onActionRequestHandled?.();
    }
  }, [
    actionTargetId,
    activeId,
    actionRequestId,
    actionScopeIdentity,
    onActionRequestHandled,
    tabs.length,
  ]);

  useEffect(() => {
    if (!props.visible || tabs.length > 0) return;
    const tab = newTerminalTab();
    setTabs([tab]);
    setActiveId(tab.id);
  }, [props.visible, tabs.length]);

  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSplitOrientation(width < 430 && height >= 280 ? "horizontal" : "vertical");
    });
    observer.observe(grid);
    return () => observer.disconnect();
  }, []);

  const addTerminal = (): void => {
    setTabs((current) => {
      if (current.length >= MAX_PERSISTED_TERMINAL_TABS) return current;
      const tab = newTerminalTab(nextTerminalTabIndex(current));
      window.queueMicrotask(() => setActiveId(tab.id));
      return [...current, tab];
    });
  };

  useEffect(() => {
    const requestedConversationId = resumeRequestConversationId;
    if (!requestedConversationId) {
      handledPanelResumeRequestRef.current = null;
      return;
    }
    if (handledPanelResumeRequestRef.current === requestedConversationId) return;
    const existing = resumedTerminals.get(requestedConversationId);
    if (existing && tabs.some(({ id }) => id === existing.tabId)) {
      handledPanelResumeRequestRef.current = requestedConversationId;
      setActiveId(existing.tabId);
      onResumeRequestHandled?.();
      return;
    }
    const activeTabAlreadyResumed = [...resumedTerminals.values()].some(
      ({ tabId }) => tabId === activeId,
    );
    if (!activeTabAlreadyResumed) return;
    const idleTab = tabs.find(({ id }) => ![...resumedTerminals.values()].some(
      ({ tabId }) => tabId === id,
    ));
    if (idleTab) {
      setActiveId(idleTab.id);
      return;
    }
    if (tabs.length >= MAX_PERSISTED_TERMINAL_TABS) return;

    // A resumed provider owns its terminal until that process exits. Preserve
    // it and give the explicit composer request a fresh terminal to start in.
    setTabs((current) => {
      if (current.length >= MAX_PERSISTED_TERMINAL_TABS) return current;
      const tab = newTerminalTab(nextTerminalTabIndex(current));
      window.queueMicrotask(() => setActiveId(tab.id));
      return [...current, tab];
    });
  }, [
    activeId,
    onResumeRequestHandled,
    resumeRequestConversationId,
    resumedTerminals,
    tabs,
  ]);

  const closeTerminal = (id: string): void => {
    if (closingTabIds.has(id)) return;
    const closing = tabsRef.current.find((tab) => tab.id === id);
    if (!closing) return;
    const finish = (): void => {
      const current = tabsRef.current;
      const next = current.filter((tab) => tab.id !== id);
      if (next.length === current.length) return;
      setClosingTabIds((closingIds) => {
        const updated = new Set(closingIds);
        updated.delete(id);
        return updated;
      });
      setTabs(next);
      setActiveId((selected) => selected === id
        ? (next.at(-1)?.id ?? "")
        : selected);
      if (next.length === 0) {
        setSplit(false);
        props.onClose();
      } else if (next.length < 2) {
        setSplit(false);
      }
    };
    if (!closing.terminalId) {
      finish();
      return;
    }
    setClosingTabIds((closingIds) => new Set(closingIds).add(id));
    void sendCommand(command({
      type: "terminal.close",
      payload: { terminalId: closing.terminalId },
    })).then(finish, () => {
      setClosingTabIds((closingIds) => {
        const updated = new Set(closingIds);
        updated.delete(id);
        return updated;
      });
    });
  };

  const splitTerminal = () => {
    if (tabs.length < 2) addTerminal();
    setSplit((current) => !current);
  };

  const secondaryId = tabs.find((tab) => tab.id !== activeId)?.id ?? null;
  const sessionIds = useMemo(() => new Map(tabs.map((tab) => [tab.id, `terminal-session-${tab.id}`])), [tabs]);
  const gridStyle = { "--terminal-split-percent": `${splitPercent}%` } as CSSProperties;

  return (
    <aside className="terminal-tabs-panel" aria-label="Terminal panel" hidden={!props.visible}>
      <header className="terminal-tabbar">
        <div className="terminal-tablist" role="tablist" aria-label="Terminals">
          {tabs.map((tab) => <div className={tab.id === activeId ? "terminal-tab is-active" : "terminal-tab"} key={tab.id}><button type="button" id={`terminal-tab-${tab.id}`} role="tab" aria-selected={tab.id === activeId} aria-controls={sessionIds.get(tab.id)} onClick={() => setActiveId(tab.id)}><TerminalSquare size={13} /><span>{tab.label}</span></button><button type="button" aria-label={`Close ${tab.label}`} disabled={closingTabIds.has(tab.id)} onClick={() => closeTerminal(tab.id)}><X size={11} /></button></div>)}
        </div>
        <div className="terminal-tab-actions"><IconButton label={tabs.length >= MAX_PERSISTED_TERMINAL_TABS ? "Maximum of 4 terminals open" : "New terminal"} disabled={tabs.length >= MAX_PERSISTED_TERMINAL_TABS} onClick={() => addTerminal()}><Plus size={14} /></IconButton><IconButton label="Split terminals" aria-pressed={split} onClick={splitTerminal}><Columns2 size={14} /></IconButton></div>
      </header>
      {actionRoutingError && (
        <div className="terminal-resume-status is-unavailable" role="alert">
          {actionRoutingError}
        </div>
      )}
      <div
        ref={gridRef}
        className={split ? `terminal-session-grid is-split is-${splitOrientation}` : "terminal-session-grid"}
        style={gridStyle}
      >
        {tabs.map((tab) => {
          const visible = tab.id === activeId || (split && tab.id === secondaryId);
          const placement = tab.id === activeId ? "is-primary" : tab.id === secondaryId ? "is-secondary" : "";
          const siblingResumedConversationIds = new Set(
            [...resumedTerminals]
              .filter(([, resumed]) => resumed.tabId !== tab.id)
              .map(([conversationId]) => conversationId),
          );
          return <div id={sessionIds.get(tab.id)} role="tabpanel" aria-labelledby={`terminal-tab-${tab.id}`} className={`terminal-session-slot ${placement}`} hidden={!visible} key={tab.id}><TerminalSession {...props} initialTerminalId={tab.terminalId} visible={Boolean(props.visible && visible)} actionId={tab.id === actionTargetId ? props.actionId : null} onActionStarted={tab.id === actionTargetId ? props.onActionStarted : undefined} resumeRequestConversationId={tab.id === activeId ? props.resumeRequestConversationId : null} onResumeRequestHandled={tab.id === activeId ? props.onResumeRequestHandled : undefined} siblingResumedConversationIds={siblingResumedConversationIds} onRestorableTerminalChange={(terminalId) => setTabs((current) => {
            let changed = false;
            const next = current.map((candidate) => {
              if (candidate.id !== tab.id || candidate.terminalId === terminalId) return candidate;
              changed = true;
              return { ...candidate, terminalId };
            });
            return changed ? next : current;
          })} onProviderResumeStarted={(terminalId, resumedConversationId) => setResumedTerminals((current) => new Map(current).set(resumedConversationId, { tabId: tab.id, terminalId }))} onClose={() => closeTerminal(tab.id)} /></div>;
        })}
        {split && secondaryId && (
          <PaneResizeHandle
            label="Resize split terminals"
            controls={`${sessionIds.get(activeId)} ${sessionIds.get(secondaryId)}`}
            containerRef={gridRef}
            orientation={splitOrientation}
            unit="percent"
            value={splitPercent}
            min={25}
            max={75}
            defaultValue={50}
            onChange={setSplitPercent}
            onCommit={setPersistedSplitPercent}
            valueText={(value) => `${value}% for the active terminal`}
            className="terminal-split-handle"
          />
        )}
      </div>
    </aside>
  );
}

export function TerminalPanel(props: TerminalPanelProps): React.JSX.Element {
  const scope = `${props.projectId}:${props.conversationId ?? "project"}`;
  return <ScopedTerminalPanel key={scope} {...props} />;
}
