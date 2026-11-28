import { forkLineageSchema, type OrchestrationForkEvent } from "../../shared/orchestration-forks";
import { OrchestrationConflict, type OrchestrationEvent, type ProjectionReader, type ProjectionWrite } from "./types";
import { durableJson } from "./json";

export function projectForkEvent(event: OrchestrationForkEvent, envelope: OrchestrationEvent,
  read: ProjectionReader): ProjectionWrite[] {
  const previous = read("fork", envelope.threadId);
  if (event.type === "thread.forked") {
    const lineage = event.payload;
    if (previous || lineage.threadId !== envelope.threadId || lineage.projectId !== envelope.projectId
      || lineage.parentThreadId === lineage.threadId || lineage.rootThreadId === lineage.threadId
      || lineage.inheritedItems !== 0 || lineage.inheritedParts !== 0 || lineage.transfer !== "pending") {
      throw new OrchestrationConflict("scope-conflict");
    }
    return [{ kind: "fork", id: envelope.threadId, value: lineage }];
  }
  if (!previous || previous.threadId !== envelope.threadId) throw new OrchestrationConflict("scope-conflict");
  const lineage = forkLineageSchema.parse(previous.value);
  if (read("fork-sealed", lineage.threadId)) throw new OrchestrationConflict("revision-conflict");
  const priorPart = read("fork-last-part", lineage.threadId)?.value as
    { ordinal: number; part: number; parts: number } | undefined;
  if (event.type === "fork.history-part") {
    const part = event.payload;
    const { id: _id, text: _text, ...metadata } = part;
    if (part.threadId !== envelope.threadId || part.part >= part.parts || read("fork-history", part.id)) {
      throw new OrchestrationConflict("scope-conflict");
    }
    if (part.part === 0) {
      if (part.ordinal !== lineage.inheritedItems || (priorPart && priorPart.part + 1 !== priorPart.parts)) {
        throw new OrchestrationConflict("revision-conflict");
      }
    } else if (!priorPart || priorPart.part + 1 !== part.part
      || durableJson({ ...priorPart, part: part.part }) !== durableJson(metadata)) {
      throw new OrchestrationConflict("revision-conflict");
    }
    return [
      { kind: "fork-history", id: part.id, value: part },
      { kind: "fork-last-part", id: lineage.threadId, value: metadata },
      { kind: "fork", id: lineage.threadId, value: { ...lineage,
        inheritedItems: lineage.inheritedItems + Number(part.part === 0), inheritedParts: lineage.inheritedParts + 1 } },
    ];
  }
  if (lineage.inheritedItems !== event.payload.inheritedItems || lineage.inheritedParts !== event.payload.inheritedParts
    || (priorPart && priorPart.part + 1 !== priorPart.parts)) {
    throw new OrchestrationConflict("revision-conflict");
  }
  return [{ kind: "fork-sealed", id: lineage.threadId, value: event.payload }];
}
