import { RuntimeStartupBlockerError } from "../../shared/runtime-startup-diagnostics";

/** JSON is the durable boundary. Provider SDK objects and live handles never cross it. */
export type JsonValue = null | boolean | number | string | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface CommandIdentity {
  actorId: string;
  commandId: string;
  projectId: string;
  threadId: string;
}

/** Constructed by trusted ingress, never accepted as a renderer-supplied actor. */
export interface CommandSource {
  actorId: string;
  commandId: string;
  command: JsonValue;
}

export interface EventDraft {
  type: string;
  payload: JsonValue;
}

export interface OrchestrationEvent extends EventDraft {
  sequence: number;
  id: string;
  projectId: string;
  threadId: string;
  revision: number;
  commandId: string;
  createdAt: string;
}

export interface Projection {
  kind: string;
  id: string;
  projectId: string;
  threadId: string;
  revision: number;
  value: JsonValue;
}

export interface ProjectionWrite {
  kind: string;
  id: string;
  value: JsonValue;
}

export type ProjectionReader = (kind: string, id: string) => Projection | null;
export type ProjectEvent = (
  event: OrchestrationEvent,
  read: ProjectionReader,
) => readonly ProjectionWrite[];

export type EffectReplayPolicy = "process-bound" | "replay-safe";
export type EffectState = "pending" | "running" | "succeeded" | "failed" | "retired";

export interface EffectDraft {
  id: string;
  /** Index of the event authorizing this effect in the same commit. */
  eventIndex: number;
  kind: string;
  replayPolicy: EffectReplayPolicy;
  payload: JsonValue;
}

export interface OrchestrationEffect {
  sequence: number;
  id: string;
  projectId: string;
  threadId: string;
  eventSequence: number;
  kind: string;
  replayPolicy: EffectReplayPolicy;
  runtimeId: string;
  state: EffectState;
  attempts: number;
  availableAt: string;
  claimId: string | null;
  claimedAt: string | null;
  settledAt: string | null;
  failureCode: string | null;
  payload: JsonValue;
}

export interface CommandCommit extends CommandIdentity {
  command: JsonValue;
  expectedRevision: number;
  events: readonly EventDraft[];
  effects?: readonly EffectDraft[];
  result: JsonValue;
  commandType?: string;
}

export type CommandReceiptStatus = "accepted" | "rejected";

export interface CommandReceipt extends CommandIdentity {
  fingerprint: string;
  firstSequence: number | null;
  lastSequence: number | null;
  result: JsonValue;
  createdAt: string;
  status: CommandReceiptStatus;
  error: string | null;
  commandType: string | null;
}

export interface CommandRejection extends CommandIdentity {
  command: JsonValue;
  commandType: string;
  error: string;
}

export interface UnreadableProjection {
  kind: string;
  id: string;
}

export interface ProjectionVerification {
  valid: boolean;
  schemaVersion: number;
  expectedSchemaVersion: number;
  expectedSequence: number;
  projectionSequence: number;
  missingThreadIds: readonly string[];
  unexpectedThreadIds: readonly string[];
  unreadable: readonly UnreadableProjection[];
}

export type ProjectionReadable = (kind: string, value: JsonValue) => boolean;

export interface ProjectionVerificationOptions {
  readable?: boolean | ProjectionReadable;
}

export interface ProjectionMaintenance extends ProjectionVerification {
  rebuilt: boolean;
  beforeRebuild: ProjectionVerification | null;
}

export interface CommitResult {
  replayed: boolean;
  receipt: CommandReceipt;
  /** Only newly committed events. Receipt replay must not publish them again. */
  events: readonly OrchestrationEvent[];
}

export class OrchestrationConflict extends Error {
  constructor(readonly code: "command-conflict" | "revision-conflict" | "scope-conflict" | "cleanup-pending") {
    super(`Orchestration ${code}.`);
    this.name = "OrchestrationConflict";
  }
}

export class OrchestrationCommandRejected extends Error {
  constructor(readonly commandId: string, readonly detail: string) {
    super(detail);
    this.name = "OrchestrationCommandRejected";
  }
}

export class OrchestrationProjectionVerificationError extends RuntimeStartupBlockerError {
  constructor(readonly verification: ProjectionVerification) {
    super("orchestration-projection-invalid", "Orchestration projections could not be verified after a rebuild.");
    this.name = "OrchestrationProjectionVerificationError";
  }
}
