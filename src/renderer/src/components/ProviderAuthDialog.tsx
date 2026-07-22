import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { CheckCircle2, PlugZap, X } from "lucide-react";
import type { ClientCommand, ProviderInfo, ServerEvent, ThemePreference } from "@shared/contracts";
import type { ConnectionStatus } from "../hooks/useInertiaConnection";
import { IconButton, LoadingMark } from "./ui";

type ProviderAuthDialogProps = {
  provider: ProviderInfo | null;
  status: ConnectionStatus;
  theme: ThemePreference;
  fontSize: number;
  sendCommand: (command: ClientCommand) => Promise<ServerEvent>;
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
  onClose: () => void;
};

type CommandWithoutId = ClientCommand extends infer Command
  ? Command extends { requestId: string }
    ? Omit<Command, "requestId">
    : never
  : never;

function command(value: CommandWithoutId): ClientCommand {
  return { ...value, requestId: crypto.randomUUID() } as ClientCommand;
}

function terminalTheme(): { background: string; foreground: string; cursor: string; selectionBackground: string } {
  const styles = window.getComputedStyle(document.documentElement);
  return {
    background: styles.getPropertyValue("--terminal-bg").trim(),
    foreground: styles.getPropertyValue("--terminal-fg").trim(),
    cursor: styles.getPropertyValue("--accent").trim(),
    selectionBackground: styles.getPropertyValue("--terminal-selection").trim(),
  };
}

export function ProviderAuthDialog({
  provider,
  status,
  theme,
  fontSize,
  sendCommand,
  subscribe,
  onClose,
}: ProviderAuthDialogProps): React.JSX.Element | null {
  const dialogRef = useRef<HTMLElement>(null);
  const mountRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const terminalIdRef = useRef<string | null>(null);
  const pendingOutputRef = useRef(new Map<string, string>());
  const [instanceReady, setInstanceReady] = useState(false);
  const [sessionState, setSessionState] = useState<"starting" | "ready" | "finished" | "error">("starting");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!provider) return;
    const mount = mountRef.current;
    if (!mount) return;
    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: true,
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      fontSize,
      lineHeight: 1.35,
      scrollback: 2_000,
      theme: terminalTheme(),
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(mount);
    fit.fit();
    terminalRef.current = terminal;
    fitRef.current = fit;
    setInstanceReady(true);

    const input = terminal.onData((data) => {
      const terminalId = terminalIdRef.current;
      if (!terminalId) return;
      for (let offset = 0; offset < data.length; offset += 8192) {
        void sendCommand(command({ type: "terminal.input", payload: { terminalId, data: data.slice(offset, offset + 8192) } })).catch(() => undefined);
      }
    });
    let frame: number | undefined;
    const observer = new ResizeObserver(() => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        try {
          fit.fit();
          const terminalId = terminalIdRef.current;
          if (terminalId) {
            void sendCommand(command({
              type: "terminal.resize",
              payload: { terminalId, cols: Math.max(40, terminal.cols), rows: Math.max(10, terminal.rows) },
            })).catch(() => undefined);
          }
        } catch { /* The next resize will retry after the dialog settles. */ }
      });
    });
    observer.observe(mount);
    return () => {
      observer.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
      input.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      setInstanceReady(false);
      terminal.dispose();
    };
  }, [provider?.id, sendCommand]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const media = matchMedia("(prefers-color-scheme: dark)");
    const update = () => {
      terminal.options.fontSize = fontSize;
      terminal.options.theme = terminalTheme();
      try { fitRef.current?.fit(); } catch { /* ResizeObserver retries. */ }
    };
    update();
    if (theme === "system") media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [fontSize, theme]);

  useEffect(() => {
    if (!provider) {
      pendingOutputRef.current.clear();
      return;
    }
    return subscribe((event) => {
    if (event.type === "terminal.output") {
      if (event.terminalId === terminalIdRef.current) terminalRef.current?.write(event.data);
      else pendingOutputRef.current.set(event.terminalId, `${pendingOutputRef.current.get(event.terminalId) ?? ""}${event.data}`.slice(-65_536));
    }
    if (event.type === "terminal.exit" && event.terminalId === terminalIdRef.current) {
      terminalIdRef.current = null;
      terminalRef.current?.writeln("\r\n\x1b[2mConnection flow finished. You can close this window.\x1b[0m");
      setSessionState(event.exitCode === 0 ? "finished" : "error");
      if (event.exitCode !== 0) setError("The provider ended the connection flow before it completed.");
    }
    });
  }, [provider?.id, subscribe]);

  useEffect(() => {
    if (!provider) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    requestAnimationFrame(() => dialog?.querySelector<HTMLElement>("button")?.focus());
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])')];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable.at(-1) as HTMLElement;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      pendingOutputRef.current.clear();
      previous?.focus();
    };
  }, [onClose, provider?.id]);

  useEffect(() => {
    if (!provider || !instanceReady || status !== "online") return;
    let cancelled = false;
    const terminal = terminalRef.current;
    try { fitRef.current?.fit(); } catch { /* Safe defaults below. */ }
    const size = { cols: Math.max(40, terminal?.cols ?? 90), rows: Math.max(10, terminal?.rows ?? 24) };
    setSessionState("starting");
    setError(null);
    pendingOutputRef.current.clear();
    terminal?.clear();
    terminal?.writeln(`\x1b[2mOpening ${provider.label} sign-in…\x1b[0m`);
    void sendCommand(command({ type: "provider.auth.start", payload: { providerId: provider.id, ...size } }))
      .then((event) => {
        if (event.type !== "terminal.created") throw new Error("The connection service returned an unexpected response.");
        if (cancelled) {
          void sendCommand(command({ type: "terminal.close", payload: { terminalId: event.terminalId } })).catch(() => undefined);
          return;
        }
        terminalIdRef.current = event.terminalId;
        const buffered = pendingOutputRef.current.get(event.terminalId);
        pendingOutputRef.current.clear();
        if (buffered) terminal?.write(buffered);
        setSessionState("ready");
        terminal?.focus();
      })
      .catch((reason) => {
        if (cancelled) return;
        setError(reason instanceof Error ? reason.message : "The connection flow could not start.");
        setSessionState("error");
      });

    return () => {
      cancelled = true;
      const terminalId = terminalIdRef.current;
      terminalIdRef.current = null;
      pendingOutputRef.current.clear();
      if (terminalId) void sendCommand(command({ type: "terminal.close", payload: { terminalId } })).catch(() => undefined);
    };
  }, [instanceReady, provider?.id, sendCommand, status]);

  if (!provider) return null;
  return (
    <div className="dialog-backdrop provider-auth-backdrop" role="presentation">
      <section ref={dialogRef} className="provider-auth-dialog" role="dialog" aria-modal="true" aria-labelledby="provider-auth-title">
        <header className="provider-auth-header">
          <span className="provider-auth-mark"><PlugZap size={17} /></span>
          <span><h2 id="provider-auth-title">Connect {provider.label}</h2><p>Finish the official provider sign-in below or in the browser it opens.</p></span>
          <IconButton label="Close connection window" onClick={onClose}><X size={16} /></IconButton>
        </header>
        <div className="provider-auth-terminal" ref={mountRef} />
        <footer className="provider-auth-footer">
          <span className={`provider-auth-state is-${sessionState}`}>
            {sessionState === "starting" ? <LoadingMark label="Starting connection" /> : sessionState === "finished" ? <CheckCircle2 size={15} /> : <PlugZap size={15} />}
            {sessionState === "starting" ? "Starting…" : sessionState === "ready" ? "Waiting for sign-in" : sessionState === "finished" ? "Connection flow complete" : error ?? "Connection needs attention"}
          </span>
          <button type="button" className="secondary-button" onClick={onClose}>{sessionState === "finished" ? "Done" : "Close"}</button>
        </footer>
      </section>
    </div>
  );
}
