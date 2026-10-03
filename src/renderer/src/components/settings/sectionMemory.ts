import { useCallback, useState } from "react";

export type SettingsSectionMemory = Map<string, unknown>;

export function useSectionMemory<T>(
  memory: SettingsSectionMemory,
  key: string,
  initial: () => T,
): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => (memory.has(key) ? memory.get(key) as T : initial()));
  const remember = useCallback((next: T) => {
    memory.set(key, next);
    setValue(next);
  }, [key, memory]);
  return [value, remember];
}
