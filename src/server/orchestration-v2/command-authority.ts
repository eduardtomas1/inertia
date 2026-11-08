import type { OrchestrationCommandLanes } from "./command-lanes";
import type { OrchestrationEventStore } from "./event-store";
import { commandFingerprint, durableId } from "./json";
import {
  OrchestrationCommandRejected,
  OrchestrationConflict,
  type CommandIdentity,
  type CommandReceipt,
  type CommandSource,
  type CommitResult,
  type EffectDraft,
  type EventDraft,
  type JsonValue,
} from "./types";

export type CommandRejectionPolicy = (error: unknown) => string | null;

export interface CommandAuthorityRequest {
  source: CommandSource;
  threadId: string;
  projectId: string;
  commandType: string;
  rejection: CommandRejectionPolicy | null;
}

interface InFlight {
  threadId: string;
  projectId: string;
  fingerprint: string;
  result: Promise<JsonValue>;
  resolve(value: JsonValue): void;
  reject(error: unknown): void;
}

export interface CommandTicket {
  readonly identity: CommandIdentity;
  readonly command: JsonValue;
  readonly commandType: string;
  readonly direct: boolean;
  inLane<T>(decide: () => T): Promise<T>;
  commit(input: { events: readonly EventDraft[]; effects?: readonly EffectDraft[]; result: JsonValue },
    compatibilityProjection?: () => void): CommitResult;
  finish(result: JsonValue): void;
  fail(error: unknown): void;
}

export type CommandAuthorityStart<T> =
  | { kind: "replay"; receipt: CommandReceipt }
  | { kind: "rejected"; detail: string }
  | { kind: "joined"; result: Promise<JsonValue> }
  | { kind: "lead"; ticket: CommandTicket; intake: T };

function inFlightKey(identity: Pick<CommandIdentity, "actorId" | "commandId">): string {
  return JSON.stringify([identity.actorId, identity.commandId]);
}

export class OrchestrationCommandAuthority {
  private readonly inFlight = new Map<string, InFlight>();

  constructor(
    private readonly events: OrchestrationEventStore,
    private readonly lanes: OrchestrationCommandLanes,
  ) {}

  begin<T = undefined>(request: CommandAuthorityRequest, intake?: (ticket: CommandTicket) => T): Promise<CommandAuthorityStart<T>> {
    const identity: CommandIdentity = { actorId: request.source.actorId, commandId: request.source.commandId,
      projectId: request.projectId, threadId: request.threadId };
    for (const value of [identity.actorId, identity.commandId, identity.projectId, identity.threadId]) durableId(value);
    durableId(request.commandType);
    const fingerprint = commandFingerprint(request.source.command);
    return this.lanes.run(request.threadId, (): CommandAuthorityStart<T> => {
      const key = inFlightKey(identity);
      const running = this.inFlight.get(key);
      if (running) {
        if (running.threadId !== identity.threadId || running.projectId !== identity.projectId
          || running.fingerprint !== fingerprint) throw new OrchestrationConflict("command-conflict");
        return { kind: "joined", result: running.result };
      }
      let receipt: CommandReceipt | null;
      try {
        receipt = this.events.receipt(identity, request.source.command);
      } catch (error) {
        if (error instanceof OrchestrationCommandRejected) return { kind: "rejected", detail: error.detail };
        throw error;
      }
      if (receipt) return { kind: "replay", receipt };
      const entry = this.track(key, identity, fingerprint);
      const ticket = this.ticket(key, entry, identity, request);
      try {
        return { kind: "lead", ticket, intake: (intake ? intake(ticket) : undefined) as T };
      } catch (error) {
        ticket.fail(error);
        throw error;
      }
    });
  }

  inFlightCount(): number {
    return this.inFlight.size;
  }

  private track(key: string, identity: CommandIdentity, fingerprint: string): InFlight {
    let resolve!: (value: JsonValue) => void;
    let reject!: (error: unknown) => void;
    const result = new Promise<JsonValue>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    result.catch(() => undefined);
    const entry: InFlight = { threadId: identity.threadId, projectId: identity.projectId, fingerprint, result, resolve, reject };
    this.inFlight.set(key, entry);
    return entry;
  }

  private ticket(key: string, entry: InFlight, identity: CommandIdentity, request: CommandAuthorityRequest): CommandTicket {
    let settled = false;
    const release = (): boolean => {
      if (settled) return false;
      settled = true;
      if (this.inFlight.get(key) === entry) this.inFlight.delete(key);
      return true;
    };
    const { events, lanes } = this;
    return {
      identity,
      command: request.source.command,
      commandType: request.commandType,
      direct: request.rejection !== null,
      inLane: (decide) => lanes.run(identity.threadId, decide),
      commit: (input, compatibilityProjection) => events.commit({ ...identity, command: request.source.command,
        commandType: request.commandType, expectedRevision: events.revision(identity.threadId),
        events: input.events, ...(input.effects ? { effects: input.effects } : {}), result: input.result },
      compatibilityProjection),
      finish: (result) => {
        if (release()) entry.resolve(result);
      },
      fail: (error) => {
        if (settled) return;
        const detail = request.rejection?.(error) ?? null;
        try {
          if (detail !== null) {
            events.reject({ ...identity, command: request.source.command, commandType: request.commandType, error: detail });
          }
        } finally {
          if (release()) entry.reject(error);
        }
      },
    };
  }
}
