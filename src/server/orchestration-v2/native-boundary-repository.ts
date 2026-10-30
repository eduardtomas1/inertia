import type Database from "better-sqlite3";

import type { AgentTurn } from "../../shared/contracts";
import { nativeBoundarySchema, orchestrationNativeBoundarySchema, type NativeBoundary } from "../../shared/orchestration-native-boundary";
import { orchestrationAttemptSchema, orchestrationRunSchema } from "../../shared/orchestration-v2";
import type { OrchestrationEventStore } from "./event-store";
import { commandFingerprint, durableJson } from "./json";

export class NativeBoundaryRepository {
  constructor(private readonly database: Database.Database, private readonly events: OrchestrationEventStore) {}

  forRun(runId: string) {
    const row = this.events.projection("run", runId);
    if (!row) return null;
    const run = orchestrationRunSchema.parse(row.value);
    const boundary = this.events.projection("native-boundary", run.attemptId);
    return boundary ? orchestrationNativeBoundarySchema.parse(boundary.value) : null;
  }

  latest(input: { threadId: string; providerInstanceId: string; workspaceKey: string; nativeConversationId: string }) {
    const row = this.database.prepare(`SELECT payload_json FROM orchestration_v2_entities
      WHERE kind = 'native-boundary' AND thread_id = ?
        AND json_extract(payload_json, '$.providerInstanceId') = ?
        AND json_extract(payload_json, '$.workspaceKey') = ?
        AND json_extract(payload_json, '$.nativeConversationId') = ?
      ORDER BY revision DESC LIMIT 1`).get(input.threadId, input.providerInstanceId,
      input.workspaceKey, input.nativeConversationId) as { payload_json: string } | undefined;
    return row ? orchestrationNativeBoundarySchema.parse(JSON.parse(row.payload_json)) : null;
  }

  observe(turn: AgentTurn, input: NativeBoundary): void {
    const boundary = nativeBoundarySchema.parse(input);
    const row = this.events.projection("run", turn.runId);
    if (!row) return; // Legacy imports have no fabricated native execution identity.
    const run = orchestrationRunSchema.parse(row.value);
    if (run.threadId !== turn.conversationId || run.turnId !== turn.id) throw new Error("Native boundary identity conflict.");
    const attempt = orchestrationAttemptSchema.parse(this.events.projection("attempt", run.attemptId)?.value);
    const previous = this.forRun(run.id);
    if (previous && durableJson(nativeBoundarySchema.parse({
      nativeConversationId: previous.nativeConversationId, nativeSessionId: previous.nativeSessionId,
      nativeTurnId: previous.nativeTurnId, persistedHeadId: previous.persistedHeadId, phase: previous.phase,
    })) === durableJson(boundary)) return;
    const event = { type: "provider.native-boundary", payload: { runId: run.id, attemptId: attempt.id, boundary } } as const;
    // Include the preceding revision: a provider may legitimately revisit a boundary
    // after another native turn within the same application run.
    const revision = this.events.revision(run.threadId);
    this.events.commit({ actorId: "runtime", commandId: `native-boundary:${commandFingerprint({ event, revision })}`,
      threadId: run.threadId, projectId: run.projectId, command: event,
      expectedRevision: revision, events: [event], result: null });
  }
}
