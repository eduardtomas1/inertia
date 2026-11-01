import type WebSocket from "ws";

import {
  OBSERVED_CHILD_READ_COMMAND,
  observedChildReadCommandSchema,
  type ObservedChildReadPayload,
} from "../../../shared/contracts/client-command/observed-children";
import type { ObservedChildReadResult } from "../../../shared/observed-child-thread";
import {
  deriveObservedChildren,
  type ObservedChildActiveTurn,
} from "../../orchestration-v2/observed-child-projection";
import type {
  ObservedChildTraceQuery,
  ObservedChildTraceRead,
} from "../../persistence/observed-child-repository";
import { RuntimeRequestError } from "../../runtime-errors";
import type { RuntimeClientAuthority } from "../runtime-client-authority";

export interface ObservedChildTraceSource {
  traces(query: ObservedChildTraceQuery): ObservedChildTraceRead;
}

export interface ObservedChildReadEvent {
  type: "request.result";
  requestId: string;
  result: ObservedChildReadResult;
}

export interface ObservedChildCommandDependencies {
  observedChildren: ObservedChildTraceSource;
  activeTurn(conversationId: string): { runId: string; turnId: string } | null;
  send(socket: WebSocket, event: ObservedChildReadEvent): void;
}

export interface ObservedChildCommandHandler {
  (
    socket: WebSocket,
    command: { readonly type: string },
    authority?: RuntimeClientAuthority,
  ): Promise<"handled" | "not-handled">;
  readonly commandTypes: readonly [typeof OBSERVED_CHILD_READ_COMMAND];
}

function activeIdentity(
  dependencies: Pick<ObservedChildCommandDependencies, "activeTurn">,
  conversationId: string,
): ObservedChildActiveTurn | null {
  const active = dependencies.activeTurn(conversationId);
  return active ? { conversationId, runId: active.runId, turnId: active.turnId } : null;
}

/**
 * Derives the observed children of one conversation, or of one exact turn,
 * with their capability controls evaluated against the current active turn.
 */
export function readObservedChildren(
  dependencies: Pick<ObservedChildCommandDependencies, "observedChildren" | "activeTurn">,
  payload: ObservedChildReadPayload,
): ObservedChildReadResult {
  const turnId = payload.turnId ?? null;
  const read = dependencies.observedChildren.traces({ conversationId: payload.conversationId, turnId });
  if (!read.conversationExists) throw new RuntimeRequestError("That chat no longer exists.");
  const scoped = read.traces.filter((trace) =>
    trace.conversationId === payload.conversationId
    && (turnId === null || trace.turnId === turnId));
  const derived = deriveObservedChildren(scoped, activeIdentity(dependencies, payload.conversationId));
  return {
    kind: OBSERVED_CHILD_READ_COMMAND,
    conversationId: payload.conversationId,
    turnId,
    children: derived.children,
    controls: derived.controls,
    omitted: derived.omitted + read.traces.length - scoped.length,
    truncated: read.truncated,
  };
}

export function createObservedChildCommandHandler(
  dependencies: ObservedChildCommandDependencies,
): ObservedChildCommandHandler {
  const handler = async (
    socket: WebSocket,
    command: { readonly type: string },
    authority?: RuntimeClientAuthority,
  ): Promise<"handled" | "not-handled"> => {
    if (command.type !== OBSERVED_CHILD_READ_COMMAND) return "not-handled";
    const parsed = observedChildReadCommandSchema.safeParse(command);
    if (!parsed.success) throw new RuntimeRequestError("That agent request is malformed.");
    const { requestId, payload } = parsed.data;
    if (authority?.kind === "detached-chat" && authority.conversationId !== payload.conversationId) {
      throw new RuntimeRequestError("This window cannot read agents of another chat.");
    }
    const result = readObservedChildren(dependencies, payload);
    dependencies.send(socket, { type: "request.result", requestId, result });
    return "handled";
  };
  return Object.assign(handler, {
    commandTypes: [OBSERVED_CHILD_READ_COMMAND] as const,
  });
}
