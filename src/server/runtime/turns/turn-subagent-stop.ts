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
    || (!trace.providerTaskId && !trace.providerToolUseId)
    || !trace.isLive
  ) return false;
  let accepted: Awaited<ReturnType<NonNullable<TurnProviderRuntime["stopSubagent"]>>> = false;
  try {
    accepted = await options.providers.stopSubagent(
      conversationId,
      trace.providerTaskId,
      { runId: active.turn.runId, turnId: active.turn.id },
      trace.providerToolUseId,
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
    || (trace.providerTaskId !== null && currentTrace.providerTaskId !== trace.providerTaskId)
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
  if (accepted === "queued") {
    // Claude has not issued the task id yet: the trace stays live until Claude
    // answers the Stop it sends once the task starts.
    const requested = options.store.requestSubagentStop(traceId, options.now());
    if (!requested) return false;
    if (requested.changed) {
      options.hooks.broadcast({ type: "agent.subagent.updated", trace: requested.trace });
    }
    return true;
  }
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

const BACKGROUND_UNAVAILABLE = "That Claude agent is no longer running in the foreground.";

/**
 * Moves one live foreground Claude agent to the background. The parent turn
 * keeps running; the agent reports back with a task notification later.
 */
export async function backgroundActiveSubagent(
  options: Pick<TurnSubagentStopOptions, "store" | "providers" | "activeForConversation">,
  conversationId: string,
  traceId: string,
): Promise<{ moved: boolean; error: string }> {
  const active = options.activeForConversation(conversationId);
  if (!active || !active.runState.acceptsProviderEvents() || !options.providers.backgroundSubagent) {
    return { moved: false, error: BACKGROUND_UNAVAILABLE };
  }
  let trace: SubagentTrace;
  try {
    trace = options.store.subagentTrace(traceId);
  } catch {
    return { moved: false, error: BACKGROUND_UNAVAILABLE };
  }
  if (
    trace.conversationId !== conversationId
    || trace.runId !== active.turn.runId
    || trace.turnId !== active.turn.id
    || trace.providerId !== "claude"
    || trace.taskKind !== "agent"
    || trace.background !== false
    || !trace.providerToolUseId
    || !trace.isLive
  ) return { moved: false, error: BACKGROUND_UNAVAILABLE };
  try {
    const result = await options.providers.backgroundSubagent(
      conversationId,
      trace.providerToolUseId,
      { runId: active.turn.runId, turnId: active.turn.id },
    );
    return { moved: result.moved, error: result.error ?? BACKGROUND_UNAVAILABLE };
  } catch {
    return { moved: false, error: BACKGROUND_UNAVAILABLE };
  }
}
