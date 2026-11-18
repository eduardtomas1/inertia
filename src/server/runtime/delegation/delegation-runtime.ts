import type {
  AgentApprovalRequest,
  AgentInputRequest,
  AgentTurn,
  RuntimeMutationEvent,
} from "../../../shared/contracts";
import type { DelegatedCompletionAttribution } from "../../../shared/orchestration-delegation";
import type { RuntimeStore } from "../../database";
import type { DelegatedQueueHooks } from "../queued-message-runtime";
import type { TurnController } from "../turns/turn-controller";
import { DelegationTaskService, type DelegationQueue } from "./task-service";

export interface DelegationRuntimeDependencies {
  store: RuntimeStore;
  turns: TurnController;
  pendingApprovals: ReadonlyMap<string, AgentApprovalRequest>;
  pendingInputs: ReadonlyMap<string, AgentInputRequest>;
  queue(): DelegationQueue | undefined;
  broadcast(event: RuntimeMutationEvent): void;
  pollMs?: number;
}

export interface DelegationRuntime {
  readonly service: DelegationTaskService;
  readonly queueHooks: DelegatedQueueHooks;
  observe(event: RuntimeMutationEvent): void;
  onTurnSettled(turn: AgentTurn): Promise<void>;
  automaticWakesTurnedOff(trigger: string): Promise<void>;
  recover(): Promise<void>;
}

const WAIT_SIGNAL_EVENTS = new Set<RuntimeMutationEvent["type"]>([
  "agent.started", "agent.approval.requested", "agent.approval.resolved", "agent.input.requested", "agent.input.resolved",
]);

export function createDelegationRuntime(dependencies: DelegationRuntimeDependencies): DelegationRuntime {
  const { store } = dependencies;
  const service = new DelegationTaskService({
    store,
    turns: dependencies.turns,
    interactions: { approvals: dependencies.pendingApprovals, inputs: dependencies.pendingInputs },
    queue: dependencies.queue,
    changed: (conversationIds) => {
      for (const conversationId of conversationIds) {
        dependencies.broadcast({ type: "conversation.detail.invalidated", conversationId });
      }
    },
    automaticWakes: () => store.appSettings().delegationAutomaticWakes,
    ...(dependencies.pollMs === undefined ? {} : { pollMs: dependencies.pollMs }),
  });
  const lane = (attribution: DelegatedCompletionAttribution, command: () => unknown): void => {
    void store.orchestration.lanes.run(attribution.parentConversationId, command)
      .then(() => {
        dependencies.broadcast({ type: "conversation.detail.invalidated", conversationId: attribution.parentConversationId });
        service.signals.notify();
      }, () => undefined);
  };
  const pendingInteraction = (conversationId: string): boolean =>
    [...dependencies.pendingApprovals.values(), ...dependencies.pendingInputs.values()]
      .some((request) => request.conversationId === conversationId);
  const armed = (attribution: DelegatedCompletionAttribution): boolean => attribution.taskIds.every((taskId) =>
    store.orchestration.delegation.get(taskId)?.wakeArmed === true);
  const queueHooks: DelegatedQueueHooks = {
    automatic: (_conversationId, attribution) => service.automaticWakes() || !armed(attribution),
    steerable: (conversationId, attribution) => service.automaticWakes() && !pendingInteraction(conversationId)
      && attribution.taskIds.every((taskId) => {
        const task = store.orchestration.delegation.get(taskId);
        return task?.completionWake === "always" && task.wakeArmed;
      }),
    content: (attribution) => store.orchestration.delegation.deliveryText(attribution.parentConversationId, attribution.generation),
    dispatched: (attribution, turnId) => lane(attribution, () =>
      store.orchestration.delegation.markDispatched(attribution.parentConversationId, attribution.generation, turnId)),
    steered: (attribution, turnId) => lane(attribution, () =>
      store.orchestration.delegation.deliverySteered(attribution.parentConversationId, attribution.generation, turnId)),
    dismiss: async (entry, requestId) => {
      await service.dismiss(entry.conversationId, entry.delegatedCompletion.taskIds, requestId);
    },
  };
  const deferNotify = (): void => {
    if (service.signals.size > 0) setImmediate(() => service.signals.notify());
  };
  return {
    service,
    queueHooks,
    observe(event) {
      if (WAIT_SIGNAL_EVENTS.has(event.type)) {
        deferNotify();
      } else if (event.type === "agent.subagent.updated") {
        if (!event.trace.isLive && service.isDelegatedChild(event.trace.conversationId)) {
          void service.onChildEvidence(event.trace.conversationId).catch(() => undefined);
        } else {
          deferNotify();
        }
      } else if (event.type === "conversation.shell.updated" && event.conversation.archivedAt !== null) {
        void service.onArchived(event.conversation.id).catch(() => undefined);
      }
    },
    async onTurnSettled(turn) {
      await service.onTurnSettled(turn);
    },
    automaticWakesTurnedOff: (trigger) => service.automaticWakesTurnedOff(trigger),
    async recover() {
      await service.recover().catch((error: unknown) => {
        console.warn("Delegated task recovery did not finish.", error instanceof Error ? error.message : "unknown error");
      });
    },
  };
}
