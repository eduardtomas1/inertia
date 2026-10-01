import type {
  SubagentTrace,
  SubagentTraceStatus,
} from "../../../shared/contracts";
import type { ProviderSubagentEvent } from "../../provider/contracts";
import { boundedSubagentIdentifier } from "../../provider/subagent-trace";
import {
  mergeSubagentTaskUsage,
  validateSubagentTaskUsage,
} from "../../provider/usage-values";
import type { DeltaTimerScheduler } from "./turn-stream-coalescer";

export const SUBAGENT_TELEMETRY_INTERVAL_MS = 1_000;

const LIFECYCLE_FIELDS = [
  "providerTaskId",
  "providerAgentId",
  "parentProviderAgentId",
  "parentProviderToolUseId",
  "providerToolUseId",
  "providerRole",
  "providerName",
  "providerStatus",
  "description",
  "progress",
  "result",
  "model",
] as const satisfies readonly (keyof ProviderSubagentEvent)[];

type LifecycleField = typeof LIFECYCLE_FIELDS[number];

interface PendingTelemetry {
  event: ProviderSubagentEvent;
  updatedAt: string;
}

interface TraceTelemetry {
  status: SubagentTraceStatus;
  isLive: boolean;
  sequence: number;
  reported: Partial<Record<LifecycleField, string>>;
  writtenAt: number;
  pending: PendingTelemetry | null;
  timer: unknown;
}

export interface TurnSubagentTelemetryOptions {
  scheduler: DeltaTimerScheduler;
  nowMs(): number;
  write(
    event: ProviderSubagentEvent,
    updatedAt: string,
  ): { trace: SubagentTrace; changed: boolean } | null;
}

function withEarlierTelemetry(
  event: ProviderSubagentEvent,
  earlier: ProviderSubagentEvent,
): ProviderSubagentEvent {
  return {
    ...event,
    activity: event.activity ?? earlier.activity,
    usage: mergeSubagentTaskUsage(
      validateSubagentTaskUsage(earlier.usage),
      validateSubagentTaskUsage(event.usage),
    ) ?? undefined,
    toolUseCount: event.toolUseCount ?? earlier.toolUseCount,
    durationMs: event.durationMs ?? earlier.durationMs,
  };
}

function identityKeys(
  providerTaskId: unknown,
  providerAgentId: unknown,
): string[] {
  const task = boundedSubagentIdentifier(providerTaskId);
  const agent = boundedSubagentIdentifier(providerAgentId);
  return [
    ...(task ? [`task\0${task}`] : []),
    ...(agent ? [`agent\0${agent}`] : []),
  ];
}

export class TurnSubagentTelemetry {
  private readonly traces = new Map<string, TraceTelemetry>();
  private readonly identities = new Map<string, TraceTelemetry>();
  private closed = false;

  constructor(private readonly options: TurnSubagentTelemetryOptions) {}

  project(event: ProviderSubagentEvent, updatedAt: string): void {
    const trace = this.closed ? null : this.coalescible(event);
    if (!trace) {
      this.flush();
      this.persist(event, updatedAt);
      return;
    }
    trace.pending = {
      event: trace.pending
        ? withEarlierTelemetry(event, trace.pending.event)
        : event,
      updatedAt,
    };
    const elapsed = this.options.nowMs() - trace.writtenAt;
    if (elapsed >= SUBAGENT_TELEMETRY_INTERVAL_MS) {
      this.flushTrace(trace);
      return;
    }
    if (trace.timer !== null) return;
    trace.timer = this.options.scheduler.setTimeout(() => {
      trace.timer = null;
      if (this.closed) return;
      try {
        this.flushTrace(trace);
      } catch {
        return;
      }
    }, Math.min(SUBAGENT_TELEMETRY_INTERVAL_MS, SUBAGENT_TELEMETRY_INTERVAL_MS - elapsed));
  }

  close(): void {
    this.closed = true;
    this.flush();
  }

  private coalescible(event: ProviderSubagentEvent): TraceTelemetry | null {
    const keys = identityKeys(event.providerTaskId, event.providerAgentId);
    const matches = new Set(keys.map((key) => this.identities.get(key)));
    if (matches.size !== 1) return null;
    const [trace] = matches;
    if (
      !trace
      || !trace.isLive
      || !event.isLive
      || event.status !== trace.status
      || event.sequence <= Math.max(trace.sequence, trace.pending?.event.sequence ?? -1)
    ) return null;
    return LIFECYCLE_FIELDS.every((field) => {
      const value = event[field];
      return value === null || value === undefined || value === trace.reported[field];
    }) ? trace : null;
  }

  flush(): void {
    const failures: unknown[] = [];
    for (const trace of this.traces.values()) {
      try {
        this.flushTrace(trace);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw failures[0];
  }

  private flushTrace(trace: TraceTelemetry): void {
    if (trace.timer !== null) {
      this.options.scheduler.clearTimeout(trace.timer);
      trace.timer = null;
    }
    const pending = trace.pending;
    if (!pending) return;
    this.persist(pending.event, pending.updatedAt);
    trace.pending = null;
  }

  private persist(event: ProviderSubagentEvent, updatedAt: string): void {
    const persisted = this.options.write(event, updatedAt);
    if (!persisted) return;
    const { trace, changed } = persisted;
    let state = this.traces.get(trace.id);
    if (!state) {
      state = {
        status: trace.status,
        isLive: trace.isLive,
        sequence: trace.sequence,
        reported: {},
        writtenAt: Number.NEGATIVE_INFINITY,
        pending: null,
        timer: null,
      };
      this.traces.set(trace.id, state);
    }
    state.status = trace.status;
    state.isLive = trace.isLive;
    state.sequence = trace.sequence;
    for (const key of identityKeys(trace.providerTaskId, trace.providerAgentId)) {
      this.identities.set(key, state);
    }
    if (!changed) return;
    state.writtenAt = this.options.nowMs();
    for (const field of LIFECYCLE_FIELDS) {
      const value = event[field];
      if (typeof value === "string") state.reported[field] = value;
    }
  }
}
