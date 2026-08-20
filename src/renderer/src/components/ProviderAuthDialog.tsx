import { useCallback, useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  ExternalLink,
  PlugZap,
  X,
} from "lucide-react";
import type {
  ClientCommand,
  ColorThemeId,
  ProviderInfo,
  ServerEvent,
  ThemePreference,
} from "@shared/contracts";
import type { ConnectionStatus } from "../hooks/useInertiaConnection";
import { useNativePreviewSuspension } from "../hooks/useNativePreviewSuspension";
import { ProviderAuthBrowserUrlDetector } from "../utils/providerAuthBrowser";
import { terminalInputChunks } from "../utils/terminalInputChunks";
import { trapModalFocus } from "../utils/modalFocus";
import { IconButton, LoadingMark } from "./ui";
import "./ProviderAuthDialog.css";

type ProviderAuthDialogProps = {
  provider: ProviderInfo | null;
  status: ConnectionStatus;
  theme: ThemePreference;
  colorTheme?: ColorThemeId;
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
  colorTheme,
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
  const latestFontSizeRef = useRef(fontSize);
  const browserUrlRef = useRef<string | null>(null);
  const browserUrlDetectorRef = useRef<ProviderAuthBrowserUrlDetector | null>(null);
  const browserAttemptRef = useRef(0);
  const [instanceReady, setInstanceReady] = useState(false);
  const [sessionState, setSessionState] = useState<"starting" | "ready" | "finished" | "error">("starting");
  const [error, setError] = useState<string | null>(null);
  const [browserUrl, setBrowserUrl] = useState<string | null>(null);
  const [browserState, setBrowserState] = useState<"idle" | "opening" | "opened" | "failed">("idle");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const providerId = provider?.id ?? null;
  const providerLabel = provider?.label ?? "provider";
  useNativePreviewSuspension(provider !== null);

  const openBrowser = useCallback(async (url: string): Promise<void> => {
    const attempt = ++browserAttemptRef.current;
    setBrowserState("opening");
    setCopyState("idle");
    try {
      await window.inertia.openExternal(url);
      if (browserAttemptRef.current === attempt) setBrowserState("opened");
    } catch {
      if (browserAttemptRef.current === attempt) setBrowserState("failed");
    }
  }, []);

  const inspectAuthOutput = useCallback((output: string): void => {
    const url = browserUrlDetectorRef.current?.push(output) ?? null;
    if (!url || browserUrlRef.current) return;
    browserUrlRef.current = url;
    setBrowserUrl(url);
    void openBrowser(url);
  }, [openBrowser]);

  const copyBrowserUrl = useCallback(async (): Promise<void> => {
    const url = browserUrlRef.current;
    if (!url) return;
    const attempt = browserAttemptRef.current;
    try {
      const copied = await window.inertia.copyText(url);
      if (browserAttemptRef.current === attempt) {
        setCopyState(copied ? "copied" : "failed");
      }
    } catch {
      if (browserAttemptRef.current === attempt) setCopyState("failed");
    }
  }, []);

  const closeDialog = useCallback((): void => {
    browserAttemptRef.current += 1;
    browserUrlDetectorRef.current?.clear();
    browserUrlDetectorRef.current = null;
    browserUrlRef.current = null;
    onClose();
  }, [onClose]);

  useEffect(() => {
    browserAttemptRef.current += 1;
    browserUrlRef.current = null;
    browserUrlDetectorRef.current = providerId
      ? new ProviderAuthBrowserUrlDetector(providerId)
      : null;
    setBrowserUrl(null);
    setBrowserState("idle");
    setCopyState("idle");
    return () => {
      browserAttemptRef.current += 1;
      browserUrlDetectorRef.current?.clear();
      browserUrlDetectorRef.current = null;
      browserUrlRef.current = null;
    };
  }, [providerId]);

  useEffect(() => {
    latestFontSizeRef.current = fontSize;
  }, [fontSize]);

  useEffect(() => {
    if (!providerId) return;
    const mount = mountRef.current;
    if (!mount) return;
    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: true,
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      fontSize: latestFontSizeRef.current,
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
      for (const chunk of terminalInputChunks(data)) {
        void sendCommand(command({ type: "terminal.input", payload: { terminalId, data: chunk } })).catch(() => undefined);
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
  }, [providerId, sendCommand]);

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
  }, [colorTheme, fontSize, instanceReady, providerId, theme]);

  useEffect(() => {
    if (!providerId) {
      pendingOutputRef.current.clear();
      return;
    }
    return subscribe((event) => {
    if (event.type === "terminal.output") {
      if (event.terminalId === terminalIdRef.current) {
        terminalRef.current?.write(event.data);
        inspectAuthOutput(event.data);
      }
      else pendingOutputRef.current.set(event.terminalId, `${pendingOutputRef.current.get(event.terminalId) ?? ""}${event.data}`.slice(-65_536));
    }
    if (event.type === "terminal.exit" && event.terminalId === terminalIdRef.current) {
      terminalIdRef.current = null;
      terminalRef.current?.writeln("\r\n\x1b[2mConnection flow finished. You can close this window.\x1b[0m");
      setSessionState(event.exitCode === 0 ? "finished" : "error");
      if (event.exitCode !== 0) setError("The provider ended the connection flow before it completed.");
    }
    });
  }, [inspectAuthOutput, providerId, subscribe]);

  useEffect(() => {
    if (!providerId) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const pendingOutput = pendingOutputRef.current;
    requestAnimationFrame(() => dialog?.querySelector<HTMLElement>("button")?.focus());
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeDialog();
        return;
      }
      if (dialog) trapModalFocus(event, dialog);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      pendingOutput.clear();
      previous?.focus();
    };
  }, [closeDialog, providerId]);

  useEffect(() => {
    if (!providerId || !instanceReady || status !== "online") return;
    let cancelled = false;
    const terminal = terminalRef.current;
    const pendingOutput = pendingOutputRef.current;
    try { fitRef.current?.fit(); } catch { /* Safe defaults below. */ }
    const size = { cols: Math.max(40, terminal?.cols ?? 90), rows: Math.max(10, terminal?.rows ?? 24) };
    setSessionState("starting");
    setError(null);
    browserAttemptRef.current += 1;
    browserUrlRef.current = null;
    browserUrlDetectorRef.current = new ProviderAuthBrowserUrlDetector(providerId);
    setBrowserUrl(null);
    setBrowserState("idle");
    setCopyState("idle");
    pendingOutputRef.current.clear();
    terminal?.clear();
    terminal?.writeln(`\x1b[2mOpening ${providerLabel} sign-in…\x1b[0m`);
    void sendCommand(command({ type: "provider.auth.start", payload: { providerId, ...size } }))
      .then((event) => {
        if (event.type !== "terminal.created") throw new Error("The connection service returned an unexpected response.");
        if (cancelled) {
          void sendCommand(command({ type: "terminal.close", payload: { terminalId: event.terminalId } })).catch(() => undefined);
          return;
        }
        terminalIdRef.current = event.terminalId;
        const buffered = pendingOutputRef.current.get(event.terminalId);
        pendingOutput.clear();
        if (buffered) {
          terminal?.write(buffered);
          inspectAuthOutput(buffered);
        }
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
      browserAttemptRef.current += 1;
      browserUrlDetectorRef.current?.clear();
      browserUrlRef.current = null;
      const terminalId = terminalIdRef.current;
      terminalIdRef.current = null;
      pendingOutput.clear();
      if (terminalId) void sendCommand(command({ type: "terminal.close", payload: { terminalId } })).catch(() => undefined);
    };
  }, [
    instanceReady,
    inspectAuthOutput,
    providerId,
    providerLabel,
    sendCommand,
    status,
  ]);

  if (!provider) return null;
  return (
    <div className="dialog-backdrop provider-auth-backdrop" role="presentation">
      <section ref={dialogRef} className="provider-auth-dialog" role="dialog" aria-modal="true" aria-labelledby="provider-auth-title">
        <header className="provider-auth-header">
          <span className="provider-auth-mark"><PlugZap size={17} /></span>
          <span><h2 id="provider-auth-title">Connect {provider.label}</h2><p>Finish the official provider sign-in below or in the browser it opens.</p></span>
          <IconButton label="Close connection window" onClick={closeDialog}><X size={16} /></IconButton>
        </header>
        <div className="provider-auth-terminal" ref={mountRef} />
        {browserUrl ? (
          <div
            className={`provider-auth-browser-assist is-${browserState}`}
            role={browserState === "failed" || copyState === "failed" ? "alert" : "status"}
          >
            <span className="provider-auth-browser-copy">
              {browserState === "failed" || copyState === "failed"
                ? <AlertTriangle size={15} />
                : browserState === "opened" || copyState === "copied"
                  ? <CheckCircle2 size={15} />
                  : <ExternalLink size={15} />}
              <span>
                <strong>{browserState === "opening"
                  ? "Opening the secure sign-in page…"
                  : browserState === "opened"
                    ? "Sign-in page opened in your browser"
                    : "The default browser did not open"}</strong>
                <small>{copyState === "copied"
                  ? "Secure sign-in link copied."
                  : copyState === "failed"
                    ? "The secure link could not be copied."
                    : browserState === "failed"
                      ? "Retry, or copy the one-time link and open it yourself."
                      : "Return here after you finish with Claude."}</small>
              </span>
            </span>
            <span className="provider-auth-browser-actions">
              <button type="button" className="secondary-button" onClick={() => { void copyBrowserUrl(); }}><Copy size={13} />Copy link</button>
              <button type="button" className="secondary-button" disabled={browserState === "opening"} onClick={() => { void openBrowser(browserUrl); }}><ExternalLink size={13} />{browserState === "failed" ? "Try again" : "Open again"}</button>
            </span>
          </div>
        ) : null}
        <footer className="provider-auth-footer">
          <span className={`provider-auth-state is-${sessionState}`}>
            {sessionState === "starting" ? <LoadingMark label="Starting connection" /> : sessionState === "finished" ? <CheckCircle2 size={15} /> : <PlugZap size={15} />}
            {sessionState === "starting" ? "Starting…" : sessionState === "ready" ? "Waiting for sign-in" : sessionState === "finished" ? "Connection flow complete" : error ?? "Connection needs attention"}
          </span>
          <button type="button" className="secondary-button" onClick={closeDialog}>{sessionState === "finished" ? "Done" : "Close"}</button>
        </footer>
      </section>
    </div>
  );
}
