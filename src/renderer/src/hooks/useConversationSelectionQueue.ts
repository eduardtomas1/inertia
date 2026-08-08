import { useCallback, useRef } from "react";

import type { ServerEvent } from "@shared/contracts";
import type { CommandWithoutId } from "../lib/runtimeCommands";

type RuntimeRunner = (
  key: string,
  command: CommandWithoutId,
) => Promise<ServerEvent>;

export function useConversationSelectionQueue(
  run: RuntimeRunner,
): (key: string, conversationId: string) => Promise<ServerEvent> {
  const runRef = useRef(run);
  const tailRef = useRef<Promise<void>>(Promise.resolve());
  runRef.current = run;

  return useCallback((key: string, conversationId: string) => {
    const selection = tailRef.current.then(() => runRef.current(key, {
      type: "conversation.select",
      payload: { conversationId },
    }));
    tailRef.current = selection.then(
      () => undefined,
      () => undefined,
    );
    return selection;
  }, []);
}
