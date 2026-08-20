import { useEffect, useState } from "react";

import {
  PROMPT_STASH_CHANGED_EVENT,
  PROMPT_STASH_STORAGE_KEY,
  readPromptStash,
  type PromptStashEntry,
} from "../../utils/promptStash";

export function useComposerPromptStash(enabled: boolean): readonly [
  readonly PromptStashEntry[],
  React.Dispatch<React.SetStateAction<PromptStashEntry[]>>,
] {
  const [entries, setEntries] = useState<PromptStashEntry[]>(
    () => enabled ? readPromptStash(window.localStorage) : [],
  );

  useEffect(() => {
    if (!enabled) {
      setEntries([]);
      return;
    }
    const refresh = (): void => setEntries(readPromptStash(window.localStorage));
    const refreshFromStorage = (event: StorageEvent): void => {
      if (event.key === PROMPT_STASH_STORAGE_KEY) refresh();
    };
    window.addEventListener(PROMPT_STASH_CHANGED_EVENT, refresh);
    window.addEventListener("storage", refreshFromStorage);
    return () => {
      window.removeEventListener(PROMPT_STASH_CHANGED_EVENT, refresh);
      window.removeEventListener("storage", refreshFromStorage);
    };
  }, [enabled]);

  return [entries, setEntries] as const;
}
