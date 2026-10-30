import type { Conversation } from "../../shared/contracts";
import { modelSelectionSchema } from "../../shared/model-routing";
import type { OrchestrationEventStore } from "./event-store";

export function ensureOrchestrationThread(events: OrchestrationEventStore, conversation: Conversation, workspaceKey: string): void {
  if (events.projection("thread", conversation.id)) return;
  const event = { type: "thread.registered", payload: { id: conversation.id, projectId: conversation.projectId, workspaceKey,
    title: conversation.title, providerId: conversation.providerId, selection: modelSelectionSchema.parse(conversation.modelSelection),
    activeRunId: null, latestRunId: null, createdAt: conversation.createdAt, updatedAt: conversation.updatedAt } } as const;
  events.commit({ actorId: "runtime", commandId: `thread-register:${conversation.id}`, projectId: conversation.projectId,
    threadId: conversation.id, command: { type: "thread-register", threadId: conversation.id }, expectedRevision: 0,
    events: [event], result: null });
}
