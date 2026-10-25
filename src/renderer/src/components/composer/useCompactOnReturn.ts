import { useCallback, useEffect, useState } from "react";

import type {
  ConversationLatestTurnSummary,
  ModelBackendProfileView,
  ModelSelection,
  ProviderInfo,
  ThreadUsageSnapshot,
} from "@shared/contracts";
import {
  compactOnReturnEligibility,
  compactOnReturnOffer,
  type CompactOnReturnSetting,
  type ConversationCompactionState,
  type PromptCacheFacts,
} from "@shared/compact-on-return";
import { compactOnReturnRefusedAfter, compactOnReturnRoute, compactOnReturnTooltip } from "../../utils/compactOnReturn";
import { parseCompactComposerCommand } from "../../utils/composerCommands";
import { useDuoJudgeNotices } from "../DuoJudgeNoticeContext";
import type { ComposerCompactOnReturnAction } from "./ComposerSendActions";
import type { ComposerCompactNotice } from "./useComposerCompaction";

const CLOCK_SETTLE_MS = 25;
const COMPACTING_BEFORE_SENDING_NOTICE: ComposerCompactNotice = { kind: "working", message: "Compacting before sending…" };
const COMPACTING_CONTEXT_NOTICE: ComposerCompactNotice = { kind: "working", message: "Compacting context…" };

export type CompactOnReturnMode = "compact" | "full";

export interface CompactOnReturnController {
  offered: boolean;
  active: boolean;
  mode: CompactOnReturnMode;
  tooltip: string | null;
  compacting: ConversationCompactionState | null;
  compactingOnReturn: boolean;
  failure: string | null;
  action: ComposerCompactOnReturnAction | null;
  promptCache: Pick<PromptCacheFacts, "lastRequestStartedAt" | "lifetimeMs" | "source"> | null;
  notice: (manual: ComposerCompactNotice | null) => ComposerCompactNotice | null;
  toggle: () => void;
  reset: () => void;
  begin: (conversationId: string, compactAndSend: boolean) => void;
  end: (conversationId: string) => void;
  fail: (conversationId: string, message: string) => void;
}

function useExpiryClock(expiresAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (expiresAt === null) return;
    const timer = window.setTimeout(
      () => setNow(Date.now()),
      Math.max(0, expiresAt - Date.now()) + CLOCK_SETTLE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [expiresAt]);
  return now;
}

export function useCompactOnReturn(options: {
  conversationId: string;
  selection: ModelSelection;
  profile: ModelBackendProfileView | undefined;
  provider: ProviderInfo | undefined;
  usage: ThreadUsageSnapshot | null;
  compaction: ConversationCompactionState | null;
  setting: CompactOnReturnSetting;
  available: boolean;
  providerHandoffPending: boolean;
  latestTurn: Pick<ConversationLatestTurnSummary, "status" | "usageLimited" | "failureKind"> | null;
  message: string;
  running: boolean;
  sendable: boolean;
}): CompactOnReturnController {
  const { conversationId, selection, profile, provider, setting, running, sendable } = options;
  const usage = options.usage?.conversationId === conversationId ? options.usage : null;
  const [fullHistoryFor, setFullHistoryFor] = useState<string | null>(null);
  const [sendingFor, setSendingFor] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ conversationId: string; message: string } | null>(null);
  const duoJudgeChat = useDuoJudgeNotices()?.comparisonForConversation(conversationId)?.role === "judge";
  const available = options.available
    && !duoJudgeChat
    && !options.providerHandoffPending
    && !compactOnReturnRefusedAfter(options.latestTurn)
    && parseCompactComposerCommand(options.message) === null;
  const route = compactOnReturnRoute({ selection, profile, provider });
  const eligibility = route ? compactOnReturnEligibility(route) : null;
  const eligible = eligibility?.eligible === true;
  const lifetimeMs = usage?.promptCache?.lifetimeMs ?? eligibility?.lifetimeMs ?? null;
  const lastRequestStartedAt = usage?.promptCache?.lastRequestStartedAt ?? null;
  const startedAt = lastRequestStartedAt === null ? Number.NaN : Date.parse(lastRequestStartedAt);
  const expiresAt = eligible && lifetimeMs !== null && Number.isFinite(startedAt)
    ? startedAt + lifetimeMs
    : null;
  const now = useExpiryClock(expiresAt);
  const compacting = options.compaction?.state === "compacting" ? options.compaction : null;
  const offer = compactOnReturnOffer({
    eligible: eligible && available,
    lifetimeMs,
    usedTokens: usage?.usedTokens ?? null,
    lastRequestStartedAt,
    now,
    setting,
    compactionState: compacting ? "compacting" : "idle",
    turnActive: running,
  });
  const offered = offer.offer && sendable;
  const mode: CompactOnReturnMode = fullHistoryFor === conversationId ? "full" : "compact";
  const tooltip = offered && offer.usedTokens !== null ? compactOnReturnTooltip(offer.usedTokens) : null;
  const compactingOnReturn = sendingFor === conversationId || compacting?.trigger === "on-return";
  const toggle = useCallback(() => {
    setFullHistoryFor((current) => current === conversationId ? null : conversationId);
  }, [conversationId]);
  const reset = useCallback(() => setFullHistoryFor(null), []);
  const begin = useCallback((owner: string, compactAndSend: boolean) => {
    setFailure(null);
    if (compactAndSend) setSendingFor(owner);
  }, []);
  const end = useCallback((owner: string) => {
    setSendingFor((current) => current === owner ? null : current);
  }, []);
  const fail = useCallback((owner: string, message: string) => {
    setFailure({ conversationId: owner, message });
  }, []);
  return {
    offered,
    active: offered && mode === "compact",
    mode,
    tooltip,
    compacting,
    compactingOnReturn,
    failure: failure?.conversationId === conversationId ? failure.message : null,
    action: tooltip ? { mode, tooltip, onToggle: toggle, toggleVisible: failure?.conversationId !== conversationId } : null,
    promptCache: eligible && lifetimeMs !== null && lastRequestStartedAt !== null
      ? { lastRequestStartedAt, lifetimeMs, source: usage?.promptCache?.source ?? "assumed" }
      : null,
    notice: (manual) => compactingOnReturn
      ? COMPACTING_BEFORE_SENDING_NOTICE
      : compacting && !manual ? COMPACTING_CONTEXT_NOTICE : manual,
    toggle,
    reset,
    begin,
    end,
    fail,
  };
}
