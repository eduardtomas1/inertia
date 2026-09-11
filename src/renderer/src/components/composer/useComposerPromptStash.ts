import { useEffect, useState } from "react";

import {
  PROMPT_STASH_CHANGED_EVENT,
  promptStashStorageKey,
  readPromptStash,
  type PromptStashEntry,
} from "../../utils/promptStash";

export function useComposerPromptStash(enabled: boolean, conversationId: string): readonly [
  readonly PromptStashEntry[],
  React.Dispatch<React.SetStateAction<PromptStashEntry[]>>,
] {
  const [state, setState] = useState(() => ({ conversationId,
    entries: enabled ? readPromptStash(window.localStorage, conversationId) : [] }));
  // Scope before paint: an effect alone would briefly expose the previous chat.
  const entries = !enabled ? [] : state.conversationId === conversationId
    ? state.entries : readPromptStash(window.localStorage, conversationId);
  const setEntries: React.Dispatch<React.SetStateAction<PromptStashEntry[]>> = (update) => {
    setState((current) => ({ conversationId, entries: typeof update === "function"
      ? update(current.conversationId === conversationId ? current.entries : readPromptStash(window.localStorage, conversationId)) : update }));
  };

  useEffect(() => {
    if (!enabled) {
      setState({ conversationId, entries: [] });
      return;
    }
    const refresh = (): void => setState({ conversationId, entries: readPromptStash(window.localStorage, conversationId) });
    refresh();
    const refreshFromStorage = (event: StorageEvent): void => {
      if (event.key === null || event.key === promptStashStorageKey(conversationId)) refresh();
    };
    window.addEventListener(PROMPT_STASH_CHANGED_EVENT, refresh);
    window.addEventListener("storage", refreshFromStorage);
    return () => {
      window.removeEventListener(PROMPT_STASH_CHANGED_EVENT, refresh);
      window.removeEventListener("storage", refreshFromStorage);
    };
  }, [enabled, conversationId]);

  return [entries, setEntries] as const;
}
