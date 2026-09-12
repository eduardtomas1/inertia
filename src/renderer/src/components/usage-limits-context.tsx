import { lazy, Suspense, useMemo, useState } from "react";
import { UsageLimitsContext as Context, type UsageLimitsContextValue } from "./usage-limits-state";
import type { UsageLimitsSnapshot } from "@shared/provider-usage-limits";

const UsageLimitsDialog = lazy(async () => ({ default: (await import("./UsageLimitsPanel")).UsageLimitsDialog }));
export function UsageLimitsProvider({ request, status, children }: Pick<UsageLimitsContextValue, "request" | "status"> & { children: React.ReactNode }): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<UsageLimitsSnapshot | null>(null);
  const [open, setOpen] = useState(false);
  const value = useMemo(() => ({ request, status, snapshot, setSnapshot, open: () => setOpen(true) }), [request, status, snapshot]);
  return <Context.Provider value={value}>{children}{open && <Suspense fallback={null}><UsageLimitsDialog onClose={() => setOpen(false)} /></Suspense>}</Context.Provider>;
}
