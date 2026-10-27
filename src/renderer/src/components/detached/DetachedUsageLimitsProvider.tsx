import { useMemo, useState, type ReactNode } from "react";
import type { UsageLimitsSnapshot } from "@shared/provider-usage-limits";

import { UsageLimitsContext, type UsageLimitsContextValue } from "../usage-limits-state";

export function DetachedUsageLimitsProvider({
  request,
  status,
  onOpen,
  children,
}: Pick<UsageLimitsContextValue, "request" | "status"> & {
  onOpen: () => void;
  children: ReactNode;
}): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<UsageLimitsSnapshot | null>(null);
  const value = useMemo<UsageLimitsContextValue>(() => ({
    request,
    status,
    snapshot,
    setSnapshot,
    open: onOpen,
  }), [onOpen, request, status, snapshot]);
  return <UsageLimitsContext.Provider value={value}>{children}</UsageLimitsContext.Provider>;
}
