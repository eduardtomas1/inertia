import type { ProviderId } from "./app";
import type { UsageMeasuredValue, UsageRuntimeValue } from "./usage-dashboard";

export interface DailyWorkProviderSummary {
  providerId: ProviderId;
  providerLabel: string;
  turnCount: number;
  activeTurnCount: number;
  runtime: UsageRuntimeValue;
  processedTokens: UsageMeasuredValue;
}

export interface DailyWorkConversationSummary {
  conversationId: string;
  projectId: string;
  projectName: string;
  title: string;
  providerIds: ProviderId[];
  createdToday: boolean;
  running: boolean;
  turnCount: number;
  activeTurnCount: number;
  lastActivityAt: string;
  runtime: UsageRuntimeValue;
  processedTokens: UsageMeasuredValue;
}

export interface DailyWorkDashboard {
  generatedAt: string;
  date: string;
  range: {
    fromInclusive: string;
    toExclusive: string;
    timeZone: string;
  };
  totals: {
    conversationCount: number;
    turnCount: number;
    activeTurnCount: number;
    runtime: UsageRuntimeValue;
    processedTokens: UsageMeasuredValue;
  };
  providers: DailyWorkProviderSummary[];
  conversations: DailyWorkConversationSummary[];
}
