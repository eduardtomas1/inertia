import { isAgentTurnTerminalStatus, type AgentTurnTerminalStatus } from "../../../shared/contracts";
import { orchestrationProviderStopReasonSchema } from "../../../shared/orchestration-v2";
import type { RuntimeStore } from "../../database";
import {
  hasConsistentProviderTerminalOutcome,
  hasExactProviderRunIdentity,
  providerRunIdentity,
  type ProviderEvent,
  type ProviderRunResult,
} from "../../provider/contracts";
import type { ActiveTurn, TurnTerminalCause } from "./turn-controller-types";

/**
 * A dropped prompt arrives on the provider's terminal status (`ProviderStatusEvent.promptDropped`). It is kept even
 * after a Stop asked for the turn's end, when the turn no longer takes provider events: the harness emits that status
 * before its result, and a Stop settles the turn only after the provider run settled, so the settlement still sees
 * it. It is kept for the exact run and attempt only, and never once the turn is settled.
 */
export function observeProviderPromptDropped(active: ActiveTurn, event: ProviderEvent, attemptId?: string | null): void {
  if (event.type !== "status" || event.promptDropped !== true
    || (event.status !== "failed" && event.status !== "cancelled") || active.runState.isTerminal()
    || event.providerId !== active.turn.providerId || event.conversationId !== active.conversation.id
    || event.runId !== active.turn.runId || event.turnId !== active.turn.id
    || (attemptId && attemptId !== active.attemptId)) return;
  active.providerPromptDropped = true;
}

/**
 * Keeps the provider's own reason for stopping a run that did not fail (T3 `turn.terminal.reason`: a Codex hook
 * stop, whether Codex ends the turn completed or interrupted). Anything but bounded text is ignored. Called when
 * the provider's result arrives: a Stop asked for before it decides the run's end (the run settles cancelled; T3
 * then shows the Stop's own reason), so the reason is dropped. A Stop that comes after the result keeps it, since
 * the run still settles as the provider ended it.
 */
export function recordProviderStopReason(active: ActiveTurn, result: ProviderRunResult): void {
  const reason = orchestrationProviderStopReasonSchema.safeParse(result.providerStopReason);
  if (reason.success && result.status !== "failed" && active.deferredSettlement?.status !== "cancelled") {
    active.providerStopReason = reason.data;
  }
}

/** The provider stop reason a settling run records and shows: only a completed or cancelled run has one. */
export function settledProviderStopReason(active: ActiveTurn, status: AgentTurnTerminalStatus): string | undefined {
  return status === "completed" || status === "cancelled" ? active.providerStopReason : undefined;
}

export function providerEventMatchesActiveTurn(
  store: RuntimeStore,
  active: ActiveTurn,
  event: Pick<
    ProviderEvent,
    "providerId" | "conversationId" | "runId" | "turnId"
  >,
): boolean {
  if (
    !active.runState.acceptsProviderEvents()
    || event.providerId !== active.turn.providerId
    || event.conversationId !== active.conversation.id
    || event.runId !== active.turn.runId
    || event.turnId !== active.turn.id
  ) return false;
  try {
    const authoritative = store.assertAgentTurnIdentity(
      active.conversation.id,
      active.turn.runId,
      active.turn.id,
    );
    return !isAgentTurnTerminalStatus(authoritative.status);
  } catch {
    return false;
  }
}

export function providerTerminalResultMatchesActiveTurn(
  active: ActiveTurn,
  result: ProviderRunResult,
): boolean {
  return hasExactProviderRunIdentity(
    result,
    providerRunIdentity(active.providerInput),
  ) && hasConsistentProviderTerminalOutcome(result);
}

export function providerFailureCause(
  result: ProviderRunResult,
): TurnTerminalCause {
  if (result.failure?.reason === "goal-continuation-timeout") {
    return "goal-continuation-timeout";
  }
  const transportFailure = result.failure
    ? result.failure.reason !== "codex-error"
      && result.failure.reason !== "provider-error"
    : result.exitCode !== null || result.signal !== null;
  return transportFailure ? "provider-process-exit" : "provider-error";
}
