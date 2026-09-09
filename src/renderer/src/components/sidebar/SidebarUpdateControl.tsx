import { lazy, Suspense, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ExternalLink, X } from "lucide-react";
import type { AppUpdateController } from "../../hooks/useAppUpdate";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useNativePreviewSuspension } from "../../hooks/useNativePreviewSuspension";
import { updatePercent, updatePresentation, type UpdateAction } from "./appUpdatePresentation";
import { UpdateStatusIcon } from "./UpdateStatusIcon";
import { UpdateRestartConfirmation } from "./UpdateRestartConfirmation";
import "./SidebarUpdateControl.css";
const UpdateReleaseNotes = lazy(async () => ({
  default: (await import("./UpdateReleaseNotes")).UpdateReleaseNotes,
}));

/** Presentation only. The existing main-process updater remains the authority. */
export function SidebarUpdateControl({ controller }: { controller: AppUpdateController }): React.JSX.Element {
  const { status } = controller;
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [pending, setPending] = useState<UpdateAction | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [openingRelease, setOpeningRelease] = useState(false);
  const [latched, setLatched] = useState(false);
  const actionInFlight = useRef(false);
  const cancelInFlight = useRef(false);
  const releaseInFlight = useRef(false);
  const restoringFocus = useRef(false);
  const pointerInside = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const popupId = useId();
  const checking = controller.checking || status?.state === "checking" || pending === "check";
  const showChecking = checking || (latched && !reducedMotion);
  const presentation = updatePresentation(status, showChecking);
  const percent = updatePercent(status?.progress?.percent);
  const disabled = pending !== null || presentation.action === "none" || (presentation.action === "release" && openingRelease);
  useNativePreviewSuspension(open || confirmation !== null);
  const focusTrigger = useCallback(() => {
    restoringFocus.current = true;
    trigger.current?.focus({ preventScroll: true });
    restoringFocus.current = false;
  }, []);

  useEffect(() => {
    if (reducedMotion) setLatched(false);
    else if (checking) setLatched(true);
  }, [checking, reducedMotion]);
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);
  useEffect(() => {
    if (!open) return;
    const dismissOutside = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (!trigger.current?.contains(target) && !popup.current?.contains(target)) setOpen(false);
    };
    const dismissEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      if (popup.current?.contains(document.activeElement)) focusTrigger();
      setOpen(false);
    };
    document.addEventListener("pointerdown", dismissOutside, true);
    document.addEventListener("keydown", dismissEscape);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside, true);
      document.removeEventListener("keydown", dismissEscape);
    };
  }, [open, focusTrigger]);
  useLayoutEffect(() => {
    if (!open) return;
    const node = popup.current;
    const position = (): void => {
      if (!node || !trigger.current) return;
      const bounds = trigger.current.getBoundingClientRect();
      const width = Math.min(340, window.innerWidth - 16);
      const above = bounds.top - 16;
      const below = window.innerHeight - bounds.bottom - 16;
      const upward = above >= below;
      node.style.width = `${width}px`;
      node.style.left = `${Math.max(8, Math.min(bounds.left, window.innerWidth - width - 8))}px`;
      node.style.top = upward ? "auto" : `${bounds.bottom + 8}px`;
      node.style.bottom = upward ? `${window.innerHeight - bounds.top + 8}px` : "auto";
      node.style.maxHeight = `${Math.max(0, upward ? above : below)}px`;
    };
    position();
    node?.showPopover?.();
    window.addEventListener("resize", position);
    return () => window.removeEventListener("resize", position);
  }, [open]);

  const enter = (): void => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    if (confirmation === null) setOpen(true);
  };
  const pointerEnter = (): void => {
    pointerInside.current = true;
    enter();
  };
  const leave = (): void => {
    pointerInside.current = false;
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => {
      if (!popup.current?.contains(document.activeElement) && !trigger.current?.matches(":focus-visible")) setOpen(false);
    }, 150);
  };
  const close = (restore = false): void => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setOpen(false);
    if (restore) focusTrigger();
  };
  const run = async (action: UpdateAction): Promise<void> => {
    // Opening notes must remain possible while a download invocation is pending.
    if (action === "release") {
      if (releaseInFlight.current) return;
      releaseInFlight.current = true;
      setOpeningRelease(true);
      try { await controller.openRelease(); } catch { /* Sanitized by the controller. */ }
      finally { releaseInFlight.current = false; setOpeningRelease(false); }
      return;
    }
    if (actionInFlight.current || action === "none") return;
    actionInFlight.current = true;
    setPending(action);
    try {
      if (action === "check") await controller.check(true);
      else if (action === "download") await controller.download();
      else if (action === "install") await controller.install();
    } catch { /* The controller publishes a sanitized, actionable error. */ }
    finally { actionInFlight.current = false; setPending(null); }
  };
  const activate = (): void => {
    if (disabled) return;
    if (presentation.action === "install" && status?.latestVersion) {
      close();
      setConfirmation(status.latestVersion);
      return;
    }
    if (presentation.action === "check" && !reducedMotion) setLatched(true);
    void run(presentation.action);
  };
  const cancel = async (): Promise<void> => {
    if (cancelInFlight.current) return;
    cancelInFlight.current = true;
    setCancelling(true);
    try { await controller.cancelDownload(); } catch { /* Sanitized by the controller. */ }
    finally { cancelInFlight.current = false; setCancelling(false); }
  };
  const currentVersion = status?.currentVersion;
  const readyToConfirm = status?.state === "downloaded" && status.latestVersion === confirmation;
  return <div className="sidebar-update-control" onPointerEnter={pointerEnter} onPointerLeave={leave}
    onBlur={(event) => {
      // Native focus can return to the document when a download action is
      // disabled/removed. Hover still owns the panel until the pointer leaves.
      if (!pointerInside.current && !event.currentTarget.contains(event.relatedTarget as Node | null)) close();
    }} onKeyDown={(event) => {
      if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); close(true); }
    }}>
    <button ref={trigger} type="button" className="icon-button sidebar-update-button"
      data-update-state={presentation.icon} aria-label={presentation.label} aria-disabled={disabled || undefined}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? popupId : undefined}
      aria-description="Press Arrow Up for update details and more actions."
      onPointerEnter={pointerEnter}
      onClick={activate} onFocus={(event) => { if (!restoringFocus.current && event.currentTarget.matches(":focus-visible")) enter(); }}
      onContextMenu={(event) => { event.preventDefault(); enter(); }}
      onKeyDown={(event) => {
        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          event.preventDefault(); event.stopPropagation(); enter();
          requestAnimationFrame(() => popup.current?.querySelector<HTMLButtonElement>("button")?.focus());
        }
      }}>
      <UpdateStatusIcon state={presentation.icon} percent={percent}
        animate={!reducedMotion && (presentation.icon === "checking" || presentation.icon === "installing")}
        onIteration={() => { if (!checking) setLatched(false); }} />
    </button>
    <span className="update-status-announcement" role="status" aria-live="polite">{status?.message ?? ""}</span>
    {open && <div ref={popup} id={popupId} popover="manual" className="sidebar-update-details" role="dialog"
      aria-label="Application update details" onPointerEnter={pointerEnter} onPointerLeave={leave}
      onToggle={(event) => { if (event.newState === "closed") close(); }}>
      <header><div><strong>{presentation.label}</strong>
        {currentVersion && <small>{status?.channel === "canary" ? "Inertia Canary" : "Inertia"} · Installed {currentVersion}</small>}</div>
        <button type="button" className="icon-button" aria-label="Close update details" onClick={() => close(true)}><X size={14} /></button></header>
      <p className="update-detail-message">{controller.error ?? status?.message ?? "Check for a new version without leaving your work."}</p>
      {status?.freshness === "cached" && <p className="update-detail-muted">Showing the last successful check. Release information may be out of date.</p>}
      {status?.state === "downloading" && <div className="update-detail-progress" role="progressbar" aria-label="Update download progress"
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined} aria-valuetext={percent === null ? "Waiting for download progress" : `${percent}%`}>
        <span style={{ width: `${percent ?? 0}%` }} /></div>}
      {status?.releaseNotes && <section className="update-release-notes" aria-label="Release notes">
        <h3>What’s changed{status.latestVersion ? ` in ${status.latestVersion}` : ""}</h3>
        <div className="update-release-body" tabIndex={0} role="region" aria-label="Release changes">
          <Suspense fallback={<p className="update-release-plain">{status.releaseNotes}</p>}>
            <UpdateReleaseNotes text={status.releaseNotes} />
          </Suspense>
        </div>
      </section>}
      <footer className="update-detail-actions">
        {presentation.action !== "none" && <button type="button" className="secondary-button" disabled={disabled} onClick={activate}>{presentation.actionLabel}</button>}
        {status?.state === "downloading" && <button type="button" className="secondary-button" disabled={cancelling} onClick={() => { void cancel(); }}>{cancelling ? "Cancelling…" : "Cancel download"}</button>}
        {status?.releaseUrl && presentation.action !== "release" && <button type="button" className="text-button" onClick={() => { void run("release"); }} disabled={openingRelease}>Release notes <ExternalLink size={12} aria-hidden="true" /></button>}
      </footer>
    </div>}
    {confirmation && <UpdateRestartConfirmation version={confirmation} ready={readyToConfirm}
      restoreFocus={focusTrigger}
      onClose={() => setConfirmation(null)} onConfirm={() => {
        if (!readyToConfirm || actionInFlight.current) return;
        setConfirmation(null);
        void run("install");
      }} />}
  </div>;
}
