import type { AgentTurnUsageSnapshot, ChatAttachment, ModelSelection } from "../../../shared/contracts";
import { chatAttachmentKind } from "../../../shared/attachments";
import type { PreparedContextHandoff, ProviderBacking } from "../../../shared/orchestration-backings";
import type { ProviderBackgroundWorkProbe, ProviderBackgroundWorkSession, ProviderId } from "../../provider/contracts";
import { RuntimeRequestError, USER_CORRECTABLE_REQUEST } from "../../runtime-errors";
import type { AssembledTurnRequest, RestoredChatHistory } from "./request-context";

export class RestoredHistoryRejectedError extends RuntimeRequestError {
  constructor() {
    super(
      "This chat's earlier messages don't fit beside the references and instructions of this message. Remove some references and send it again.",
      USER_CORRECTABLE_REQUEST,
    );
  }
}

export class ContextHandoffBackgroundWorkError extends RuntimeRequestError {
  constructor() {
    super(
      "This provider session has no room for the chat's newer messages and still has background work running. Wait for that work to finish or stop it, then send again.",
      USER_CORRECTABLE_REQUEST,
    );
  }
}

export interface ModelContextLimits {
  modelWindow?: number | null;
  autoCompactThreshold?: number | null;
}

export interface ProviderContextLimitsProbe {
  modelContextLimits?(input: {
    providerId: ProviderId;
    harnessId: string;
    selection: ModelSelection;
    cwd: string;
  }): ModelContextLimits | null;
}

export type TurnContextProbes = ProviderBackgroundWorkProbe & ProviderContextLimitsProbe;

export interface HandoffContextUsage {
  usedTokens: number | null;
  maxTokens?: number;
  autoCompactThreshold?: number;
}

const positive = (value: number | null | undefined): number | undefined =>
  value !== null && value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : undefined;

export function handoffContextUsage(input: {
  sameNativeSession: boolean;
  sameSelection: boolean;
  previousUsage: HandoffContextUsage | null | undefined;
  knownModelWindow?: number | undefined;
}): HandoffContextUsage | null {
  if (!input.sameNativeSession || !input.previousUsage) return null;
  if (input.sameSelection) return input.previousUsage;
  const maxTokens = input.knownModelWindow ?? positive(input.previousUsage.maxTokens);
  return { usedTokens: input.previousUsage.usedTokens, ...(maxTokens === undefined ? {} : { maxTokens }) };
}

export function sameContextSelection(previous: ModelSelection, next: ModelSelection): boolean {
  return previous.modelId === next.modelId
    && previous.backendProfileId === next.backendProfileId
    && (previous.contextWindowOverride ?? null) === (next.contextWindowOverride ?? null);
}

export interface PortableHistoryBudgetInputs {
  imageCount: number;
  otherAttachmentCount: number;
  modelWindow?: number;
  reportedWindow?: number;
  autoCompactThreshold?: number;
  nativeUsedTokens?: number;
  estimateNativeOccupancy?: true;
}

export function portableHistoryBudgetInputs(input: {
  attachments: readonly ChatAttachment[];
  imageCount: number;
  configuredWindow: number | null;
  limits: ModelContextLimits | null;
  target: { usage: AgentTurnUsageSnapshot | null; sameSelection: boolean } | null;
}): PortableHistoryBudgetInputs {
  const knownModelWindow = positive(input.configuredWindow) ?? positive(input.limits?.modelWindow);
  const usage = input.target ? handoffContextUsage({
    sameNativeSession: true,
    sameSelection: input.target.sameSelection,
    previousUsage: input.target.usage
      ? { usedTokens: input.target.usage.usedTokens, ...(positive(input.target.usage.maxTokens) ? { maxTokens: input.target.usage.maxTokens! } : {}) }
      : null,
    knownModelWindow,
  }) : null;
  const thresholds = [usage?.autoCompactThreshold, positive(input.limits?.autoCompactThreshold)]
    .filter((value): value is number => value !== undefined);
  const usedTokens = usage?.usedTokens ?? undefined;
  return {
    imageCount: input.imageCount,
    otherAttachmentCount: input.attachments.filter(({ mimeType }) => chatAttachmentKind(mimeType) !== "image").length,
    ...(knownModelWindow === undefined ? {} : { modelWindow: knownModelWindow }),
    ...(usage?.maxTokens === undefined ? {} : { reportedWindow: usage.maxTokens }),
    ...(thresholds.length === 0 ? {} : { autoCompactThreshold: Math.min(...thresholds) }),
    ...(usedTokens === undefined ? input.target ? { estimateNativeOccupancy: true as const } : {} : { nativeUsedTokens: usedTokens }),
  };
}

export interface OfferedRestoredHistory {
  history: RestoredChatHistory;
  targetBackingId: string | null;
}

export function appendedContextHandoff(
  assembled: AssembledTurnRequest,
  offered: OfferedRestoredHistory | null,
): PreparedContextHandoff | undefined {
  if (!offered) return undefined;
  const { history, targetBackingId } = offered;
  if (history.itemIds !== undefined) {
    if (assembled.restoredItemIds === undefined) throw new RestoredHistoryRejectedError();
    return { itemIds: [...assembled.restoredItemIds], targetBackingId };
  }
  if (history.messageCount > 0 && (assembled.sessionRecovery?.restoredMessageCount ?? 0) === 0) {
    throw new RestoredHistoryRejectedError();
  }
  return undefined;
}

export function exhaustedBackingSession(backing: ProviderBacking): ProviderBackgroundWorkSession {
  return {
    conversationId: backing.threadId,
    providerId: backing.providerId as ProviderId,
    harnessId: backing.continuationIdentity.harnessId,
    nativeSessionId: backing.nativeSessionId,
  };
}
