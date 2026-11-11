import { useCallback, useMemo, useRef, useState } from "react";
import { useLoadedSurface } from "../hooks/useLoadedSurface";
import { loadUsagePopup, preloadUsagePopup } from "./usageLimitsLoaders";
import { UsageLimitsContext as Context, UsagePopupOpenContext, UsagePopupOpenerContext, type UsageLimitsContextValue, type UsagePopupOpener, type UsagePopupTab } from "./usage-limits-state";
import type { UsageLimitsSnapshot } from "@shared/provider-usage-limits";

type PopupRequest = { tab: UsagePopupTab | null; revision: number };

export function UsageLimitsProvider({ request, status, children }: Pick<UsageLimitsContextValue, "request" | "status"> & { children: React.ReactNode }): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<UsageLimitsSnapshot | null>(null);
  const [popup, setPopup] = useState<PopupRequest | null>(null);
  const returnFocusTo = useRef<HTMLElement | null>(null);
  const showing = useRef(false);
  const UsagePopup = useLoadedSurface(loadUsagePopup, popup !== null);
  const open = useCallback<UsagePopupOpener>((invoker, tab) => {
    preloadUsagePopup();
    if (!showing.current) returnFocusTo.current = invoker ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    showing.current = true;
    setPopup((current) => ({ tab: tab ?? null, revision: (current?.revision ?? 0) + 1 }));
  }, []);
  const close = useCallback(() => { showing.current = false; setPopup(null); }, []);
  const value = useMemo(() => ({ request, status, snapshot, setSnapshot, open }), [request, status, snapshot, open]);
  return <UsagePopupOpenerContext.Provider value={open}><UsagePopupOpenContext.Provider value={popup !== null}><Context.Provider value={value}>{children}{popup && UsagePopup && <UsagePopup requestedTab={popup.tab} requestRevision={popup.revision} returnFocusTo={returnFocusTo.current} onClose={close} />}</Context.Provider></UsagePopupOpenContext.Provider></UsagePopupOpenerContext.Provider>;
}
