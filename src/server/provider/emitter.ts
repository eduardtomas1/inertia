import type {
  ProviderActivityEvent,
  ProviderActivityKind,
  ProviderActivityPhase,
  ProviderEvent,
  ProviderEventBase,
  ProviderGoalSnapshot,
  ProviderId,
  ProviderMetadataEvent,
  ProviderRunCallbacks,
  ProviderRunStatus,
  ProviderSubagentEvent,
  ProviderUsageEvent,
} from "./contracts";
import type {
  AgentApprovalDecision,
  AgentApprovalRequest,
  AgentInputRequest,
  AgentPlanStep,
} from "./interactions";
import type {
  AgentHarnessCallbacks,
  AgentHarnessEvent,
} from "./agent-harness";
import { contractActivityPhase } from "./activity-lifecycle";

type AgentHarnessCapabilityObservationEvent = Extract<
  AgentHarnessEvent,
  { type: "capability-observation" }
>;

function safeCallback(callback: (() => void) | undefined): void {
  if (!callback) return;
  try {
    callback();
  } catch {
    // Provider execution must not be interrupted by a UI callback.
  }
}

export interface ProviderEmitter {
  close: () => void;
  matches: (identity: ProviderEventBase) => boolean;
  event: (event: ProviderEvent) => void;
  text: (text: string) => void;
  textSnapshot: (itemId: string, text: string) => void;
  activity: (
    kind: ProviderActivityKind,
    phase: ProviderActivityPhase,
    label: string,
    detail?: Pick<ProviderActivityEvent, "activityId" | "detail">,
  ) => void;
  status: (
    status: ProviderRunStatus,
    message?: string,
    providerState?: string,
  ) => void;
  session: (sessionId: string) => void;
  goalUpdated: (sessionId: string, goal: ProviderGoalSnapshot) => void;
  goalCleared: (sessionId: string) => void;
  approval: (request: AgentApprovalRequest) => void;
  approvalResolved: (requestId: string, decision: AgentApprovalDecision | "cancelled") => void;
  input: (request: AgentInputRequest) => void;
  inputResolved: (requestId: string) => void;
  plan: (explanation: string | null, steps: AgentPlanStep[]) => void;
  reasoning: (text: string) => void;
  usage: (usage: ProviderUsageEvent["usage"]) => void;
  metadata: (metadata: ProviderMetadataEvent["metadata"], source: ProviderMetadataEvent["source"], complete: boolean) => void;
  subagent: (event: Omit<ProviderSubagentEvent, "providerId" | "conversationId" | "runId" | "turnId" | "type">) => void;
}

export interface ProviderEmitterPolicy {
  accept(event: ProviderEvent): boolean;
  reject(event: ProviderEvent): void;
}

export function createProviderEmitter(
  providerId: ProviderId,
  conversationId: string,
  callbacks: ProviderRunCallbacks,
  runId: string,
  turnId: string,
  policy?: ProviderEmitterPolicy,
): ProviderEmitter {
  const base = { providerId, conversationId, runId, turnId };
  let accepting = true;
  const matches = (identity: ProviderEventBase): boolean =>
    identity.providerId === providerId
    && identity.conversationId === conversationId
    && identity.runId === runId
    && identity.turnId === turnId;
  const event = (providerEvent: ProviderEvent): void => {
    if (!accepting || !matches(providerEvent)) return;
    if (policy && !policy.accept(providerEvent)) {
      policy.reject(providerEvent);
      return;
    }
    safeCallback(() => callbacks.onEvent?.(providerEvent));
    switch (providerEvent.type) {
      case "text":
        safeCallback(() => callbacks.onText?.(providerEvent));
        break;
      case "text-snapshot":
        safeCallback(() => callbacks.onTextSnapshot?.(providerEvent));
        break;
      case "activity":
        safeCallback(() => callbacks.onActivity?.(providerEvent));
        break;
      case "status":
        safeCallback(() => callbacks.onStatus?.(providerEvent));
        break;
      case "session":
        safeCallback(() => callbacks.onSession?.(providerEvent));
        break;
      case "approval":
        safeCallback(() => callbacks.onApproval?.(providerEvent));
        break;
      case "approval-resolved":
        safeCallback(() => callbacks.onApprovalResolved?.(providerEvent));
        break;
      case "input":
        safeCallback(() => callbacks.onInput?.(providerEvent));
        break;
      case "input-resolved":
        safeCallback(() => callbacks.onInputResolved?.(providerEvent));
        break;
      case "plan":
        safeCallback(() => callbacks.onPlan?.(providerEvent));
        break;
      case "goal-updated":
        safeCallback(() => callbacks.onGoalUpdated?.(providerEvent));
        break;
      case "goal-cleared":
        safeCallback(() => callbacks.onGoalCleared?.(providerEvent));
        break;
      case "reasoning-summary":
        safeCallback(() => callbacks.onReasoning?.(providerEvent));
        break;
      case "usage":
        safeCallback(() => callbacks.onUsage?.(providerEvent));
        break;
      case "metadata":
        safeCallback(() => callbacks.onMetadata?.(providerEvent));
        break;
      case "subagent":
        safeCallback(() => callbacks.onSubagent?.(providerEvent));
        break;
    }
  };

  return {
    close: () => { accepting = false; },
    matches,
    event,
    text: (text) => event({ ...base, type: "text", text }),
    textSnapshot: (itemId, text) => event({
      ...base,
      type: "text-snapshot",
      itemId,
      text,
    }),
    activity: (kind, phase, label, detail = {}) => {
      const { activityId: rawActivityId, ...safeDetail } = detail;
      const activityId = rawActivityId?.trim() || undefined;
      event({
        ...base,
        type: "activity",
        kind,
        phase: contractActivityPhase(phase, activityId),
        label,
        ...safeDetail,
        ...(activityId ? { activityId } : {}),
      });
    },
    status: (status, message, providerState) => event({
      ...base,
      type: "status",
      status,
      ...(message ? { message } : {}),
      ...(providerState ? { providerState } : {}),
    }),
    session: (sessionId) => event({ ...base, type: "session", sessionId }),
    goalUpdated: (sessionId, goal) => event({
      ...base,
      type: "goal-updated",
      sessionId,
      goal,
    }),
    goalCleared: (sessionId) => event({
      ...base,
      type: "goal-cleared",
      sessionId,
    }),
    approval: (request) => event({ ...base, type: "approval", request }),
    approvalResolved: (requestId, decision) => event({ ...base, type: "approval-resolved", requestId, decision }),
    input: (request) => event({ ...base, type: "input", request }),
    inputResolved: (requestId) => event({ ...base, type: "input-resolved", requestId }),
    plan: (explanation, steps) => event({ ...base, type: "plan", explanation, steps }),
    reasoning: (text) => event({ ...base, type: "reasoning-summary", text }),
    usage: (usage) => event({ ...base, type: "usage", usage }),
    metadata: (metadata, source, complete) => event({ ...base, type: "metadata", metadata, source, complete }),
    subagent: (subagent) => event({ ...subagent, ...base, type: "subagent" }),
  };
}

/**
 * Compatibility boundary for the legacy provider callback surface. Harnesses
 * keep provider-specific events in a typed extension envelope; the runtime can
 * continue consuming its existing callbacks until that transport contract is
 * migrated independently.
 */
export function providerCallbacksFromHarness(
  emitter: ProviderEmitter,
  observeCapability?: (
    event: AgentHarnessCapabilityObservationEvent,
  ) => void,
): AgentHarnessCallbacks {
  return {
    onEvent: (event) => {
      if (event.type === "capability-observation") {
        if (emitter.matches(event)) observeCapability?.(event);
        return;
      }
      if (event.type !== "extension") {
        emitter.event(event);
        return;
      }
      if (!emitter.matches(event)) return;
      emitInteractiveExtension(emitter, event);
    },
  };
}

function emitInteractiveExtension(
  emitter: ProviderEmitter,
  envelope: Extract<AgentHarnessEvent, { type: "extension" }>,
): void {
  const event = envelope.event;
  switch (event.type) {
    case "approval":
      emitter.approval(event.request);
      break;
    case "approval-resolved":
      emitter.approvalResolved(event.requestId, event.decision);
      break;
    case "input":
      emitter.input(event.request);
      break;
    case "input-resolved":
      emitter.inputResolved(event.requestId);
      break;
    case "plan":
      emitter.plan(event.explanation, event.steps);
      break;
    case "reasoning-summary":
      emitter.reasoning(event.text);
      break;
    case "usage":
      emitter.usage(event.usage);
      break;
    case "metadata":
      emitter.metadata(event.metadata, event.source, event.complete);
      break;
  }
}
