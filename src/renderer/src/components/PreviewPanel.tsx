import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  PreviewBounds,
  PreviewTabState,
} from "@shared/desktop";
import type {
  BrowserEvidenceImage,
  BrowserEvidenceSnapshot,
} from "@shared/browser-evidence";
import {
  previewNavigationTarget,
  type PreviewNavigationTarget,
} from "@shared/preview-url";
import {
  nativePreviewSuspended,
  NATIVE_PREVIEW_SUSPENSION_CHANGED,
} from "../utils/nativePreviewOverlay";
import {
  registerWorkspacePreviewAddress,
  usePreviewTabCloseFocus,
  type WorkspacePreviewOwner,
} from "../utils/workspacePreviewFocus";
import { ArrowLeft, ArrowRight, ExternalLink, Globe2, History, LockKeyhole, Plus, RefreshCw, ShieldCheck, X } from "lucide-react";
import { IconButton, LoadingMark } from "./ui";
import "./PreviewPanel.css";

const BrowserEvidenceTimeline = lazy(() => import("./BrowserEvidenceTimeline"));

export type PreviewPanelProps = {
  owner: WorkspacePreviewOwner;
  contextId?: string;
  url: string;
  loading?: boolean;
  canGoBack?: boolean;
  canGoForward?: boolean;
  tabs?: PreviewTabState[];
  activeTabId?: string | null;
  evidence?: BrowserEvidenceSnapshot;
  onNavigate: (url: string) => void;
  onOpenExternal: (url: string) => void;
  onBack?: () => void;
  onForward?: () => void;
  onReload?: () => void;
  onOpenTab?: () => void;
  onActivateTab?: (tabId: string) => void;
  onCloseTab?: (tabId: string) => void;
  onLoadEvidenceImage?: (evidenceId: string) => Promise<BrowserEvidenceImage | null>;
  onBoundsChange?: (bounds: PreviewBounds | null) => void;
};

export function safePreviewUrl(
  input: string,
): {
  value: string;
  parsed: URL;
  target: PreviewNavigationTarget["kind"];
} | { error: string } {
  const trimmed = input.trim();
  if (!trimmed) return { error: "Enter a URL to preview." };

  const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(trimmed);
  const literalLoopbackWithoutScheme =
    /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(trimmed);
  const candidate = literalLoopbackWithoutScheme
    ? `http://${trimmed}`
    : hasScheme
      ? trimmed
      : `https://${trimmed}`;

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { error: "Only HTTP and HTTPS addresses can be previewed." };
    }
    if (parsed.username || parsed.password) {
      return { error: "Addresses containing credentials are not supported." };
    }
    const target = previewNavigationTarget(parsed.toString());
    return {
      value: target.url.toString(),
      parsed: target.url,
      target: target.kind,
    };
  } catch (error) {
    return {
      error: error instanceof Error
        ? error.message
        : "Enter a valid HTTP or HTTPS address.",
    };
  }
}

export function PreviewPanel({
  owner,
  contextId = "",
  url,
  loading = false,
  canGoBack = false,
  canGoForward = false,
  tabs = [],
  activeTabId = null,
  evidence = { revision: 0, entries: [], omitted: false },
  onNavigate,
  onOpenExternal,
  onBack,
  onForward,
  onReload,
  onOpenTab,
  onActivateTab,
  onCloseTab,
  onLoadEvidenceImage,
  onBoundsChange,
}: PreviewPanelProps): React.JSX.Element {
  const [draftUrl, setDraftUrl] = useState(url);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [openEvidenceContextId, setOpenEvidenceContextId] = useState<string | null>(null);
  const evidenceOpen = openEvidenceContextId === contextId;
  const stageRef = useRef<HTMLDivElement>(null);
  const evidenceToggleRef = useRef<HTMLButtonElement>(null);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const addressRef = useCallback((address: HTMLInputElement | null) => {
    registerWorkspacePreviewAddress(owner, address);
  }, [owner]);
  const currentLocation = useMemo(() => safePreviewUrl(url), [url]);
  const prepareTabCloseFocus = usePreviewTabCloseFocus(tabs, activeTabId, tabRefs);

  useEffect(() => {
    setDraftUrl(url);
    setValidationError(null);
  }, [url]);

  useEffect(() => {
    if (openEvidenceContextId !== contextId) setOpenEvidenceContextId(null);
  }, [contextId, openEvidenceContextId]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !onBoundsChange) return;
    const update = () => {
      if (nativePreviewSuspended()) {
        onBoundsChange(null);
        return;
      }
      const bounds = stage.getBoundingClientRect();
      onBoundsChange({ x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height) });
    };
    const observer = new ResizeObserver(update);
    observer.observe(stage);
    window.addEventListener("resize", update);
    window.addEventListener(NATIVE_PREVIEW_SUSPENSION_CHANGED, update);
    update();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener(NATIVE_PREVIEW_SUSPENSION_CHANGED, update);
      onBoundsChange(null);
    };
  }, [onBoundsChange]);

  const closeEvidence = useCallback(() => {
    setOpenEvidenceContextId(null);
    requestAnimationFrame(() => evidenceToggleRef.current?.focus());
  }, []);

  const moveTabFocus = (
    currentTabId: string,
    key: string,
  ): void => {
    const index = tabs.findIndex((tab) => tab.id === currentTabId);
    if (index < 0 || tabs.length === 0) return;
    const nextIndex = key === "Home"
      ? 0
      : key === "End"
        ? tabs.length - 1
        : key === "ArrowRight"
          ? (index + 1) % tabs.length
          : (index - 1 + tabs.length) % tabs.length;
    const next = tabs[nextIndex];
    if (!next) return;
    onActivateTab?.(next.id);
    tabRefs.current.get(next.id)?.focus();
  };

  const navigate = () => {
    const result = safePreviewUrl(draftUrl);
    if ("error" in result) {
      setValidationError(result.error);
      return;
    }
    setValidationError(null);
    setDraftUrl(result.value);
    if (result.target === "embed") {
      onNavigate(result.value);
    } else {
      onOpenExternal(result.value);
    }
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
      <div className="preview-tab-strip" aria-label="Inertia Browser pages">
        <span className="preview-browser-label">
          <Globe2 size={13} aria-hidden="true" />
          <span>Browser</span>
        </span>
        <div className="preview-tabs" role="tablist" aria-label="Browser pages">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`preview-tab-shell${tab.id === activeTabId ? " active" : ""}`}
            >
              <button
                id={`preview-tab-${owner}-${tab.id}`}
                ref={(element) => {
                  if (element) tabRefs.current.set(tab.id, element);
                  else tabRefs.current.delete(tab.id);
                }}
                type="button"
                role="tab"
                aria-selected={tab.id === activeTabId}
                aria-controls={evidenceOpen ? undefined : `preview-page-${owner}`}
                tabIndex={tab.id === (activeTabId ?? tabs[0]?.id) ? 0 : -1}
                className="preview-tab"
                onClick={() => onActivateTab?.(tab.id)}
                onKeyDown={(event) => {
                  if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
                    event.preventDefault();
                    moveTabFocus(tab.id, event.key);
                  } else if (event.key === "Delete" && onCloseTab) {
                    event.preventDefault();
                    prepareTabCloseFocus(tab.id);
                    onCloseTab(tab.id);
                  }
                }}
              >
                <span>{tab.title || (tab.url ? new URL(tab.url).hostname : "New page")}</span>
              </button>
              {onCloseTab && (
                <button
                  type="button"
                  className="preview-tab-close"
                  aria-label={`Close ${tab.title || "browser page"}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onCloseTab(tab.id);
                  }}
                >
                  <X size={11} aria-hidden="true" />
                </button>
              )}
            </div>
          ))}
        </div>
        {onOpenTab && (
          <IconButton label="Open browser page" onClick={onOpenTab} disabled={tabs.length >= 8}>
            <Plus size={14} />
          </IconButton>
        )}
        <button
          ref={evidenceToggleRef}
          type="button"
          className={`preview-evidence-toggle${evidenceOpen ? " is-active" : ""}${evidence.entries.some((entry) => entry.kind === "console-error" || entry.kind === "network-failure") ? " has-failures" : ""}`}
          aria-expanded={evidenceOpen}
          aria-controls={`browser-evidence-${owner}`}
          onClick={() => setOpenEvidenceContextId((current) => (
            current === contextId ? null : contextId
          ))}
        >
          <History size={13} aria-hidden="true" />
          <span>Evidence</span>
          <small>{evidence.entries.length}</small>
        </button>
      </div>
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
            ref={addressRef}
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

      {evidenceOpen ? (
        <Suspense fallback={null}>
          <BrowserEvidenceTimeline
            key={contextId}
            id={`browser-evidence-${owner}`}
            evidence={evidence}
            loadImage={onLoadEvidenceImage ?? (async () => null)}
            onClose={closeEvidence}
          />
        </Suspense>
      ) : (
        <div
          className="preview-safe-stage"
          id={`preview-page-${owner}`}
          ref={stageRef}
          role="tabpanel"
          aria-labelledby={activeTabId ? `preview-tab-${owner}-${activeTabId}` : undefined}
        >
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
      )}
    </section>
  );
}
