import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { Columns2, Maximize2, Plus, RotateCcw, TerminalSquare, X } from "lucide-react";
import type { ClientCommand, ServerEvent, ThemePreference } from "@shared/contracts";
import type { ConnectionStatus } from "../hooks/useInertiaConnection";
import { usePersistedSize } from "../hooks/usePersistedSize";
import { PaneResizeHandle } from "./PaneResizeHandle";
import { IconButton, LoadingMark } from "./ui";

type TerminalPanelProps = {
  projectId: string;
  conversationId?: string;
  projectName: string;
  status: ConnectionStatus;
  fontSize: number;
  theme: ThemePreference;
  sendCommand: (command: ClientCommand) => Promise<ServerEvent>;
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
  actionId?: string | null;
  onActionStarted?: () => void;
  onClose: () => void;
  visible?: boolean;
};

type CommandWithoutId = ClientCommand extends infer Command
  ? Command extends { requestId: string }
    ? Omit<Command, "requestId">
    : never
  : never;

const command = (value: CommandWithoutId): ClientCommand => ({
  ...value,
  requestId: crypto.randomUUID(),
}) as ClientCommand;

function terminalTheme(_theme: ThemePreference): { background: string; foreground: string; cursor: string; selectionBackground: string } {
  const styles = window.getComputedStyle(document.documentElement);
  return {
    background: styles.getPropertyValue("--terminal-bg").trim(),
    foreground: styles.getPropertyValue("--terminal-fg").trim(),
    cursor: styles.getPropertyValue("--accent").trim(),
    selectionBackground: styles.getPropertyValue("--terminal-selection").trim(),
  };
}

function TerminalSession({
  projectId,
  conversationId,
  projectName,
  status,
  fontSize,
  theme,
  sendCommand,
  subscribe,
  actionId,
  onActionStarted,
  onClose,
  visible = true,
}: TerminalPanelProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const terminalIdRef = useRef<string | null>(null);
  const actionInFlightRef = useRef<string | null>(null);
  const pendingOutputRef = useRef(new Map<string, string>());
  const lastSizeRef = useRef({ cols: 0, rows: 0 });
  const [instanceReady, setInstanceReady] = useState(false);
  const [sessionKey, setSessionKey] = useState(0);
  const [sessionState, setSessionState] = useState<"starting" | "ready" | "closed" | "error">("starting");
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [terminalId, setTerminalId] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: true,
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      fontSize,
      lineHeight: 1.35,
      scrollback: 4_000,
      theme: terminalTheme(theme),
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    terminalRef.current = terminal;
    fitRef.current = fitAddon;
    fitAddon.fit();
    terminal.focus();
    setInstanceReady(true);

    const inputDisposable = terminal.onData((data) => {
      const terminalId = terminalIdRef.current;
      if (!terminalId) return;
      for (let offset = 0; offset < data.length; offset += 8192) {
        const chunk = data.slice(offset, offset + 8192);
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
          if (terminalId) {
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
  }, [fontSize, theme]);

  useEffect(() => {
    if (!visible) return;
    let secondFrame: number | undefined;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        try {
          fitRef.current?.fit();
          const terminal = terminalRef.current;
          const terminalId = terminalIdRef.current;
          if (!terminal || !terminalId) return;
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
      if (event.terminalId === terminalIdRef.current) {
        terminalRef.current?.write(event.data);
      } else {
        const buffered = pendingOutputRef.current.get(event.terminalId) ?? "";
        pendingOutputRef.current.set(event.terminalId, `${buffered}${event.data}`.slice(-65_536));
      }
    }
    if (event.type === "terminal.exit" && event.terminalId === terminalIdRef.current) {
      terminalRef.current?.writeln(`\r\n\x1b[2mProcess exited with code ${event.exitCode}.\x1b[0m`);
      terminalIdRef.current = null;
      setTerminalId(null);
      setSessionState("closed");
    }
  }), [subscribe]);

  useEffect(() => {
    if (!instanceReady || status !== "online") {
      terminalIdRef.current = null;
      setTerminalId(null);
      if (status === "offline") setSessionState("error");
      return;
    }

    let cancelled = false;
    const terminal = terminalRef.current;
    const fitAddon = fitRef.current;
    setSessionState("starting");
    setSessionError(null);
    pendingOutputRef.current.clear();
    terminal?.clear();
    terminal?.writeln(`\x1b[2mStarting a local terminal for ${projectName}…\x1b[0m`);

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

    void sendCommand(command({ type: "terminal.create", payload: { projectId, conversationId, ...size } }))
      .then((event) => {
        if (event.type !== "terminal.created") throw new Error("The terminal service returned an unexpected response.");
        if (cancelled) {
          void sendCommand(command({ type: "terminal.close", payload: { terminalId: event.terminalId } })).catch(() => undefined);
          return;
        }
        terminalIdRef.current = event.terminalId;
        setTerminalId(event.terminalId);
        const bufferedOutput = pendingOutputRef.current.get(event.terminalId);
        pendingOutputRef.current.clear();
        setSessionState("ready");
        terminal?.clear();
        if (bufferedOutput) terminal?.write(bufferedOutput);
        terminal?.focus();
      })
      .catch((terminalError) => {
        if (cancelled) return;
        setSessionState("error");
        setSessionError(terminalError instanceof Error ? terminalError.message : "The terminal could not be started.");
      });

    return () => {
      cancelled = true;
      const terminalId = terminalIdRef.current;
      terminalIdRef.current = null;
      setTerminalId(null);
      pendingOutputRef.current.clear();
      if (terminalId) {
        void sendCommand(command({ type: "terminal.close", payload: { terminalId } })).catch(() => undefined);
      }
    };
  }, [conversationId, instanceReady, projectId, projectName, sendCommand, sessionKey, status]);

  useEffect(() => {
    if (!actionId || actionInFlightRef.current === actionId || sessionState !== "ready" || status !== "online") return;
    actionInFlightRef.current = actionId;
    const size = {
      cols: Math.max(20, terminalRef.current?.cols ?? lastSizeRef.current.cols ?? 80),
      rows: Math.max(4, terminalRef.current?.rows ?? lastSizeRef.current.rows ?? 24),
    };
    setSessionState("starting");
    terminalRef.current?.clear();
    terminalRef.current?.writeln(`\x1b[2mStarting ${actionId}…\x1b[0m`);
    void sendCommand(command({ type: "project.action.run", payload: { projectId, conversationId, actionId, ...size } }))
      .then((event) => {
        if (event.type !== "terminal.created") throw new Error("The action terminal returned an unexpected response.");
        const previousId = terminalIdRef.current;
        terminalIdRef.current = event.terminalId;
        setTerminalId(event.terminalId);
        if (previousId) void sendCommand(command({ type: "terminal.close", payload: { terminalId: previousId } })).catch(() => undefined);
        const bufferedOutput = pendingOutputRef.current.get(event.terminalId);
        pendingOutputRef.current.clear();
        terminalRef.current?.clear();
        if (bufferedOutput) terminalRef.current?.write(bufferedOutput);
        setSessionState("ready");
        actionInFlightRef.current = null;
        onActionStarted?.();
      })
      .catch((error) => {
        setSessionError(error instanceof Error ? error.message : "The project action could not be started.");
        setSessionState("error");
        actionInFlightRef.current = null;
        onActionStarted?.();
      });
  }, [actionId, conversationId, onActionStarted, projectId, sendCommand, sessionState, status]);

  const fitTerminal = () => {
    try {
      fitRef.current?.fit();
      terminalRef.current?.focus();
    } catch {
      setSessionError("The terminal will fit itself when the panel settles.");
    }
  };

  return (
    <aside className="terminal-panel" aria-label="Terminal panel" data-terminal-id={terminalId ?? undefined}>
      <div className="terminal-header">
        <div className="terminal-title">
          <TerminalSquare size={16} />
          <span>Terminal</span>
          <span className="terminal-project">{projectName}</span>
        </div>
        <div className="terminal-actions">
          <IconButton label="Fit terminal" onClick={fitTerminal}><Maximize2 size={15} /></IconButton>
          <IconButton label="Restart terminal" onClick={() => setSessionKey((value) => value + 1)} disabled={status !== "online"}>
            <RotateCcw size={15} />
          </IconButton>
          <IconButton label="Close terminal" onClick={onClose}><X size={16} /></IconButton>
        </div>
      </div>
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
                  <button type="button" className="secondary-button" onClick={() => setSessionKey((value) => value + 1)}>Start again</button>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}

type TerminalTab = { id: string; label: string };

export function TerminalPanel(props: TerminalPanelProps): React.JSX.Element {
  const [tabs, setTabs] = useState<TerminalTab[]>([{ id: crypto.randomUUID(), label: "Terminal 1" }]);
  const [activeId, setActiveId] = useState(() => tabs[0].id);
  const [split, setSplit] = useState(false);
  const [persistedSplitPercent, setPersistedSplitPercent] = usePersistedSize("inertia:layout:terminal-split-percent:v1", 50, { min: 25, max: 75 });
  const [splitPercent, setSplitPercent] = useState(persistedSplitPercent);
  const [splitOrientation, setSplitOrientation] = useState<"horizontal" | "vertical">("vertical");
  const gridRef = useRef<HTMLDivElement>(null);

  useEffect(() => setSplitPercent(persistedSplitPercent), [persistedSplitPercent]);

  useEffect(() => {
    if (!props.visible || tabs.length > 0) return;
    const id = crypto.randomUUID();
    setTabs([{ id, label: "Terminal 1" }]);
    setActiveId(id);
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

  const addTerminal = (): string => {
    const id = crypto.randomUUID();
    setTabs((current) => [...current, { id, label: `Terminal ${current.length + 1}` }]);
    setActiveId(id);
    return id;
  };

  const closeTerminal = (id: string) => {
    setTabs((current) => {
      const next = current.filter((tab) => tab.id !== id);
      if (next.length === 0) {
        setActiveId("");
        setSplit(false);
        props.onClose();
        return next;
      }
      if (activeId === id) setActiveId(next.at(-1)?.id ?? next[0].id);
      if (next.length < 2) setSplit(false);
      return next;
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
          {tabs.map((tab) => <div role="tab" aria-selected={tab.id === activeId} className={tab.id === activeId ? "terminal-tab is-active" : "terminal-tab"} key={tab.id}><button type="button" onClick={() => setActiveId(tab.id)}><TerminalSquare size={13} /><span>{tab.label}</span></button><button type="button" aria-label={`Close ${tab.label}`} onClick={() => closeTerminal(tab.id)}><X size={11} /></button></div>)}
        </div>
        <div className="terminal-tab-actions"><IconButton label="New terminal" onClick={() => addTerminal()}><Plus size={14} /></IconButton><IconButton label="Split terminals" aria-pressed={split} onClick={splitTerminal}><Columns2 size={14} /></IconButton></div>
      </header>
      <div
        ref={gridRef}
        className={split ? `terminal-session-grid is-split is-${splitOrientation}` : "terminal-session-grid"}
        style={gridStyle}
      >
        {tabs.map((tab) => {
          const visible = tab.id === activeId || (split && tab.id === secondaryId);
          const placement = tab.id === activeId ? "is-primary" : tab.id === secondaryId ? "is-secondary" : "";
          return <div id={sessionIds.get(tab.id)} className={`terminal-session-slot ${placement}`} hidden={!visible} key={tab.id}><TerminalSession {...props} visible={Boolean(props.visible && visible)} actionId={tab.id === activeId ? props.actionId : null} onActionStarted={tab.id === activeId ? props.onActionStarted : undefined} onClose={() => closeTerminal(tab.id)} /></div>;
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
