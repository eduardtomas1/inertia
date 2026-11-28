import { orchestrationNativeBoundarySchema } from "../../shared/orchestration-native-boundary";
import { orchestrationAttemptSchema, orchestrationRunSchema, type OrchestrationDomainEvent } from "../../shared/orchestration-v2";
import { isAgentTurnTerminalStatus } from "../../shared/turn-lifecycle";
import { OrchestrationConflict, type OrchestrationEvent, type ProjectionReader, type ProjectionWrite } from "./types";

export function projectNativeBoundary(event: Extract<OrchestrationDomainEvent, { type: "provider.native-boundary" }>,
  envelope: OrchestrationEvent, read: ProjectionReader): ProjectionWrite[] {
  const run = orchestrationRunSchema.parse(read("run", event.payload.runId)?.value);
  const attempt = orchestrationAttemptSchema.parse(read("attempt", event.payload.attemptId)?.value);
  const boundary = event.payload.boundary;
  if (run.threadId !== envelope.threadId || run.projectId !== envelope.projectId
    || run.attemptId !== attempt.id || attempt.runId !== run.id || attempt.threadId !== run.threadId
    || isAgentTurnTerminalStatus(run.status) || attempt.cleanup === "confirmed" || attempt.cleanup === "unconfirmed-released"
    || (attempt.nativeSessionId !== null && attempt.nativeSessionId !== boundary.nativeConversationId)) {
    throw new OrchestrationConflict("scope-conflict");
  }
  const prior = read("native-boundary", attempt.id);
  if (prior) {
    const previous = orchestrationNativeBoundarySchema.parse(prior.value);
    if (previous.nativeConversationId !== boundary.nativeConversationId
      || (previous.nativeSessionId !== null && boundary.nativeSessionId !== previous.nativeSessionId)
      || (previous.phase === "started" && boundary.phase === "settled" && previous.nativeTurnId !== null
        && previous.nativeTurnId !== boundary.nativeTurnId)) throw new OrchestrationConflict("revision-conflict");
  }
  return [
    { kind: "native-boundary", id: attempt.id, value: { ...boundary,
      runId: run.id, attemptId: attempt.id, threadId: run.threadId, projectId: run.projectId,
      providerInstanceId: run.providerInstanceId, workspaceKey: run.workspaceKey, updatedAt: envelope.createdAt } },
    { kind: "attempt", id: attempt.id, value: { ...attempt,
      nativeSessionId: boundary.nativeConversationId, nativeThreadId: boundary.nativeConversationId,
      nativeTurnId: boundary.nativeTurnId } },
  ];
}
