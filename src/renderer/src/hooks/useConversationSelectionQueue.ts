import { useCallback, useRef } from "react";

import type { ServerEvent } from "@shared/contracts";
import type { CommandWithoutId } from "../lib/runtimeCommands";

type RuntimeRunner = (
  key: string,
  command: CommandWithoutId,
) => Promise<ServerEvent>;

export function useRuntimeCommandQueue(
  run: RuntimeRunner,
): RuntimeRunner {
  const runRef = useRef(run);
  const tailRef = useRef<Promise<void>>(Promise.resolve());
  runRef.current = run;

  return useCallback((key: string, command: CommandWithoutId) => {
    const operation = tailRef.current.then(() => runRef.current(key, command));
    tailRef.current = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }, []);
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
