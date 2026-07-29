import { randomUUID } from "node:crypto";

import type {
  RuntimeEventScope,
  RuntimeMutationEvent,
  RuntimeSequencedFrame,
  RuntimeSyncCursor,
} from "../shared/contracts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DEFAULT_MAX_REPLAY_EVENTS = 2_048;
const DEFAULT_MAX_REPLAY_BYTES = 4 * 1024 * 1024;

export interface RuntimeDetailSubscription {
  conversationIds: string[];
}

export type RuntimeResumeRequest =
  | { kind: "none" }
  | {
      kind: "resume";
      runtimeGeneration: string;
      afterSequence: number;
      conversationIds: string[];
    }
  | { kind: "invalid" };

export type RuntimeReplay =
  | {
      kind: "replay";
      cursor: RuntimeSyncCursor;
      frames: RuntimeSequencedFrame[];
    }
  | {
      kind: "refresh";
      cursor: RuntimeSyncCursor;
      reason: "generation-mismatch" | "cursor-ahead" | "cursor-too-old";
    };

interface RetainedRuntimeEvent {
  frame: Extract<RuntimeSequencedFrame, { type: "runtime.event" }>;
  bytes: number;
}

type ConversationRuntimeMutationEvent = Exclude<
  RuntimeMutationEvent,
  | { type: "snapshot.updated" }
  | { type: "provider.maintenance.updated" }
  | { type: "provider.maintenance.operation" }
>;

function detailConversationId(event: ConversationRuntimeMutationEvent): string {
  switch (event.type) {
    case "agent.usage":
      return event.usage.conversationId;
    case "agent.activity":
      return event.activity.conversationId;
    case "agent.subagent.updated":
      return event.trace.conversationId;
    case "agent.approval.requested":
      return event.request.conversationId;
    case "agent.input.requested":
      return event.request.conversationId;
    case "agent.plan.updated":
      return event.plan.conversationId;
    case "agent.goal.updated":
      return event.goal.conversationId;
    default:
      return event.conversationId;
  }
}

export function runtimeMutationScope(event: RuntimeMutationEvent): RuntimeEventScope {
  switch (event.type) {
    case "snapshot.updated":
    case "provider.maintenance.updated":
    case "provider.maintenance.operation":
      return { kind: "shell" };
    default:
      return {
        kind: "conversation-detail",
        conversationId: detailConversationId(event),
      };
  }
}

export function projectRuntimeFrame(
  frame: Extract<RuntimeSequencedFrame, { type: "runtime.event" }>,
  subscription: RuntimeDetailSubscription,
): RuntimeSequencedFrame {
  if (
    frame.scope.kind === "conversation-detail"
    && !subscription.conversationIds.includes(frame.scope.conversationId)
  ) {
    return { type: "runtime.cursor", sync: frame.sync };
  }
  return frame;
}

/**
 * Small in-memory replay log for renderer synchronization. It is intentionally
 * not an event store: durable application state remains in SQLite, and an
 * unavailable cursor always falls back to authoritative shell/detail reads.
 */
export class RuntimeSequencer {
  readonly runtimeGeneration: string;
  private readonly maxReplayEvents: number;
  private readonly maxReplayBytes: number;
  private latestSequence = 0;
  private replayFloor = 0;
  private retainedBytes = 0;
  private readonly retained: RetainedRuntimeEvent[] = [];

  constructor(options: {
    runtimeGeneration?: string;
    maxReplayEvents?: number;
    maxReplayBytes?: number;
  } = {}) {
    this.runtimeGeneration = options.runtimeGeneration ?? randomUUID();
    this.maxReplayEvents = Math.max(1, Math.trunc(options.maxReplayEvents ?? DEFAULT_MAX_REPLAY_EVENTS));
    this.maxReplayBytes = Math.max(1, Math.trunc(options.maxReplayBytes ?? DEFAULT_MAX_REPLAY_BYTES));
  }

  cursor(): RuntimeSyncCursor {
    return {
      runtimeGeneration: this.runtimeGeneration,
      latestSequence: this.latestSequence,
    };
  }

  commit(
    createEvent: (cursor: RuntimeSyncCursor) => RuntimeMutationEvent,
  ): Extract<RuntimeSequencedFrame, { type: "runtime.event" }> {
    const sequence = this.latestSequence + 1;
    if (!Number.isSafeInteger(sequence)) {
      throw new Error("The runtime event sequence is exhausted.");
    }
    const sync = {
      runtimeGeneration: this.runtimeGeneration,
      latestSequence: sequence,
    };
    const event = createEvent(sync);
    const frame: Extract<RuntimeSequencedFrame, { type: "runtime.event" }> = {
      type: "runtime.event",
      sync,
      scope: runtimeMutationScope(event),
      event,
    };
    this.latestSequence = sequence;
    this.retain(frame);
    return frame;
  }

  replay(
    runtimeGeneration: string,
    afterSequence: number,
    subscription: RuntimeDetailSubscription,
  ): RuntimeReplay {
    const cursor = this.cursor();
    if (runtimeGeneration !== this.runtimeGeneration) {
      return { kind: "refresh", cursor, reason: "generation-mismatch" };
    }
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 || afterSequence > this.latestSequence) {
      return { kind: "refresh", cursor, reason: "cursor-ahead" };
    }
    if (afterSequence < this.replayFloor) {
      return { kind: "refresh", cursor, reason: "cursor-too-old" };
    }
    return {
      kind: "replay",
      cursor,
      frames: this.retained
        .filter(({ frame }) => frame.sync.latestSequence > afterSequence)
        .map(({ frame }) => projectRuntimeFrame(frame, subscription)),
    };
  }

  private retain(frame: Extract<RuntimeSequencedFrame, { type: "runtime.event" }>): void {
    const bytes = Buffer.byteLength(JSON.stringify(frame), "utf8");
    if (bytes > this.maxReplayBytes) {
      this.replayFloor = frame.sync.latestSequence;
      this.retained.length = 0;
      this.retainedBytes = 0;
      return;
    }
    this.retained.push({ frame, bytes });
    this.retainedBytes += bytes;
    while (
      this.retained.length > this.maxReplayEvents
      || this.retainedBytes > this.maxReplayBytes
    ) {
      const removed = this.retained.shift();
      if (!removed) break;
      this.retainedBytes -= removed.bytes;
      this.replayFloor = removed.frame.sync.latestSequence;
    }
  }
}

export function parseRuntimeResumeRequest(
  requestUrl: string | undefined,
  expectedPath: string,
): RuntimeResumeRequest {
  if (!requestUrl) return { kind: "invalid" };
  let url: URL;
  try {
    url = new URL(requestUrl, "http://runtime.invalid");
  } catch {
    return { kind: "invalid" };
  }
  if (url.pathname !== expectedPath) return { kind: "invalid" };
  const keys = [...url.searchParams.keys()];
  if (keys.length === 0) return { kind: "none" };
  if (
    keys.some((key) =>
      key !== "runtimeGeneration"
      && key !== "afterSequence"
      && key !== "conversationId")
    || url.searchParams.getAll("runtimeGeneration").length !== 1
    || url.searchParams.getAll("afterSequence").length !== 1
    || url.searchParams.getAll("conversationId").length > 2
  ) {
    return { kind: "invalid" };
  }
  const runtimeGeneration = url.searchParams.get("runtimeGeneration");
  const rawSequence = url.searchParams.get("afterSequence");
  const conversationIds = url.searchParams.getAll("conversationId");
  if (
    !runtimeGeneration
    || !UUID_PATTERN.test(runtimeGeneration)
    || !rawSequence
    || !/^(?:0|[1-9]\d*)$/u.test(rawSequence)
    || conversationIds.some((conversationId) =>
      !UUID_PATTERN.test(conversationId))
    || new Set(conversationIds).size !== conversationIds.length
  ) {
    return { kind: "invalid" };
  }
  const afterSequence = Number(rawSequence);
  if (!Number.isSafeInteger(afterSequence)) return { kind: "invalid" };
  return {
    kind: "resume",
    runtimeGeneration,
    afterSequence,
    conversationIds,
  };
}
