import { isAgentTurnTerminalStatus } from "../../../shared/contracts";
import type { RuntimeStore } from "../../database";
import {
  hasConsistentProviderTerminalOutcome,
  hasExactProviderRunIdentity,
  providerRunIdentity,
  type ProviderEvent,
  type ProviderRunResult,
} from "../../provider/contracts";
import type { ActiveTurn, TurnTerminalCause } from "./turn-controller-types";

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
