import { nativeControlSchema, type NativeControlEvent } from "../../shared/orchestration-native-control";
import { forkLineageSchema } from "../../shared/orchestration-forks";
import { commandFingerprint } from "./json";
import { rollbackWrites } from "./history-projector";
import { OrchestrationConflict, type OrchestrationEvent, type ProjectionReader, type ProjectionWrite } from "./types";

export function nativeControlLockResources(control: Pick<ReturnType<typeof nativeControlSchema.parse>, "threadId" | "request">): string[] {
  return [...new Set([control.threadId, control.request.source.identity.conversationId,
    `native:${commandFingerprint({ instance: control.request.source.identity.providerInstanceId,
      conversation: control.request.source.nativeConversationId })}`])];
}

function locksFor(control: ReturnType<typeof nativeControlSchema.parse>) {
  return nativeControlLockResources(control).map((resourceId) => ({ resourceId,
    id: `native-lock:${commandFingerprint({ operationId: control.id, resourceId })}` }));
}

function rollbackStarted(control: ReturnType<typeof nativeControlSchema.parse>, envelope: OrchestrationEvent,
  read: ProjectionReader): void {
  const source = control.request.source;
  const fork = read("fork", envelope.threadId)?.value as { transfer?: string } | undefined;
  if (control.threadId !== envelope.threadId || control.projectId !== envelope.projectId
    || control.id !== control.request.operationId || source.identity.conversationId !== control.threadId
    || source.identity.projectId !== control.projectId || control.state !== "running" || control.backing !== null
    || control.reason !== null || control.sourceWorkspaceKey !== control.targetWorkspaceKey
    || fork?.transfer === "pending" || read("native-control", control.id) || read("rolled-back", control.id)
    || (control.request.boundary.kind === "turn") !== (control.rollback?.retainedTurnId !== null)) {
    throw new OrchestrationConflict("scope-conflict");
  }
}

function settledRollback(control: ReturnType<typeof nativeControlSchema.parse>, event: Extract<NativeControlEvent,
  { type: "native.control-settled" }>, envelope: OrchestrationEvent, read: ProjectionReader): ProjectionWrite[] {
  const { state, backing } = event.payload;
  if (state === "uncertain") return [];
  const source = control.request.source;
  return rollbackWrites(envelope, read, control.id, control.rollback!, state === "completed" ? {
    transfer: "native", providerInstanceId: source.identity.providerInstanceId, workspaceKey: control.sourceWorkspaceKey,
    nativeConversationId: backing!.nativeConversationId, physicalHeadId: backing!.persistedHeadId,
    effectiveHeadId: backing!.headId, continuation: backing!.continuation ?? null,
    continuationState: backing!.continuation ? "pending" : "none", reason: null,
  } : { transfer: "portable", providerInstanceId: null, workspaceKey: null, nativeConversationId: null,
    physicalHeadId: null, effectiveHeadId: null, continuation: null, continuationState: "none",
    reason: event.payload.reason ?? "native-rollback-unavailable" });
}

export function projectNativeControl(event: NativeControlEvent, envelope: OrchestrationEvent,
  read: ProjectionReader): ProjectionWrite[] {
  if (event.type === "native.control-started" && event.payload.request.kind === "rollback") {
    rollbackStarted(event.payload, envelope, read);
    return startedWrites(event.payload, read);
  }
  if (event.type === "native.control-settled") {
    const prior = read("native-control", event.payload.id);
    const control = prior ? nativeControlSchema.parse(prior.value) : null;
    if (control?.request.kind === "rollback") {
      if (prior!.threadId !== envelope.threadId) throw new OrchestrationConflict("scope-conflict");
      const { state, backing } = event.payload;
      if ((state === "completed") !== (backing !== null)
        || (backing?.continuation && backing.continuation.nativeConversationId !== backing.nativeConversationId)) {
        throw new OrchestrationConflict("scope-conflict");
      }
      return [...settledWrites(control, event, envelope, read), ...settledRollback(control, event, envelope, read)];
    }
  }
  const forkRow = read("fork", envelope.threadId);
  if (!forkRow || !read("fork-sealed", envelope.threadId)) throw new OrchestrationConflict("scope-conflict");
  const fork = forkLineageSchema.parse(forkRow.value);
  if (fork.transfer !== "pending") throw new OrchestrationConflict("revision-conflict");
  if (event.type === "fork.portable-selected") {
    const control = read("native-control-current", envelope.threadId)?.value as { state: string } | undefined;
    if (control?.state === "running" || control?.state === "uncertain") throw new OrchestrationConflict("cleanup-pending");
    return [{ kind: "fork", id: fork.threadId, value: { ...fork, transfer: "portable" } }];
  }
  if (event.type === "native.control-started") {
    const control = event.payload;
    const source = control.request.source;
    if (control.threadId !== envelope.threadId || control.projectId !== envelope.projectId
      || control.id !== control.request.operationId || control.request.kind !== "fork"
      || control.request.targetConversationId !== control.threadId
      || source.identity.conversationId !== fork.parentThreadId || source.identity.projectId !== control.projectId
      || control.state !== "running" || control.backing !== null || control.reason !== null
      || source.identity.providerInstanceId !== fork.nativeBoundary?.providerInstanceId
      || source.nativeConversationId !== fork.nativeBoundary.nativeConversationId
      || (source.nativeSessionId ?? null) !== fork.nativeBoundary.nativeSessionId
      || control.request.boundary.kind !== "turn" || control.request.boundary.nativeTurnId !== fork.nativeBoundary.nativeTurnId
      || control.sourceWorkspaceKey !== fork.sourceWorkspaceKey
      || read("native-control", control.id)) throw new OrchestrationConflict("scope-conflict");
    return startedWrites(control, read);
  }
  const row = read("native-control", event.payload.id);
  if (!row || row.threadId !== envelope.threadId) throw new OrchestrationConflict("scope-conflict");
  const control = nativeControlSchema.parse(row.value);
  const { state, backing } = event.payload;
  if ((state === "completed") !== (backing !== null)
    || backing && backing.nativeConversationId === control.request.source.nativeConversationId) {
    throw new OrchestrationConflict("scope-conflict");
  }
  const writes = settledWrites(control, event, envelope, read);
  if (state !== "uncertain") writes.push(
    { kind: "fork", id: fork.threadId, value: { ...fork, transfer: state === "completed" ? "native" : "portable" } },
  );
  if (state === "completed") writes.push({ kind: "fork-native-backing", id: fork.threadId,
    value: { ...control, ...event.payload, updatedAt: envelope.createdAt } });
  return writes;
}

function startedWrites(control: ReturnType<typeof nativeControlSchema.parse>, read: ProjectionReader): ProjectionWrite[] {
  const locks = locksFor(control);
  if (locks.some(({ id }) => read("native-control-lock", id))) throw new OrchestrationConflict("cleanup-pending");
  return [{ kind: "native-control", id: control.id, value: control },
    { kind: "native-control-current", id: control.threadId, value: { operationId: control.id, state: control.state } },
    ...locks.map(({ id, resourceId }) => ({ kind: "native-control-lock", id, value: { operationId: control.id, resourceId, locked: true } }))];
}

function settledWrites(control: ReturnType<typeof nativeControlSchema.parse>, event: Extract<NativeControlEvent,
  { type: "native.control-settled" }>, envelope: OrchestrationEvent, read: ProjectionReader): ProjectionWrite[] {
  if (control.state !== "running" && control.state !== "uncertain") throw new OrchestrationConflict("revision-conflict");
  const locks = locksFor(control);
  if (locks.some(({ id }) => {
    const lock = read("native-control-lock", id)?.value as { operationId: string; locked: boolean } | undefined;
    return !lock?.locked || lock.operationId !== control.id;
  })) throw new OrchestrationConflict("scope-conflict");
  const { state } = event.payload;
  const writes: ProjectionWrite[] = [{ kind: "native-control", id: control.id,
    value: { ...control, ...event.payload, updatedAt: envelope.createdAt } },
    { kind: "native-control-current", id: control.threadId, value: { operationId: control.id, state } }];
  if (state !== "uncertain") writes.push(...locks.map(({ id, resourceId }) => ({ kind: "native-control-lock", id,
    value: { operationId: control.id, resourceId, locked: false } })));
  return writes;
}
