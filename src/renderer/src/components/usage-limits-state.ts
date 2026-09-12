import { createContext, useContext } from "react";
import type { ServerEvent } from "@shared/contracts";
import type { UsageLimitsSnapshot } from "@shared/provider-usage-limits";
import type { CommandWithoutId } from "../lib/runtimeCommands";
import type { ConnectionStatus } from "../hooks/useInertiaConnection";

export type UsageLimitsContextValue = {
  request(command: CommandWithoutId): Promise<ServerEvent>;
  status: ConnectionStatus; snapshot: UsageLimitsSnapshot | null;
  setSnapshot(value: UsageLimitsSnapshot): void; open(): void;
};
export const UsageLimitsContext = createContext<UsageLimitsContextValue | null>(null);
export const useUsageLimitsContext = (): UsageLimitsContextValue | null => useContext(UsageLimitsContext);
