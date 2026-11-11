import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { USAGE_RANGE_DAYS, type UsageRangeDays } from "@shared/contracts/usage-dashboard";

import { useLoadedSurface } from "../../hooks/useLoadedSurface";
import { useNativePreviewSuspension } from "../../hooks/useNativePreviewSuspension";
import { resultEvent } from "../../lib/runtimeCommands";
import { DialogShell } from "../DialogShell";
import { ProviderBrandIcon } from "../ProviderBrandIcon";
import { TooltipButton } from "../TooltipButton";
import { IconButton, LoadingMark } from "../ui";
import { useUsageLimitsContext, type UsagePopupTab } from "../usage-limits-state";
import { loadUsageLimitsPanel, loadUsageOverview } from "./usageTabLoaders";
import { UsageFilterMenu, type UsageFilterOption } from "./UsageFilterMenu";
import { ALL_USAGE_SOURCES, LOCAL_USAGE_SOURCE, usageProviderOptions } from "./usageFilters";
import { readUsagePopupPreferences, writeUsagePopupPreferences, type UsagePopupPreferences } from "./usagePopupPreferences";
import "./UsagePopup.css";

const TABS: ReadonlyArray<{ id: UsagePopupTab; label: string; key: string }> = [
  { id: "cost", label: "Cost", key: "C" },
  { id: "tokens", label: "Tokens", key: "T" },
  { id: "limits", label: "Limits", key: "L" },
];
const ALL_PROVIDERS = "all";
const OTHER_SURFACE = "input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='menu'], [role='listbox'], .limit-reset-confirmation";
const FOCUS_FALLBACKS = ["[data-usage-popup-opener]", "[data-composer-zone='input'] textarea", "#main-workspace"];

function restoreFocus(previous: HTMLElement | null): void {
  const candidates = [previous, ...FOCUS_FALLBACKS.map((selector) => document.querySelector<HTMLElement>(selector))];
  for (const candidate of candidates) {
    if (!candidate?.isConnected || candidate.closest("[inert], [aria-hidden='true']")) continue;
    candidate.focus({ preventScroll: true });
    if (document.activeElement === candidate) return;
  }
}

interface UsagePopupProps {
  requestedTab: UsagePopupTab | null;
  requestRevision: number;
  returnFocusTo?: HTMLElement | null;
  onClose(): void;
}

export function UsagePopup({ requestedTab, requestRevision, returnFocusTo, onClose }: UsagePopupProps): React.JSX.Element | null {
  const context = useUsageLimitsContext();
  const dialog = useRef<HTMLElement>(null);
  const titleId = useId();
  const tabsId = useId().replaceAll(":", "");
  const [preferences, setPreferences] = useState<UsagePopupPreferences>(() => {
    const stored = readUsagePopupPreferences();
    return requestedTab ? { ...stored, tab: requestedTab } : stored;
  });
  const [source, setSource] = useState(ALL_USAGE_SOURCES);
  const [limitsRefresh, setLimitsRefresh] = useState(0);
  const [usageRefresh, setUsageRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const { tab, days } = preferences;
  const showingLimits = tab === "limits";
  const UsageLimitsPanel = useLoadedSurface(loadUsageLimitsPanel, showingLimits);
  const UsageOverview = useLoadedSurface(loadUsageOverview, !showingLimits);
  useNativePreviewSuspension(true);
  useLayoutEffect(() => {
    const previous = returnFocusTo ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    dialog.current?.focus({ preventScroll: true });
    return () => restoreFocus(previous);
  }, [returnFocusTo]);
  useLayoutEffect(() => {
    if (dialog.current?.contains(document.activeElement)) return;
    (dialog.current?.querySelector<HTMLElement>("[role='tab'][aria-selected='true']") ?? dialog.current)?.focus({ preventScroll: true });
  }, [tab]);
  useEffect(() => {
    writeUsagePopupPreferences(preferences);
  }, [preferences]);
  const selectTab = useCallback((next: UsagePopupTab): void => {
    if (next === tab) return;
    setBusy(false);
    setPreferences((current) => ({ ...current, tab: next }));
  }, [tab]);
  const handledRevision = useRef(requestRevision);
  useEffect(() => {
    if (handledRevision.current === requestRevision) return;
    handledRevision.current = requestRevision;
    if (requestedTab) selectTab(requestedTab);
  }, [requestRevision, requestedTab, selectTab]);
  useLayoutEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing) return;
      const target = event.target instanceof Element ? event.target : null;
      const owner = target?.closest("[role='dialog']");
      if (owner && owner !== dialog.current) return;
      const outside = !dialog.current?.contains(document.activeElement);
      if (event.key === "Escape") {
        if (target?.closest("[role='menu'], [role='listbox']")) return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key === "Tab" && outside) {
        event.preventDefault();
        dialog.current?.focus({ preventScroll: true });
        return;
      }
      if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
      const next = TABS.find(({ key }) => key === event.key.toUpperCase());
      if (!next || target?.closest(OTHER_SURFACE)) return;
      event.preventDefault();
      event.stopPropagation();
      selectTab(next.id);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose, selectTab]);
  const snapshot = context?.snapshot ?? null;
  const request = context?.request;
  const publish = context?.setSnapshot;
  const online = context?.status === "online";
  useEffect(() => {
    if (snapshot || !request || !online || showingLimits) return;
    let active = true;
    void request({ type: "usage.limits.get", payload: { refresh: false, force: false } }).then((event) => {
      const result = resultEvent(event).result;
      if (active && result.kind === "usage.limits") publish?.(result.snapshot);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [online, publish, request, showingLimits, snapshot]);
  const providers = useMemo(() => usageProviderOptions(snapshot), [snapshot]);
  const hiddenProviderIds = useMemo(() => new Set(preferences.hiddenProviders), [preferences.hiddenProviders]);
  const hubs = snapshot?.sources ?? [];
  const activeSource = source === ALL_USAGE_SOURCES || source === LOCAL_USAGE_SOURCE || hubs.some(({ id }) => id === source)
    ? source
    : ALL_USAGE_SOURCES;
  if (!context) return null;
  const visibleProviders = providers.filter(({ id }) => !hiddenProviderIds.has(id));
  const providersLabel = visibleProviders.length === providers.length
    ? "All providers"
    : visibleProviders.length === 0
      ? "No providers"
      : visibleProviders.length === 1 ? visibleProviders[0]!.label : `${visibleProviders.length} providers`;
  const providerOptions: UsageFilterOption[] = [
    { id: ALL_PROVIDERS, label: "All providers", checked: visibleProviders.length === providers.length },
    ...providers.map(({ id, label }, index) => ({
      id,
      label,
      checked: !hiddenProviderIds.has(id),
      icon: <ProviderBrandIcon providerId={id} decorative size={14} />,
      separated: index === 0,
    })),
  ];
  const toggleProvider = (id: string): void => setPreferences((current) => {
    const hidden = new Set(current.hiddenProviders.filter((hiddenId) => providers.some((provider) => provider.id === hiddenId)));
    if (id === ALL_PROVIDERS) return { ...current, hiddenProviders: [] };
    if (!hidden.delete(id)) hidden.add(id);
    return { ...current, hiddenProviders: [...hidden] };
  });
  const sourceOptions: UsageFilterOption[] = [
    { id: ALL_USAGE_SOURCES, label: "All sources", checked: activeSource === ALL_USAGE_SOURCES },
    { id: LOCAL_USAGE_SOURCE, label: "This computer", checked: activeSource === LOCAL_USAGE_SOURCE, separated: true },
    ...hubs.map(({ id, label }) => ({ id, label, checked: activeSource === id })),
  ];
  const periodOptions: UsageFilterOption[] = USAGE_RANGE_DAYS.map((option) => ({
    id: String(option),
    label: `Last ${option} days`,
    checked: days === option,
  }));
  const refreshUnavailable = busy || !online;
  const refresh = (): void => {
    if (refreshUnavailable) return;
    if (showingLimits) setLimitsRefresh((token) => token + 1);
    else setUsageRefresh((token) => token + 1);
  };
  return (
    <DialogShell
      ref={dialog}
      tabIndex={-1}
      className="usage-popup"
      backdropClassName="usage-popup-backdrop"
      bodyClassName="usage-popup-body"
      titleId={titleId}
      title="Usage"
      closeLabel="Close usage"
      onClose={onClose}
      onDismiss={onClose}
      headerActions={(
        <>
          <nav className="usage-popup-crumbs" aria-label="Usage filters">
            {(!showingLimits || hubs.length > 0) && (
              <>
                <span className="usage-popup-slash" aria-hidden="true">/</span>
                {showingLimits
                  ? <UsageFilterMenu label="Sources" value={sourceOptions.find(({ checked }) => checked)!.label} options={sourceOptions} onSelect={setSource} />
                  : <UsageFilterMenu label="Period" value={`Last ${days} days`} options={periodOptions}
                      onSelect={(id) => setPreferences((current) => ({ ...current, days: Number(id) as UsageRangeDays }))} />}
              </>
            )}
            <span className="usage-popup-slash" aria-hidden="true">/</span>
            <UsageFilterMenu label="Providers" value={providersLabel} options={providerOptions} multiple onSelect={toggleProvider} />
          </nav>
          <div className="usage-popup-controls">
            <div
              className="usage-popup-tabs"
              role="tablist"
              aria-label="Usage view"
              onKeyDown={(event) => {
                const current = TABS.findIndex(({ id }) => id === tab);
                const index = event.key === "ArrowRight" ? (current + 1) % TABS.length
                  : event.key === "ArrowLeft" ? (current + TABS.length - 1) % TABS.length
                    : event.key === "Home" ? 0
                      : event.key === "End" ? TABS.length - 1 : -1;
                if (index < 0) return;
                event.preventDefault();
                const next = TABS[index]!;
                selectTab(next.id);
                event.currentTarget.querySelector<HTMLElement>(`#${tabsId}-${next.id}`)?.focus({ preventScroll: true });
              }}
            >
              {TABS.map(({ id, label, key }) => (
                <TooltipButton
                  key={id}
                  id={`${tabsId}-${id}`}
                  role="tab"
                  tooltip={label}
                  shortcut={key}
                  aria-selected={tab === id}
                  aria-controls={`${tabsId}-panel`}
                  aria-keyshortcuts={key}
                  tabIndex={tab === id ? 0 : -1}
                  onClick={() => selectTab(id)}
                >
                  {label}
                </TooltipButton>
              ))}
            </div>
            <IconButton
              className="usage-popup-refresh"
              label={showingLimits ? "Refresh limits" : "Refresh usage"}
              aria-busy={busy}
              aria-disabled={refreshUnavailable}
              onClick={refresh}
            >
              <RefreshCw size={14} aria-hidden="true" />
            </IconButton>
          </div>
        </>
      )}
    >
      <div className="usage-popup-content" id={`${tabsId}-panel`} role="tabpanel" aria-labelledby={`${tabsId}-${tab}`}>
        {showingLimits
          ? UsageLimitsPanel
            ? <UsageLimitsPanel request={context.request} status={context.status} hiddenProviderIds={hiddenProviderIds} source={activeSource} refreshToken={limitsRefresh} onBusyChange={setBusy} />
            : <LoadingMark label="Loading limits" />
          : UsageOverview
            ? <UsageOverview metric={tab} days={days} hiddenProviderIds={hiddenProviderIds} refreshToken={usageRefresh} status={context.status} request={context.request} onBusyChange={setBusy} />
            : <LoadingMark label="Loading usage" />}
      </div>
    </DialogShell>
  );
}
