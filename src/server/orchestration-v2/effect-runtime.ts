import { z } from "zod";

import {
  OrchestrationEffectDispatcher,
  OrchestrationEffectRejected,
  SETTLED_EFFECT_PRUNE_BATCH,
  type EffectFailure,
  type EffectHandler,
  type OrchestrationEffectOutbox,
} from "./effect-outbox";
import { commandFingerprint, durableId } from "./json";
import type { EffectDraft, EffectReplayPolicy } from "./types";

export const SETTLED_EFFECT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const SETTLED_EFFECT_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
export const EFFECT_LIVENESS_POLL_MS = 30_000;
export const EFFECT_DISPATCH_CONCURRENCY = 4;

interface EffectKindPolicy {
  readonly replayPolicy: EffectReplayPolicy;
  readonly retry: "never" | "bounded";
  readonly rationale: string;
}

export const ORCHESTRATION_EFFECT_KINDS = {
  "provider.start": {
    replayPolicy: "process-bound",
    retry: "never",
    rationale: "A claimed start may already have reached the provider; a failed launch settles once and the fresh-session fallback owns recovery instead of an in-process retry.",
  },
  "native.fork": {
    replayPolicy: "process-bound",
    retry: "never",
    rationale: "Native forks mutate provider-owned history; an interrupted fork becomes uncertain and is resolved only by exact cleanup evidence.",
  },
  "native.rollback": {
    replayPolicy: "process-bound",
    retry: "never",
    rationale: "Native rollback mutates provider-owned history; an interrupted rollback becomes uncertain and is resolved only by exact cleanup evidence.",
  },
  "checkpoint.capture-requested": {
    replayPolicy: "replay-safe",
    retry: "bounded",
    rationale: "Finalizing a terminal turn's repository artifact is idempotent per turn and safe to repeat after process loss.",
  },
} as const satisfies Readonly<Record<string, EffectKindPolicy>>;

export type OrchestrationEffectKind = keyof typeof ORCHESTRATION_EFFECT_KINDS;
export const CHECKPOINT_CAPTURE_EFFECT_KIND = "checkpoint.capture-requested" satisfies OrchestrationEffectKind;
type KindsWithPolicy<P extends EffectReplayPolicy> = {
  [K in OrchestrationEffectKind]: (typeof ORCHESTRATION_EFFECT_KINDS)[K]["replayPolicy"] extends P ? K : never
}[OrchestrationEffectKind];
export type ReplaySafeEffectKind = KindsWithPolicy<"replay-safe">;
export type ProcessBoundEffectKind = KindsWithPolicy<"process-bound">;

export const REPLAY_SAFE_EFFECT_KINDS: readonly ReplaySafeEffectKind[] = Object.entries(ORCHESTRATION_EFFECT_KINDS)
  .filter(([, policy]) => policy.replayPolicy === "replay-safe")
  .map(([kind]) => kind as ReplaySafeEffectKind);

export function effectKindPolicy(kind: string): EffectKindPolicy | null {
  return Object.hasOwn(ORCHESTRATION_EFFECT_KINDS, kind)
    ? ORCHESTRATION_EFFECT_KINDS[kind as OrchestrationEffectKind]
    : null;
}

const effectEntityId = z.string().min(1).max(240).refine((value) => {
  try { return durableId(value) === value; } catch { return false; }
});

export const checkpointCaptureRequestSchema = z.object({
  conversationId: effectEntityId,
  turnId: effectEntityId,
  runId: effectEntityId,
}).strict();
export type CheckpointCaptureRequest = z.infer<typeof checkpointCaptureRequestSchema>;

interface ReplaySafeEffectPayloads {
  readonly "checkpoint.capture-requested": CheckpointCaptureRequest;
}

export type ReplaySafeEffectPayload<K extends ReplaySafeEffectKind> = ReplaySafeEffectPayloads[K];

const replaySafePayloads: { readonly [K in ReplaySafeEffectKind]: z.ZodType<ReplaySafeEffectPayload<K>> } = {
  "checkpoint.capture-requested": checkpointCaptureRequestSchema,
};

export function checkpointCaptureEffect(request: CheckpointCaptureRequest, eventIndex: number): EffectDraft {
  const payload = checkpointCaptureRequestSchema.parse(request);
  return {
    id: `checkpoint-capture:${commandFingerprint({ runId: payload.runId, turnId: payload.turnId })}`,
    eventIndex,
    kind: "checkpoint.capture-requested",
    replayPolicy: ORCHESTRATION_EFFECT_KINDS["checkpoint.capture-requested"].replayPolicy,
    payload,
  };
}

export interface ReplaySafeEffectContext {
  readonly signal: AbortSignal;
  readonly willRetry: boolean;
  readonly effectId: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly attempt: number;
}

export type ReplaySafeEffectExecutor<K extends ReplaySafeEffectKind> = (
  payload: ReplaySafeEffectPayload<K>,
  context: ReplaySafeEffectContext,
) => Promise<void>;

export interface OrchestrationEffectRuntimeOptions {
  readonly concurrency?: number;
  readonly livenessPollMs?: number;
  readonly pruneIntervalMs?: number;
  readonly retentionMs?: number;
  readonly pruneBatchSize?: number;
  readonly now?: () => number;
  readonly onFailure?: (failure: EffectFailure) => void;
}

interface SettledWaiter {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid orchestration effect ${label}.`);
  return value;
}

export class OrchestrationEffectRuntime {
  private readonly handlers = new Map<string, EffectHandler>();
  private readonly dispatcher: OrchestrationEffectDispatcher;
  private readonly settledWaiters = new Map<string, Set<SettledWaiter>>();
  private readonly livenessPollMs: number;
  private readonly pruneIntervalMs: number;
  private readonly retentionMs: number;
  private readonly pruneBatchSize: number;
  private readonly now: () => number;
  private state: "created" | "running" | "stopped" = "created";
  private wakeQueued = false;
  private claimTimer: ReturnType<typeof setTimeout> | null = null;
  private pruneTimer: ReturnType<typeof setTimeout> | null = null;
  private pruning: Promise<number> | null = null;
  private stopping: Promise<void> | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly outbox: OrchestrationEffectOutbox,
    options: OrchestrationEffectRuntimeOptions = {},
  ) {
    this.livenessPollMs = positiveInteger(options.livenessPollMs ?? EFFECT_LIVENESS_POLL_MS, "liveness poll");
    this.pruneIntervalMs = positiveInteger(options.pruneIntervalMs ?? SETTLED_EFFECT_PRUNE_INTERVAL_MS, "prune interval");
    this.retentionMs = positiveInteger(options.retentionMs ?? SETTLED_EFFECT_RETENTION_MS, "retention");
    this.pruneBatchSize = positiveInteger(options.pruneBatchSize ?? SETTLED_EFFECT_PRUNE_BATCH, "prune batch");
    this.now = options.now ?? Date.now;
    this.dispatcher = new OrchestrationEffectDispatcher(outbox, this.handlers, {
      concurrency: options.concurrency ?? EFFECT_DISPATCH_CONCURRENCY,
      ...(options.onFailure ? { onFailure: options.onFailure } : {}),
      afterTask: () => { this.wake(); },
    });
  }

  get running(): boolean {
    return this.state === "running";
  }

  get inFlight(): number {
    return this.dispatcher.inFlight;
  }

  executes(kind: OrchestrationEffectKind): boolean {
    return this.state === "running" && this.handlers.has(kind);
  }

  register<K extends ReplaySafeEffectKind>(kind: K, executor: ReplaySafeEffectExecutor<K>): () => void {
    if (ORCHESTRATION_EFFECT_KINDS[kind].replayPolicy !== "replay-safe") {
      throw new Error("Only replay-safe orchestration effects can be dispatched.");
    }
    if (this.handlers.has(kind)) throw new Error("An orchestration effect executor is already registered.");
    const schema: z.ZodType<ReplaySafeEffectPayload<K>> = replaySafePayloads[kind];
    const handler: EffectHandler = async (effect, { signal, willRetry }) => {
      if (effect.replayPolicy !== "replay-safe") throw new OrchestrationEffectRejected("replay-policy-mismatch");
      const parsed = schema.safeParse(effect.payload);
      if (!parsed.success) throw new OrchestrationEffectRejected("invalid-effect-payload");
      await executor(parsed.data, {
        signal, willRetry, effectId: effect.id, projectId: effect.projectId,
        threadId: effect.threadId, attempt: effect.attempts,
      });
    };
    this.handlers.set(kind, handler);
    this.wake();
    return () => {
      if (this.handlers.get(kind) === handler) this.handlers.delete(kind);
    };
  }

  start(): void {
    if (this.state !== "created") return;
    this.state = "running";
    this.unsubscribe = this.outbox.subscribe(() => { this.wake(); });
    this.schedulePrune(0);
    this.wake();
  }

  wake(): void {
    if (this.state !== "running" || this.wakeQueued) return;
    this.wakeQueued = true;
    queueMicrotask(() => {
      this.wakeQueued = false;
      this.pump();
    });
  }

  pump(): number {
    if (this.state !== "running") return 0;
    if (!this.outbox.open) {
      void this.stop();
      return 0;
    }
    try {
      const claimed = this.dispatcher.pump();
      this.resolveSettledWaiters();
      this.scheduleClaim();
      return claimed;
    } catch {
      this.scheduleClaim(Math.min(1_000, this.livenessPollMs));
      return 0;
    }
  }

  cancelUnsettled(input: { threadId: string; kinds: readonly OrchestrationEffectKind[]; reason: string }): string[] {
    const ids = this.outbox.cancelUnsettled(input.threadId, input.kinds, input.reason);
    this.signalCancellations(ids);
    return ids;
  }

  signalCancellations(effectIds: readonly string[]): void {
    this.dispatcher.cancel(effectIds);
    if (effectIds.length > 0) this.wake();
  }

  awaitSettled(effectId: string): Promise<void> {
    if (this.state === "stopped") return Promise.reject(new Error("The orchestration effect runtime is stopped."));
    return new Promise<void>((resolve, reject) => {
      const waiters = this.settledWaiters.get(effectId) ?? new Set<SettledWaiter>();
      waiters.add({ resolve, reject });
      this.settledWaiters.set(effectId, waiters);
      try {
        this.resolveSettled(effectId);
      } catch (error) {
        this.settledWaiters.delete(effectId);
        reject(error instanceof Error ? error : new Error("The orchestration effect could not be read."));
      }
    });
  }

  pruneSettled(): Promise<number> {
    if (this.pruning) return this.pruning;
    const prune = async (): Promise<number> => {
      const before = new Date(this.now() - this.retentionMs).toISOString();
      let pruned = 0;
      while (this.state !== "stopped" && this.outbox.open) {
        const deleted = this.outbox.pruneSettled(before, { kinds: REPLAY_SAFE_EFFECT_KINDS, limit: this.pruneBatchSize });
        pruned += deleted;
        if (deleted < this.pruneBatchSize) break;
        await new Promise<void>((resolve) => { setImmediate(resolve); });
      }
      return pruned;
    };
    const pruning = prune().finally(() => {
      if (this.pruning === pruning) this.pruning = null;
    });
    this.pruning = pruning;
    return pruning;
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.state = "stopped";
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.claimTimer) clearTimeout(this.claimTimer);
    if (this.pruneTimer) clearTimeout(this.pruneTimer);
    this.claimTimer = null;
    this.pruneTimer = null;
    const stopped = new Error("The orchestration effect runtime is stopped.");
    for (const waiters of this.settledWaiters.values()) for (const waiter of waiters) waiter.reject(stopped);
    this.settledWaiters.clear();
    this.stopping = Promise.allSettled([
      this.dispatcher.close(),
      this.pruning ?? Promise.resolve(0),
    ]).then(() => undefined);
    return this.stopping;
  }

  private scheduleClaim(delayOverride?: number): void {
    if (this.claimTimer) clearTimeout(this.claimTimer);
    this.claimTimer = null;
    if (this.state !== "running") return;
    let delay = delayOverride ?? this.livenessPollMs;
    if (delayOverride === undefined && !this.dispatcher.saturated) {
      const next = this.outbox.nextClaimableAt(this.handlers.keys());
      if (next !== null) {
        const untilAvailable = Date.parse(next) - this.now();
        delay = Math.min(delay, untilAvailable > 0 ? untilAvailable : 25);
      }
    }
    const timer = setTimeout(() => {
      if (this.claimTimer === timer) this.claimTimer = null;
      this.pump();
    }, delay);
    timer.unref?.();
    this.claimTimer = timer;
  }

  private schedulePrune(delay: number): void {
    if (this.state !== "running") return;
    const timer = setTimeout(() => {
      if (this.pruneTimer === timer) this.pruneTimer = null;
      void this.pruneSettled()
        .catch(() => 0)
        .finally(() => { this.schedulePrune(this.pruneIntervalMs); });
    }, delay);
    timer.unref?.();
    this.pruneTimer = timer;
  }

  private resolveSettledWaiters(): void {
    for (const effectId of this.settledWaiters.keys()) this.resolveSettled(effectId);
  }

  private resolveSettled(effectId: string): void {
    const waiters = this.settledWaiters.get(effectId);
    if (!waiters) return;
    const effect = this.outbox.get(effectId);
    if (effect && (effect.state === "pending" || effect.state === "running")) return;
    this.settledWaiters.delete(effectId);
    for (const waiter of waiters) waiter.resolve();
  }
}
