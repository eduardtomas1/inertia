import { UUID_PATTERN } from "@shared/request-identifiers";
import { MAX_PERSISTED_TERMINAL_TABS } from "@shared/terminal-handoff";

const MAX_TERMINAL_STORAGE_LENGTH = 4_096;
const mountedTerminalPanels = new Set<string>();
const terminalTabListeners = new Set<(storageKey: string) => void>();

export type TerminalTab = {
  id: string;
  label: string;
  terminalId: string | null;
};

export function terminalStorageKey(projectId: string, conversationId?: string): string {
  return `inertia:terminal-sessions:v1:${projectId}:${conversationId ?? "project"}`;
}

export function newTerminalTab(
  index = 0,
  terminalId: string | null = null,
): TerminalTab {
  return {
    id: crypto.randomUUID(),
    label: `Terminal ${index + 1}`,
    terminalId,
  };
}

export function readPersistedTerminalTabs(storageKey: string): TerminalTab[] {
  try {
    const raw = window.sessionStorage.getItem(storageKey);
    if (!raw || raw.length > MAX_TERMINAL_STORAGE_LENGTH) return [newTerminalTab()];
    const parsed = JSON.parse(raw) as unknown;
    if (
      !Array.isArray(parsed)
      || parsed.length < 1
      || parsed.length > MAX_PERSISTED_TERMINAL_TABS
      || new Set(parsed.filter((terminalId) => terminalId !== null)).size
        !== parsed.filter((terminalId) => terminalId !== null).length
      || parsed.some((terminalId) => (
        terminalId !== null
        && (typeof terminalId !== "string" || !UUID_PATTERN.test(terminalId))
      ))
    ) return [newTerminalTab()];
    return parsed.map((terminalId, index) => newTerminalTab(index, terminalId));
  } catch {
    return [newTerminalTab()];
  }
}

export function persistTerminalTabs(
  storageKey: string,
  tabs: readonly TerminalTab[],
): void {
  try {
    if (tabs.length === 0) window.sessionStorage.removeItem(storageKey);
    else window.sessionStorage.setItem(
      storageKey,
      JSON.stringify(tabs.map(({ terminalId }) => terminalId)),
    );
  } catch {
    // Session restoration is a convenience; terminal ownership stays server-side.
  }
  notifyTerminalTabsChanged(storageKey);
}

export function onTerminalTabsChanged(listener: (storageKey: string) => void): () => void {
  terminalTabListeners.add(listener);
  return () => { terminalTabListeners.delete(listener); };
}

function notifyTerminalTabsChanged(storageKey: string): void {
  for (const listener of terminalTabListeners) listener(storageKey);
}

export function markTerminalPanelMounted(storageKey: string): () => void {
  mountedTerminalPanels.add(storageKey);
  notifyTerminalTabsChanged(storageKey);
  return () => {
    mountedTerminalPanels.delete(storageKey);
    notifyTerminalTabsChanged(storageKey);
  };
}

export function liveTerminalIdsForHandoff(
  projectId: string,
  conversationId: string,
): string[] {
  const storageKey = terminalStorageKey(projectId, conversationId);
  if (!mountedTerminalPanels.has(storageKey)) return [];
  return readPersistedTerminalTabs(storageKey)
    .flatMap(({ terminalId }) => terminalId ? [terminalId] : []);
}

export function seedTerminalTabs(
  storageKey: string,
  terminalIds: readonly string[],
): void {
  persistTerminalTabs(
    storageKey,
    terminalIds.map((terminalId, index) => newTerminalTab(index, terminalId)),
  );
}

export function adoptTerminalHandoff(
  storageKey: string,
  terminalIds: readonly string[],
): boolean {
  if (terminalIds.length === 0) return false;
  const consumedKey = `${storageKey}:handoff-consumed`;
  try {
    if (
      window.sessionStorage.getItem(consumedKey) !== null
      || window.sessionStorage.getItem(storageKey) !== null
    ) return false;
    window.sessionStorage.setItem(consumedKey, "true");
  } catch {
    return false;
  }
  seedTerminalTabs(storageKey, terminalIds);
  return true;
}
