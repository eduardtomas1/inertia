import { useCallback, useRef } from "react";

import type { ServerEvent } from "@shared/contracts";
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
