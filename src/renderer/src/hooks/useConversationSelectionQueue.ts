import { useCallback, useEffect, useRef } from "react";

import type { AppSnapshot, ServerEvent } from "@shared/contracts";
import type { CommandWithoutId } from "../lib/runtimeCommands";

type RuntimeRunner = (
  key: string,
  command: CommandWithoutId,
) => Promise<ServerEvent>;

export function useAsyncOperationQueue(): <Result>(
  operation: () => Promise<Result>,
) => Promise<Result> {
  const tailRef = useRef<Promise<void>>(Promise.resolve());

  return useCallback(<Result,>(operation: () => Promise<Result>) => {
    const queued = tailRef.current.then(operation);
    tailRef.current = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }, []);
}

export type AsyncOperationQueue = <Result>(
  operation: () => Promise<Result>,
) => Promise<Result>;

export function useRuntimeCommandQueue(
  run: RuntimeRunner,
): RuntimeRunner {
  const runRef = useRef(run);
  const enqueue = useAsyncOperationQueue();
  runRef.current = run;

  return useCallback((key: string, command: CommandWithoutId) =>
    enqueue(() => runRef.current(key, command)), [enqueue]);
}

export function useConversationSelectionQueue(
  run: RuntimeRunner,
): (key: string, conversationId: string) => Promise<ServerEvent> {
  const queue = useRuntimeCommandQueue(run);
  return useCallback((key: string, conversationId: string) => queue(key, {
    type: "conversation.select",
    payload: { conversationId },
  }), [queue]);
}

type AuthoritativeConversationCreate = {
  projectId: string;
  knownConversationIds: ReadonlySet<string>;
  resolve(): void;
};

function confirmsConversationCreate(
  snapshot: AppSnapshot | null,
  pending: AuthoritativeConversationCreate,
): boolean {
  const activeConversationId = snapshot?.activeConversationId;
  if (!activeConversationId || pending.knownConversationIds.has(activeConversationId)) {
    return false;
  }
  return snapshot.conversations.some((conversation) => (
    conversation.id === activeConversationId
    && conversation.projectId === pending.projectId
  ));
}

/**
 * Creation activates a chat, so its snapshot is authoritative evidence that
 * the mutation completed. Do not let a delayed request settlement strand the
 * next explicitly requested chat behind an already-published create.
 */
export function useAuthoritativeConversationCreateQueue(
  run: RuntimeRunner,
  snapshot: AppSnapshot | null,
  enqueue: AsyncOperationQueue,
): (key: string, command: CommandWithoutId) => Promise<void> {
  const runRef = useRef(run);
  const snapshotRef = useRef(snapshot);
  const pendingRef = useRef<AuthoritativeConversationCreate | null>(null);
  runRef.current = run;
  snapshotRef.current = snapshot;

  useEffect(() => {
    const pending = pendingRef.current;
    if (pending && confirmsConversationCreate(snapshot, pending)) {
      pending.resolve();
    }
  }, [snapshot]);

  return useCallback((key: string, command: CommandWithoutId) => {
    if (command.type !== "conversation.create" || command.payload.activate === false) {
      return Promise.reject(new Error("Conversation creation must activate its new chat."));
    }
    return enqueue(async () => {
      let resolveAuthoritative!: () => void;
      const authoritative = new Promise<void>((resolve) => {
        resolveAuthoritative = resolve;
      });
      const pending: AuthoritativeConversationCreate = {
        projectId: command.payload.projectId,
        knownConversationIds: new Set(
          snapshotRef.current?.conversations.map(({ id }) => id) ?? [],
        ),
        resolve: resolveAuthoritative,
      };
      pendingRef.current = pending;
      if (confirmsConversationCreate(snapshotRef.current, pending)) {
        resolveAuthoritative();
      }
      try {
        const request = runRef.current(key, command);
        await Promise.race([request, authoritative]);
      } finally {
        if (pendingRef.current === pending) pendingRef.current = null;
      }
    });
  }, [enqueue]);
}
