import { randomUUID } from "node:crypto";

import type { RuntimeSystemSuspendInterval } from "../node/runtime-process-protocol";
import {
  readSecureAtomicStateStrict,
  writeSecureAtomicState,
} from "./secure-atomic-state.js";

const MAX_PENDING_INTERVALS = 64;
const MAX_STATE_BYTES = 32 * 1024;
const STATE_VERSION = 1;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

interface ActiveSuspendBoundary {
  id: string;
  suspendedAt: string;
  resumedAt: string | null;
}

interface RuntimeSystemSuspendState {
  version: 1;
  active: ActiveSuspendBoundary | null;
  intervals: RuntimeSystemSuspendInterval[];
}

export interface RuntimeSystemSuspendTrackerOptions {
  statePath?: string;
  recoveredAt?: string;
  onDiagnostic?: (error: Error) => void;
}

function normalizedTimestamp(value: string, label: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error(`${label} is invalid.`);
  return new Date(milliseconds).toISOString();
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 20 || value.length > 40) {
    return false;
  }
  try {
    return normalizedTimestamp(value, "The persisted system suspend time")
      === value;
  } catch {
    return false;
  }
}

function interval(value: unknown): RuntimeSystemSuspendInterval | null {
  if (
    !plainObject(value)
    || Object.keys(value).length !== 3
    || typeof value.id !== "string"
    || !UUID_PATTERN.test(value.id)
    || !canonicalTimestamp(value.suspendedAt)
    || !canonicalTimestamp(value.resumedAt)
    || value.resumedAt < value.suspendedAt
  ) return null;
  return {
    id: value.id,
    suspendedAt: value.suspendedAt,
    resumedAt: value.resumedAt,
  };
}

function state(value: unknown): RuntimeSystemSuspendState | null {
  if (
    !plainObject(value)
    || Object.keys(value).length !== 3
    || value.version !== STATE_VERSION
    || !Array.isArray(value.intervals)
    || value.intervals.length > MAX_PENDING_INTERVALS
    || !(value.active === null || plainObject(value.active))
  ) return null;
  const intervals: RuntimeSystemSuspendInterval[] = [];
  const identities = new Set<string>();
  let previousResume: string | null = null;
  for (const candidate of value.intervals) {
    const parsed = interval(candidate);
    if (
      !parsed
      || identities.has(parsed.id)
      || (previousResume !== null && parsed.suspendedAt < previousResume)
    ) return null;
    intervals.push(parsed);
    identities.add(parsed.id);
    previousResume = parsed.resumedAt;
  }
  let active: ActiveSuspendBoundary | null = null;
  if (value.active !== null) {
    const candidate = value.active;
    if (
      Object.keys(candidate).length !== 3
      || typeof candidate.id !== "string"
      || !UUID_PATTERN.test(candidate.id)
      || identities.has(candidate.id)
      || !canonicalTimestamp(candidate.suspendedAt)
      || (previousResume !== null && candidate.suspendedAt < previousResume)
      || !(
        candidate.resumedAt === null
        || (
          canonicalTimestamp(candidate.resumedAt)
          && candidate.resumedAt >= candidate.suspendedAt
        )
      )
    ) return null;
    active = {
      id: candidate.id,
      suspendedAt: candidate.suspendedAt,
      resumedAt: candidate.resumedAt,
    };
  }
  return { version: STATE_VERSION, active, intervals };
}

/**
 * Retains trusted desktop suspend windows until the runtime durably records
 * and acknowledges them. An active boundary also survives app/OS restart.
 */
export class RuntimeSystemSuspendTracker {
  private active: ActiveSuspendBoundary | null = null;
  private intervals: RuntimeSystemSuspendInterval[] = [];
  private inFlight: { generation: number; id: string } | null = null;
  private readonly statePath: string | null;
  private readonly onDiagnostic: (error: Error) => void;

  constructor(options: RuntimeSystemSuspendTrackerOptions = {}) {
    this.statePath = options.statePath ?? null;
    this.onDiagnostic = options.onDiagnostic ?? (() => undefined);
    if (!this.statePath) return;
    try {
      const content = readSecureAtomicStateStrict(
        this.statePath,
        MAX_STATE_BYTES,
      );
      if (content === null) return;
      const snapshot = state(JSON.parse(content) as unknown);
      if (!snapshot) throw new Error("The persisted system suspend state is invalid.");
      this.active = snapshot.active;
      this.intervals = snapshot.intervals;
      if (this.active) {
        this.resume(options.recoveredAt ?? new Date().toISOString());
      }
    } catch (error) {
      this.onDiagnostic(error instanceof Error
        ? error
        : new Error("The persisted system suspend state could not be read."));
    }
  }

  private persist(
    active: ActiveSuspendBoundary | null,
    intervals: readonly RuntimeSystemSuspendInterval[],
  ): boolean {
    if (!this.statePath) return true;
    try {
      writeSecureAtomicState(this.statePath, JSON.stringify({
        version: STATE_VERSION,
        active,
        intervals,
      }), MAX_STATE_BYTES);
      return true;
    } catch (error) {
      this.onDiagnostic(error instanceof Error
        ? error
        : new Error("The system suspend state could not be persisted."));
      return false;
    }
  }

  suspend(at = new Date().toISOString()): void {
    if (this.active) return;
    const requestedSuspend = normalizedTimestamp(at, "The system suspend time");
    const previousResume = this.intervals.at(-1)?.resumedAt;
    const active = {
      id: randomUUID(),
      suspendedAt: previousResume
        ? new Date(Math.max(
            Date.parse(requestedSuspend),
            Date.parse(previousResume),
          )).toISOString()
        : requestedSuspend,
      resumedAt: null,
    };
    this.persist(active, this.intervals);
    // Keep the observed boundary truthful in this process even when durable
    // storage is temporarily unavailable. It is never sent until persisted.
    this.active = active;
  }

  resume(at = new Date().toISOString()): RuntimeSystemSuspendInterval | null {
    const suspended = this.active;
    if (!suspended) return null;
    const requestedResume = suspended.resumedAt
      ?? normalizedTimestamp(at, "The system resume time");
    const resumedAt = new Date(Math.max(
      Date.parse(requestedResume),
      Date.parse(suspended.suspendedAt),
    )).toISOString();
    const observed = { ...suspended, resumedAt };
    if (this.intervals.length >= MAX_PENDING_INTERVALS) {
      this.persist(observed, this.intervals);
      this.active = observed;
      this.onDiagnostic(new Error(
        "System suspend accounting is waiting for runtime acknowledgements.",
      ));
      return null;
    }
    const completed = {
      id: observed.id,
      suspendedAt: observed.suspendedAt,
      resumedAt,
    };
    const intervals = [...this.intervals, completed];
    if (!this.persist(null, intervals)) {
      this.active = observed;
      return null;
    }
    this.active = null;
    this.intervals = intervals;
    return completed;
  }

  claim(generation: number): RuntimeSystemSuspendInterval | null {
    if (!Number.isSafeInteger(generation) || generation < 1) return null;
    const head = this.intervals[0];
    if (!head) return null;
    if (
      this.inFlight?.generation === generation
      && this.inFlight.id === head.id
    ) return null;
    this.inFlight = { generation, id: head.id };
    return { ...head };
  }

  release(id: string, generation: number): void {
    if (this.inFlight?.id === id && this.inFlight.generation === generation) {
      this.inFlight = null;
    }
  }

  acknowledge(id: string, generation: number): boolean {
    if (
      this.inFlight?.id !== id
      || this.inFlight.generation !== generation
      || this.intervals[0]?.id !== id
    ) return false;
    const intervals = this.intervals.filter((candidate) => candidate.id !== id);
    if (!this.persist(this.active, intervals)) {
      this.inFlight = null;
      return false;
    }
    this.inFlight = null;
    this.intervals = intervals;
    if (this.active?.resumedAt) this.resume(this.active.resumedAt);
    return true;
  }

  completed(): readonly RuntimeSystemSuspendInterval[] {
    return [...this.intervals];
  }
}
