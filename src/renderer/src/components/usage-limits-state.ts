import { createContext, useContext } from "react";
import type { ServerEvent } from "@shared/contracts";
import type { UsageLimitsSnapshot } from "@shared/provider-usage-limits";
import type { CommandWithoutId } from "../lib/runtimeCommands";
import type { ConnectionStatus } from "../hooks/useInertiaConnection";

export type UsagePopupTab = "cost" | "tokens" | "limits";
export type UsagePopupOpener = (returnFocusTo?: HTMLElement | null, tab?: UsagePopupTab) => void;
export type UsageLimitsContextValue = {
  request(command: CommandWithoutId): Promise<ServerEvent>;
  status: ConnectionStatus; snapshot: UsageLimitsSnapshot | null;
  setSnapshot(value: UsageLimitsSnapshot): void; open: UsagePopupOpener;
};
export const UsageLimitsContext = createContext<UsageLimitsContextValue | null>(null);
export const useUsageLimitsContext = (): UsageLimitsContextValue | null => useContext(UsageLimitsContext);
export const UsagePopupOpenerContext = createContext<UsagePopupOpener | null>(null);
export const useUsagePopupOpener = (): UsagePopupOpener | null => useContext(UsagePopupOpenerContext);
export const UsagePopupOpenContext = createContext(false);
export const useUsagePopupOpen = (): boolean => useContext(UsagePopupOpenContext);
