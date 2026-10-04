import type { SubagentTrace } from "../../../shared/contracts";
import type { RuntimeStore } from "../../database";
import type {
  ActiveTurn,
  TurnControllerHooks,
  TurnProviderRuntime,
} from "./turn-controller-types";

export interface TurnSubagentStopOptions {
  store: RuntimeStore;
  providers: TurnProviderRuntime;
  hooks: TurnControllerHooks;
  activeForConversation(conversationId: string): ActiveTurn | undefined;
  now(): string;
  observeSubagent(active: ActiveTurn, trace: SubagentTrace): boolean;
}

export async function stopActiveSubagent(
  options: TurnSubagentStopOptions,
  conversationId: string,
  traceId: string,
): Promise<boolean> {
  const active = options.activeForConversation(conversationId);
  if (
    !active
    || !active.runState.acceptsProviderEvents()
    || !options.providers.stopSubagent
  ) return false;
  let trace: SubagentTrace;
  try {
    trace = options.store.subagentTrace(traceId);
  } catch {
    return false;
  }
  if (
    trace.conversationId !== conversationId
    || trace.runId !== active.turn.runId
    || trace.turnId !== active.turn.id
    || trace.providerId !== "claude"
    || !trace.providerTaskId
    || !trace.isLive
  ) return false;
  let accepted = false;
  try {
    accepted = await options.providers.stopSubagent(
      conversationId,
      trace.providerTaskId,
      { runId: active.turn.runId, turnId: active.turn.id },
    );
  } catch {
  }
  let currentTrace: SubagentTrace;
  try {
    currentTrace = options.store.subagentTrace(traceId);
  } catch {
    return false;
  }
  if (
    currentTrace.conversationId !== trace.conversationId
    || currentTrace.runId !== trace.runId
    || currentTrace.turnId !== trace.turnId
    || currentTrace.providerId !== trace.providerId
    || currentTrace.providerTaskId !== trace.providerTaskId
  ) return false;
  if (!currentTrace.isLive) return currentTrace.status === "cancelled";
  if (!accepted) return false;
  const currentActive = options.activeForConversation(conversationId);
  if (
    currentActive !== active
    || !currentActive.runState.acceptsProviderEvents()
    || currentActive.turn.runId !== trace.runId
    || currentActive.turn.id !== trace.turnId
  ) return false;
  currentActive.subagentTelemetry?.flush();
  const stopped = options.store.acknowledgeSubagentStop(traceId, options.now());
  if (!stopped) return false;
  if (stopped?.changed) {
    options.hooks.broadcast({
      type: "agent.subagent.updated",
      trace: stopped.trace,
    });
    options.observeSubagent(currentActive, stopped.trace);
  }
  return true;
}
