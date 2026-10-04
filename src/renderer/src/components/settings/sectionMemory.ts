import { useCallback, useState } from "react";

import type { SettingsTarget } from "../../lib/settingsTarget";

export type SettingsSectionMemory = Map<string, unknown>;

type ProjectChoice = { target: SettingsTarget | null; projectId: string | null };

export function chosenProjectId(memory: SettingsSectionMemory, target: SettingsTarget | null): string | null {
  const choice = memory.get("projects") as ProjectChoice | undefined;
  if (target?.section === "projects" && choice?.target !== target) return target.projectId ?? null;
  return choice?.projectId ?? null;
}

export function rememberProjectChoice(memory: SettingsSectionMemory, target: SettingsTarget | null, projectId: string | null): void {
  memory.set("projects", { target, projectId } satisfies ProjectChoice);
}

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
