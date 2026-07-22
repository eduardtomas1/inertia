import { useEffect, useMemo, useRef, useState } from "react";
import type { PreviewBounds } from "@shared/desktop";
import { ArrowLeft, ArrowRight, ExternalLink, Globe2, LockKeyhole, RefreshCw, ShieldCheck } from "lucide-react";
import { IconButton, LoadingMark } from "./ui";

export type PreviewPanelProps = {
  url: string;
  loading?: boolean;
  canGoBack?: boolean;
  canGoForward?: boolean;
  onNavigate: (url: string) => void;
  onOpenExternal: (url: string) => void;
  onBack?: () => void;
  onForward?: () => void;
  onReload?: () => void;
  onBoundsChange?: (bounds: PreviewBounds | null) => void;
};

function safePreviewUrl(input: string): { value: string; parsed: URL } | { error: string } {
  const trimmed = input.trim();
  if (!trimmed) return { error: "Enter a URL to preview." };

  const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(trimmed);
  const candidate = hasScheme
    ? trimmed
    : /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:\/|$)/i.test(trimmed)
      ? `http://${trimmed}`
      : `https://${trimmed}`;

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { error: "Only HTTP and HTTPS addresses can be previewed." };
    }
    if (parsed.username || parsed.password) {
      return { error: "Addresses containing credentials are not supported." };
    }
    return { value: parsed.toString(), parsed };
  } catch {
    return { error: "Enter a valid HTTP or HTTPS address." };
  }
}

export function PreviewPanel({
  url,
  loading = false,
  canGoBack = false,
  canGoForward = false,
  onNavigate,
  onOpenExternal,
  onBack,
  onForward,
  onReload,
  onBoundsChange,
}: PreviewPanelProps): React.JSX.Element {
  const [draftUrl, setDraftUrl] = useState(url);
  const [validationError, setValidationError] = useState<string | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const currentLocation = useMemo(() => safePreviewUrl(url), [url]);

  useEffect(() => {
    setDraftUrl(url);
    setValidationError(null);
  }, [url]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !onBoundsChange) return;
    const update = () => {
      const bounds = stage.getBoundingClientRect();
      onBoundsChange({ x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height) });
    };
    const observer = new ResizeObserver(update);
    observer.observe(stage);
    window.addEventListener("resize", update);
    update();
    return () => { observer.disconnect(); window.removeEventListener("resize", update); onBoundsChange(null); };
  }, [onBoundsChange, url]);

  const navigate = () => {
    const result = safePreviewUrl(draftUrl);
    if ("error" in result) {
      setValidationError(result.error);
      return;
    }
    setValidationError(null);
    setDraftUrl(result.value);
    onNavigate(result.value);
  };

  const openExternal = () => {
    const result = safePreviewUrl(url || draftUrl);
    if ("error" in result) {
      setValidationError(result.error);
      return;
    }
    setValidationError(null);
    onOpenExternal(result.value);
  };

  return (
    <section className="preview-panel" aria-label="Browser preview" aria-busy={loading}>
      <header className="preview-chrome">
        <div className="preview-history-actions">
          {onBack && (
            <IconButton label="Go back" onClick={onBack} disabled={!canGoBack}>
              <ArrowLeft size={15} />
            </IconButton>
          )}
          {onForward && (
            <IconButton label="Go forward" onClick={onForward} disabled={!canGoForward}>
              <ArrowRight size={15} />
            </IconButton>
          )}
          {onReload && (
            <IconButton label="Reload preview" onClick={onReload} disabled={!url || loading}>
              {loading ? <LoadingMark label="Loading preview" /> : <RefreshCw size={15} />}
            </IconButton>
          )}
        </div>

        <form className="preview-address-form" onSubmit={(event) => { event.preventDefault(); navigate(); }}>
          {currentLocation && !("error" in currentLocation) && currentLocation.parsed.protocol === "https:"
            ? <LockKeyhole size={14} aria-label="Secure HTTPS address" />
            : <Globe2 size={14} aria-hidden="true" />}
          <input
            type="text"
            inputMode="url"
            value={draftUrl}
            aria-label="Preview address"
            aria-invalid={Boolean(validationError)}
            aria-describedby={validationError ? "preview-url-error" : undefined}
            placeholder="localhost:3000 or https://example.com"
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            onChange={(event) => {
              setDraftUrl(event.currentTarget.value);
              if (validationError) setValidationError(null);
            }}
          />
          <button type="submit" className="preview-go-button">Go</button>
        </form>

        <IconButton label="Open in system browser" onClick={openExternal} disabled={!url && !draftUrl.trim()}>
          <ExternalLink size={15} />
        </IconButton>
      </header>

      {validationError && <p className="preview-address-error" id="preview-url-error" role="alert">{validationError}</p>}

      <div className="preview-safe-stage" ref={stageRef}>
        {loading ? (
          <div className="panel-loading"><LoadingMark label="Connecting to preview" /><span>Connecting to preview…</span></div>
        ) : currentLocation && !("error" in currentLocation) ? (
          <div className="preview-safe-card">
            <span className="preview-safe-icon"><ShieldCheck size={23} aria-hidden="true" /></span>
            <span className="panel-kicker">Safe preview target</span>
            <h3>{currentLocation.parsed.hostname}</h3>
            <p>{currentLocation.parsed.origin}</p>
            <p className="preview-safe-note">
              Inertia keeps remote content outside the React renderer. Navigation is handed to the desktop preview service.
            </p>
            <button type="button" className="secondary-button" onClick={openExternal}>
              <ExternalLink size={15} aria-hidden="true" />
              <span>Open externally</span>
            </button>
          </div>
        ) : (
          <div className="panel-empty preview-empty">
            <Globe2 size={23} aria-hidden="true" />
            <h3>Open a local preview</h3>
            <p>Enter a development server URL above. No untrusted page is embedded in this renderer.</p>
          </div>
        )}
      </div>
    </section>
  );
}
