import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, X } from "lucide-react";
import type { AppSnapshot } from "@shared/contracts";
import type { AppUpdateController } from "../../hooks/useAppUpdate";
import type { UpdateEverythingController } from "../../hooks/useUpdateEverything";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useNativePreviewSuspension } from "../../hooks/useNativePreviewSuspension";
import { installedLine, updateEverythingLabel, updatePercent, updatePresentation, type UpdateAction } from "./appUpdatePresentation";
import { IconButton } from "../ui";
import { UpdateStatusIcon } from "./UpdateStatusIcon";
import { UpdateRestartConfirmation } from "./UpdateRestartConfirmation";
import { UpdateEverythingDialog } from "./UpdateEverythingDialog";
import { UpdateReleaseSection } from "./UpdateReleaseSection";
import { providerLabel, updateEverythingPlan } from "./updateEverythingPlan";
import { SidebarUpdateStrip } from "./SidebarUpdateStrip";
import { updateStripView, type UpdateStripView } from "./updateStripView";
import "./SidebarUpdateControl.css";

/** Presentation only. The existing main-process updater remains the authority. */
const NO_OPERATIONS: UpdateEverythingController["operations"] = new Map();
const STRIP_TICK_MS = 30_000;

export function SidebarUpdateControl({ controller, everything, snapshot = null, onOpenAgentSettings }: {
  controller: AppUpdateController; everything?: UpdateEverythingController; snapshot?: AppSnapshot | null;
  onOpenAgentSettings?: () => void;
}): React.JSX.Element {
  const { status } = controller;
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [everythingOpen, setEverythingOpen] = useState(false);
  const [pending, setPending] = useState<UpdateAction | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [openingRelease, setOpeningRelease] = useState(false);
  const [watermark] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const [downloadedVersion, setDownloadedVersion] = useState<string | null>(null);
  const opener = useRef<HTMLElement | null>(null);
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
  const offeredPlan = useMemo(() => everything ? updateEverythingPlan({
    snapshot, statuses: everything.statuses, operations: everything.operations, appStatus: status,
  }) : null, [everything, snapshot, status]);
  const everythingPlan = everything?.phase ? null : offeredPlan;
  const offeredItems = offeredPlan && JSON.stringify([offeredPlan.app, offeredPlan.providers]);
  const dismissEverythingError = everything?.dismissError;
  const everythingError = everything?.error ?? null;
  const errorPlan = useRef<string | null | undefined>(undefined);
  const phase = everything?.phase ?? null;
  const activeRun = everything?.activeRun ?? null;
  const outcome = everything?.outcome ?? null;
  const operations = everything?.operations ?? NO_OPERATIONS;
  const stripView = useMemo(() => updateStripView({
    phase, activeRun, outcome, operations, appStatus: status, now, watermark, dismissed, downloadedVersion,
    label: (providerId) => providerLabel(snapshot, providerId),
  }), [phase, activeRun, outcome, operations, status, now, watermark, dismissed, downloadedVersion, snapshot]);
  const stripActive = stripView?.active === true;
  const everythingLabel = everythingPlan
    ? updateEverythingLabel(everythingPlan.app !== null, everythingPlan.providers.map((provider) => provider.label)) : null;
  const appPresentation = updatePresentation(status, checking);
  const presentation: ReturnType<typeof updatePresentation> = stripActive
    ? { icon: appPresentation.icon === "checking" ? "idle" : appPresentation.icon, action: "details", label: "Update details", actionLabel: "Update details" }
    : everythingLabel && pending === null ? { icon: "available", action: "everything", label: everythingLabel, actionLabel: everythingLabel }
      : appPresentation;
  const percent = updatePercent(status?.progress?.percent);
  const disabled = pending !== null || presentation.action === "none" || (presentation.action === "release" && openingRelease);
  useNativePreviewSuspension(open || confirmation !== null);
  const focusTrigger = useCallback(() => {
    restoringFocus.current = true;
    const target = opener.current?.isConnected ? opener.current : trigger.current;
    opener.current = null;
    target?.focus({ preventScroll: true });
    restoringFocus.current = false;
  }, []);
  const focusIcon = useCallback(() => {
    opener.current = null;
    focusTrigger();
  }, [focusTrigger]);

  useEffect(() => {
    if (!stripActive) return;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), STRIP_TICK_MS);
    return () => clearInterval(tick);
  }, [stripActive]);
  useEffect(() => {
    if (status?.state === "downloading" && !phase && status.latestVersion) setDownloadedVersion(status.latestVersion);
  }, [status?.state, status?.latestVersion, phase]);
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);
  useEffect(() => {
    if (!everythingError) errorPlan.current = undefined;
    else if (errorPlan.current === undefined) errorPlan.current = offeredItems;
    else if (errorPlan.current !== offeredItems) dismissEverythingError?.();
  }, [dismissEverythingError, everythingError, offeredItems]);
  const everythingPlanGone = everythingPlan === null;
  useEffect(() => { if (everythingPlanGone) setEverythingOpen(false); }, [everythingPlanGone]);
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
    if (confirmation === null && !everythingOpen) setOpen(true);
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
    else opener.current = null;
  };
  const openDetails = (from?: HTMLElement): void => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    if (confirmation !== null || everythingOpen) return;
    opener.current = from ?? null;
    setOpen(true);
    requestAnimationFrame(() => popup.current?.querySelector<HTMLButtonElement>("button")?.focus());
  };
  const dismissStrip = (view: UpdateStripView): void => {
    setDismissed((current) => new Set([...current, view.key, ...view.key.split("|")]));
  };
  const openPage = async (open: () => Promise<void>): Promise<void> => {
    if (releaseInFlight.current) return;
    releaseInFlight.current = true;
    setOpeningRelease(true);
    try { await open(); } catch { /* Sanitized by the controller. */ }
    finally { releaseInFlight.current = false; setOpeningRelease(false); }
  };
  const run = async (action: UpdateAction): Promise<void> => {
    // Opening notes must remain possible while a download invocation is pending.
    if (action === "release") {
      await openPage(() => controller.openRelease());
      return;
    }
    if (actionInFlight.current || action === "none" || action === "everything" || action === "details") return;
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
    if (presentation.action === "details") {
      openDetails();
      return;
    }
    if (presentation.action === "everything") {
      close();
      setEverythingOpen(true);
      return;
    }
    if (presentation.action === "install" && status?.latestVersion) {
      close();
      setConfirmation(status.latestVersion);
      return;
    }
    void run(presentation.action);
  };
  const cancel = async (): Promise<void> => {
    if (cancelInFlight.current) return;
    cancelInFlight.current = true;
    setCancelling(true);
    try { await controller.cancelDownload(); } catch { /* Sanitized by the controller. */ }
    finally { cancelInFlight.current = false; setCancelling(false); }
  };
  const readyToConfirm = status?.state === "downloaded" && status.latestVersion === confirmation;
  const providerRows = stripView?.items.some((item) => item.id !== "inertia") === true;
  const restartFromStrip = (): void => {
    if (stripView) dismissStrip(stripView);
    if (status?.state === "downloaded" && status.latestVersion) {
      close();
      setConfirmation(status.latestVersion);
    }
  };
  return <><SidebarUpdateStrip view={stripView} expanded={open} popupId={popupId}
    onOpen={(element) => openDetails(element)} onDismiss={dismissStrip} onRestart={restartFromStrip} onFocusLost={focusIcon} />
  <div className="sidebar-update-control" onPointerEnter={pointerEnter} onPointerLeave={leave}
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
      <UpdateStatusIcon state={presentation.icon} percent={percent} reducedMotion={reducedMotion} />
    </button>
    <span className="update-status-announcement" role="status" aria-live="polite">{stripView?.title ?? status?.message ?? ""}</span>
    {open && <div ref={popup} id={popupId} popover="manual" className="sidebar-update-details" role="dialog"
      aria-label="Application update details" onPointerEnter={pointerEnter} onPointerLeave={leave}
      onToggle={(event) => { if (event.newState === "closed") close(); }}>
      <header><div><strong>{stripView?.title ?? presentation.label}</strong>
        {status?.currentVersion && <small>{installedLine(status)}</small>}</div>
        <IconButton label="Close update details" onClick={() => close(true)}><X size={16} /></IconButton></header>
      {stripView ? <>
        {controller.error && <p className="update-detail-message">{controller.error}</p>}
        {stripView.items.length > 0 && <ul className="update-run-items" aria-label="Update progress">
          {stripView.items.map((item) => <li key={item.id} className={item.failed ? "is-failed" : undefined}>
            <span>{item.label}</span><span>{item.status}</span>{item.detail && <small>{item.detail}</small>}
          </li>)}
        </ul>}
        {stripView.items.length === 0 && !stripView.active && everythingError && <p className="update-detail-message">{everythingError}</p>}
      </> : <>
        {(controller.error ?? status?.message) && <p className="update-detail-message">{controller.error ?? status?.message}</p>}
        {everythingError && everythingError !== (controller.error ?? status?.message) && <p className="update-detail-message">{everythingError}</p>}
      </>}
      {status?.freshness === "cached" && <p className="update-detail-muted">Showing the last successful check. Release information may be out of date.</p>}
      {status?.state === "downloading" && <div className="update-detail-progress" role="progressbar" aria-label="Update download progress"
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined} aria-valuetext={percent === null ? "Waiting for download progress" : `${percent}%`}>
        <span style={{ width: `${percent ?? 0}%` }} /></div>}
      {status?.releaseNotes && <UpdateReleaseSection status={status} notes={status.releaseNotes} opening={openingRelease}
        onOpenRelease={(version) => { void openPage(() => controller.openRelease(version)); }}
        onOpenReleases={() => { void openPage(() => controller.openReleases()); }} />}
      <footer className="update-detail-actions">
        {presentation.action !== "none" && presentation.action !== "details" && <button type="button" className="secondary-button" disabled={disabled} onClick={activate}>{presentation.actionLabel}</button>}
        {providerRows && onOpenAgentSettings && <button type="button" className="text-button" onClick={() => { close(); onOpenAgentSettings(); }}>Agent settings</button>}
        {status?.state === "downloading" && <button type="button" className="secondary-button" disabled={cancelling} onClick={() => { void cancel(); }}>{cancelling ? "Cancelling…" : "Cancel download"}</button>}
        {status?.releaseUrl && presentation.action !== "release" && <button type="button" className="text-button" onClick={() => { void run("release"); }} disabled={openingRelease}>Release notes <ExternalLink size={14} aria-hidden="true" /></button>}
      </footer>
    </div>}
    {confirmation && <UpdateRestartConfirmation version={confirmation} ready={readyToConfirm}
      restoreFocus={focusTrigger}
      onClose={() => setConfirmation(null)} onConfirm={() => {
        if (!readyToConfirm || actionInFlight.current) return;
        setConfirmation(null);
        void run("install");
      }} />}
    {everythingOpen && everythingPlan && everything && <UpdateEverythingDialog plan={everythingPlan}
      restoreFocus={focusTrigger} onClose={() => setEverythingOpen(false)} onUpdate={(request) => {
        setEverythingOpen(false);
        void everything.run(request, new Map(everythingPlan.providers.map(({ providerId, label }) => [providerId, label])));
      }} />}
  </div></>;
}
