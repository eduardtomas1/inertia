import type { ServerEvent, UsageRangeDays } from "@shared/contracts";

import type { ConnectionStatus } from "../../hooks/useInertiaConnection";
import type { CommandWithoutId } from "../../lib/runtimeCommands";

export type UsageOverviewMetric = "cost" | "tokens";

export interface UsageOverviewProps {
  metric: UsageOverviewMetric;
  days: UsageRangeDays;
  hiddenProviderIds: ReadonlySet<string>;
  refreshToken: number;
  status: ConnectionStatus;
  request(command: CommandWithoutId): Promise<ServerEvent>;
  onBusyChange?(busy: boolean): void;
}

export function UsageOverview({ metric }: UsageOverviewProps): React.JSX.Element {
  return <section className="usage-overview" data-metric={metric} aria-label={metric === "cost" ? "Cost" : "Tokens"} />;
}
