import type { CompactionUpdate } from "@agentclientprotocol/sdk";

import type { AgentHarnessEmitter } from "./agent-harness";

export function projectAcpCompactionUpdate(
  providerName: string,
  providerId: string,
  update: CompactionUpdate,
  emitter: AgentHarnessEmitter,
): void {
  const activityId = `${providerId}:compaction:${update.compactionId}`;
  const status = update.status.replace(/\0/gu, "").trim().slice(0, 200);
  const detail = update.error
    ? `Error: ${update.error}`
    : `Status: ${status}`;

  if (status === "in_progress") {
    emitter.activity(
      "system",
      "started",
      `${providerName} is compacting session context`,
      { activityId, detail },
    );
    return;
  }
  if (status === "completed") {
    emitter.activity(
      "system",
      "completed",
      `${providerName} compacted session context`,
      { activityId, detail },
    );
    return;
  }
  if (status === "failed") {
    emitter.activity(
      "system",
      "failed",
      `${providerName} could not compact session context`,
      { activityId, detail },
    );
    return;
  }
  if (status === "cancelled") {
    emitter.activity(
      "system",
      "info",
      `${providerName} cancelled session context compaction`,
      { activityId, detail },
    );
    return;
  }
  emitter.activity(
    "system",
    "info",
    `${providerName} reported a context compaction update`,
    // ACP deliberately leaves status open for future lifecycle states. Keep
    // the notice separate from the correlated activity so an unknown state
    // cannot falsely complete or fail an in-progress compaction.
    { detail },
  );
}
