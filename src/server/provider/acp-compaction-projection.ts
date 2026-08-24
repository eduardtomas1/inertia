import { createHash } from "node:crypto";

import type {
  CompactionSummaryChunk,
  CompactionUpdate,
} from "@agentclientprotocol/sdk";

import type { AgentHarnessEmitter } from "./agent-harness";
import type { ProviderRunFailure } from "./contracts";

const MAX_TRACKED_COMPACTIONS = 256;
const MAX_ACTIVITY_ID_CHARS = 1_000;

type KnownCompactionStatus =
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled";

export type AcpCompactionObservation = KnownCompactionStatus | "unknown";
export type AcpCompactionCompletionEvidence =
  | "unobserved"
  | "completed"
  | "unconfirmed";

export function unconfirmedAcpCompactionFailure(
  providerName: string,
): ProviderRunFailure {
  return {
    reason: "provider-error",
    message: `${providerName} ACP did not confirm successful context compaction.`,
    phase: "turn",
    terminalEvent: "session/prompt:compaction-unconfirmed",
  };
}

interface CompactionState {
  status: KnownCompactionStatus;
}

function activityId(providerId: string, compactionId: string): string {
  const candidate = `${providerId}:compaction:${compactionId}`;
  if (candidate.length <= MAX_ACTIVITY_ID_CHARS) return candidate;
  const digest = createHash("sha256")
    .update(compactionId)
    .digest("hex")
    .slice(0, 16);
  return `${candidate.slice(0, MAX_ACTIVITY_ID_CHARS - digest.length - 1)}:${digest}`;
}

function knownStatus(status: string): status is KnownCompactionStatus {
  return status === "in_progress"
    || status === "completed"
    || status === "failed"
    || status === "cancelled";
}

/**
 * Owns the bounded, negotiated ACP compaction lifecycle for one provider run.
 * Summary content is retained provider context, so it is validated and
 * sequenced here but never projected as assistant output or persisted detail.
 */
export class AcpCompactionProjection {
  private readonly states = new Map<string, CompactionState>();
  private readonly unknownStatusIds = new Set<string>();

  constructor(
    private readonly providerName: string,
    private readonly providerId: string,
    private readonly emitter: AgentHarnessEmitter,
  ) {}

  observeUpdate(update: CompactionUpdate): AcpCompactionObservation {
    const status = update.status;
    if (!knownStatus(status)) {
      if (
        !this.states.has(update.compactionId)
        && !this.unknownStatusIds.has(update.compactionId)
        && this.trackedIdCount() >= MAX_TRACKED_COMPACTIONS
      ) {
        throw new Error(
          `${this.providerName} ACP exceeded the bounded context compaction budget.`,
        );
      }
      this.unknownStatusIds.add(update.compactionId);
      this.emitter.activity(
        "system",
        "info",
        `${this.providerName} reported a context compaction update`,
        // ACP deliberately leaves status open for future lifecycle states.
        // Keep the notice uncorrelated so it cannot settle a known activity.
        { detail: `Status: ${status.trim().slice(0, 200)}` },
      );
      return "unknown";
    }

    const prior = this.states.get(update.compactionId);
    const wasUnknown = this.unknownStatusIds.delete(update.compactionId);
    if (status === "in_progress") {
      if (prior?.status === "in_progress") {
        return status;
      }
      if (prior) {
        throw new Error(
          `${this.providerName} ACP restarted a terminal context compaction.`,
        );
      }
      if (!prior && !wasUnknown && this.trackedIdCount() >= MAX_TRACKED_COMPACTIONS) {
        throw new Error(
          `${this.providerName} ACP exceeded the bounded context compaction budget.`,
        );
      }
      const state = { status } as const;
      this.states.set(update.compactionId, state);
      this.emit(
        update.compactionId,
        state,
        "started",
        `${this.providerName} is compacting session context`,
      );
      return status;
    }

    if (!prior) {
      if (!wasUnknown && this.trackedIdCount() >= MAX_TRACKED_COMPACTIONS) {
        throw new Error(
          `${this.providerName} ACP exceeded the bounded context compaction budget.`,
        );
      }
      const state = { status } as const;
      this.states.set(update.compactionId, state);
      this.emitTerminal(update.compactionId, state);
      return status;
    }
    if (prior.status !== "in_progress") {
      if (prior.status === status) {
        // ACP compaction updates are upserts/patches. A terminal patch may
        // supply summary, error, or metadata later. All three fields are
        // validated at the boundary and deliberately nonprojected so a patch
        // cannot create a second durable terminal activity row.
        return status;
      }
      throw new Error(
        `${this.providerName} ACP changed a terminal context compaction status.`,
      );
    }
    const state = { status } as const;
    this.states.set(update.compactionId, state);
    this.emitTerminal(update.compactionId, state);
    return status;
  }

  private emitTerminal(
    compactionId: string,
    state: CompactionState & {
      status: Exclude<KnownCompactionStatus, "in_progress">;
    },
  ): void {
    if (state.status === "completed") {
      this.emit(
        compactionId,
        state,
        "completed",
        `${this.providerName} compacted session context`,
      );
    } else if (state.status === "failed") {
      this.emit(
        compactionId,
        state,
        "failed",
        `${this.providerName} could not compact session context`,
      );
    } else {
      this.emit(
        compactionId,
        state,
        "info",
        `${this.providerName} cancelled session context compaction`,
      );
    }
  }

  observeSummaryChunk(update: CompactionSummaryChunk): void {
    if (this.states.get(update.compactionId)?.status !== "in_progress") {
      throw new Error(
        `${this.providerName} ACP sent a context compaction summary chunk outside a matching in-progress lifecycle.`,
      );
    }
  }

  completionEvidence(): AcpCompactionCompletionEvidence {
    if (this.states.size === 0 && this.unknownStatusIds.size === 0) {
      return "unobserved";
    }
    if (this.unknownStatusIds.size > 0) return "unconfirmed";
    for (const { status } of this.states.values()) {
      if (status !== "completed") return "unconfirmed";
    }
    return "completed";
  }

  private trackedIdCount(): number {
    let count = this.states.size;
    for (const compactionId of this.unknownStatusIds) {
      if (!this.states.has(compactionId)) count += 1;
    }
    return count;
  }

  private emit(
    compactionId: string,
    state: CompactionState,
    phase: "started" | "completed" | "failed" | "info",
    label: string,
  ): void {
    this.emitter.activity("system", phase, label, {
      activityId: activityId(this.providerId, compactionId),
      detail: `Status: ${state.status}`,
    });
  }
}
