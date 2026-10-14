import { useMemo, useRef, useState } from "react";
import { useLoadedSurface } from "../hooks/useLoadedSurface";
import { loadUsageLimitsDialog } from "./usageLimitsLoaders";
import { UsageLimitsContext as Context, type UsageLimitsContextValue } from "./usage-limits-state";
import type { UsageLimitsSnapshot } from "@shared/provider-usage-limits";

export function UsageLimitsProvider({ request, status, children }: Pick<UsageLimitsContextValue, "request" | "status"> & { children: React.ReactNode }): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<UsageLimitsSnapshot | null>(null);
  const [open, setOpen] = useState(false);
  const returnFocusTo = useRef<HTMLElement | null>(null);
  const UsageLimitsDialog = useLoadedSurface(loadUsageLimitsDialog, open);
  const value = useMemo(() => ({ request, status, snapshot, setSnapshot, open: (invoker?: HTMLElement | null) => { returnFocusTo.current = invoker ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null); setOpen(true); } }), [request, status, snapshot]);
  return <Context.Provider value={value}>{children}{open && UsageLimitsDialog && <UsageLimitsDialog returnFocusTo={returnFocusTo.current} onClose={() => setOpen(false)} />}</Context.Provider>;
}
