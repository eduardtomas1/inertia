import type {
  AgentInputRequest,
  RuntimeMutationEvent,
} from "../../shared/contracts";
import {
  deletePendingInteraction,
  registerPendingInteraction,
} from "./pending-interaction-registry";

const CONTEXT_SELECTION_TIMEOUT_MS = 5 * 60_000;
const MAX_PENDING_CONTEXT_SELECTIONS = 4;

export interface ConversationContextSelection {
  sourceConversationId: string;
  sourceMessageIds: readonly string[];
  note?: string;
  acknowledgedWorkspaceDifference: boolean;
}

export interface ConversationContextAuthorizationScope {
  contextRequestId: string;
  targetConversationId: string;
  targetTurnId: string;
  targetRunId: string;
  toolCallIdHash: string;
}

export interface ConversationContextAuthorization {
  receipt: object;
}

export type ConversationContextSelectionOutcome =
  | { kind: "selected"; authorization: ConversationContextAuthorization }
  | { kind: "cancelled"; reason: "cancelled" | "expired" | "interrupted" };

interface PendingSelection {
  request: AgentInputRequest;
  scope: ConversationContextAuthorizationScope;
  signal: AbortSignal;
  detachSignal(): void;
  resolve(outcome: ConversationContextSelectionOutcome): void;
  timeout: NodeJS.Timeout;
}

interface AuthorizedSelection {
  scope: ConversationContextAuthorizationScope;
  selection: ConversationContextSelection;
}

export interface ConversationContextRequestCoordinatorOptions {
  pendingInputs: Map<string, AgentInputRequest>;
  broadcast(event: RuntimeMutationEvent): void;
  broadcastConversationShell(conversationId: string): void;
  /** Test-only shortening seam; production callers must omit it. */
  timeoutMs?: number;
}

function sameScope(
  left: ConversationContextAuthorizationScope,
  right: ConversationContextAuthorizationScope,
): boolean {
  return left.contextRequestId === right.contextRequestId
    && left.targetConversationId === right.targetConversationId
    && left.targetTurnId === right.targetTurnId
    && left.targetRunId === right.targetRunId
    && left.toolCallIdHash === right.toolCallIdHash;
}

/**
 * Process-local user authority for one exact context chooser. Renderer payloads
 * can resolve a pending request, but only this owner can mint and consume the
 * unforgeable receipt used by the privileged packet service.
 */
export class ConversationContextRequestCoordinator {
  private readonly pending = new Map<string, PendingSelection>();
  private readonly authorized = new WeakMap<object, AuthorizedSelection>();

  constructor(private readonly options: ConversationContextRequestCoordinatorOptions) {}

  request(input: {
    scope: ConversationContextAuthorizationScope;
    providerId: AgentInputRequest["providerId"];
    requestedSourceConversationId: string | null;
    createdAt: string;
    signal: AbortSignal;
  }): Promise<ConversationContextSelectionOutcome> {
    if (input.signal.aborted) {
      return Promise.resolve({ kind: "cancelled", reason: "interrupted" });
    }
    if (
      this.pending.has(input.scope.contextRequestId)
      || this.pending.size >= MAX_PENDING_CONTEXT_SELECTIONS
    ) {
      return Promise.resolve({ kind: "cancelled", reason: "interrupted" });
    }
    const timeoutMs = Math.max(1, Math.min(
      CONTEXT_SELECTION_TIMEOUT_MS,
      this.options.timeoutMs ?? CONTEXT_SELECTION_TIMEOUT_MS,
    ));
    const createdMs = Date.parse(input.createdAt);
    const request: AgentInputRequest = {
      id: input.scope.contextRequestId,
      providerId: input.providerId,
      conversationId: input.scope.targetConversationId,
      runId: input.scope.targetRunId,
      turnId: input.scope.targetTurnId,
      questions: [],
      autoResolutionMs: timeoutMs,
      conversationContextRequest: {
        requestId: input.scope.contextRequestId,
        targetConversationId: input.scope.targetConversationId,
        targetTurnId: input.scope.targetTurnId,
        requestedSourceConversationId: input.requestedSourceConversationId,
        createdAt: input.createdAt,
        expiresAt: new Date(
          (Number.isFinite(createdMs) ? createdMs : Date.now()) + timeoutMs,
        ).toISOString(),
      },
    };
    return new Promise<ConversationContextSelectionOutcome>((resolve) => {
      const abort = (): void => {
        this.finish(input.scope.contextRequestId, {
          kind: "cancelled",
          reason: "interrupted",
        });
      };
      input.signal.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(() => {
        this.finish(input.scope.contextRequestId, {
          kind: "cancelled",
          reason: "expired",
        });
      }, timeoutMs);
      timeout.unref();
      const pending: PendingSelection = {
        request,
        scope: input.scope,
        signal: input.signal,
        detachSignal: () => input.signal.removeEventListener("abort", abort),
        resolve,
        timeout,
      };
      if (!registerPendingInteraction(this.options.pendingInputs, request)) {
        clearTimeout(timeout);
        pending.detachSignal();
        resolve({ kind: "cancelled", reason: "interrupted" });
        return;
      }
      this.pending.set(input.scope.contextRequestId, pending);
      this.options.broadcast({ type: "agent.input.requested", request });
      this.options.broadcastConversationShell(request.conversationId);
    });
  }

  requestFor(
    requestId: string,
    targetConversationId: string,
  ): AgentInputRequest | null {
    const pending = this.pending.get(requestId);
    return pending?.request.conversationId === targetConversationId
      ? pending.request
      : null;
  }

  sourceAllowed(
    requestId: string,
    targetConversationId: string,
    sourceConversationId: string,
  ): boolean {
    const request = this.requestFor(requestId, targetConversationId)
      ?.conversationContextRequest;
    return Boolean(
      request
      && sourceConversationId !== targetConversationId
      && (
        request.requestedSourceConversationId === null
        || request.requestedSourceConversationId === sourceConversationId
      ),
    );
  }

  respond(input: {
    requestId: string;
    targetConversationId: string;
    selection: ConversationContextSelection | null;
  }): boolean {
    const pending = this.pending.get(input.requestId);
    if (
      !pending
      || pending.request.conversationId !== input.targetConversationId
      || pending.signal.aborted
    ) return false;
    if (!input.selection) {
      this.finish(input.requestId, { kind: "cancelled", reason: "cancelled" });
      return true;
    }
    if (!this.sourceAllowed(
      input.requestId,
      input.targetConversationId,
      input.selection.sourceConversationId,
    )) return false;
    const receipt = {};
    this.authorized.set(receipt, {
      scope: pending.scope,
      selection: {
        ...input.selection,
        sourceMessageIds: [...input.selection.sourceMessageIds],
      },
    });
    this.finish(input.requestId, {
      kind: "selected",
      authorization: { receipt },
    });
    return true;
  }

  consume(
    receipt: unknown,
    expected: ConversationContextAuthorizationScope,
  ): ConversationContextSelection | null {
    if (typeof receipt !== "object" || receipt === null) return null;
    const authorized = this.authorized.get(receipt);
    if (!authorized || !sameScope(authorized.scope, expected)) return null;
    this.authorized.delete(receipt);
    return authorized.selection;
  }

  cancelForTurn(
    targetConversationId: string,
    targetTurnId: string,
  ): number {
    let cancelled = 0;
    for (const [requestId, pending] of this.pending) {
      if (
        pending.scope.targetConversationId !== targetConversationId
        || pending.scope.targetTurnId !== targetTurnId
      ) continue;
      this.finish(requestId, { kind: "cancelled", reason: "interrupted" });
      cancelled += 1;
    }
    return cancelled;
  }

  cancelForSource(sourceConversationId: string): number {
    let cancelled = 0;
    for (const [requestId, pending] of this.pending) {
      if (
        pending.request.conversationContextRequest
          ?.requestedSourceConversationId !== sourceConversationId
      ) continue;
      this.finish(requestId, { kind: "cancelled", reason: "interrupted" });
      cancelled += 1;
    }
    return cancelled;
  }

  private finish(
    requestId: string,
    outcome: ConversationContextSelectionOutcome,
  ): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    clearTimeout(pending.timeout);
    pending.detachSignal();
    deletePendingInteraction(
      this.options.pendingInputs,
      pending.request,
      requestId,
    );
    pending.resolve(outcome);
    this.options.broadcast({
      type: "agent.input.resolved",
      conversationId: pending.scope.targetConversationId,
      runId: pending.scope.targetRunId,
      turnId: pending.scope.targetTurnId,
      requestId,
    });
    this.options.broadcastConversationShell(pending.scope.targetConversationId);
  }
}
