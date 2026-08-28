import { useEffect, useRef } from "react";
import type {
  ClientCommand,
  ColorThemeId,
  ProviderTerminalResumeAvailability,
  ProviderTerminalResumeDescriptor,
  ServerEvent,
  ThemePreference,
} from "@shared/contracts";
import type { ConnectionStatus } from "../hooks/useInertiaConnection";
import type { ProviderTerminalResumeOption } from "./providerResumeOptions";

export type TerminalPanelProps = {
  projectId: string;
  conversationId?: string;
  projectName: string;
  status: ConnectionStatus;
  fontSize: number;
  theme: ThemePreference;
  colorTheme?: ColorThemeId;
  sendCommand: (command: ClientCommand) => Promise<ServerEvent>;
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
  actionId?: string | null;
  onActionStarted?: () => void;
  providerResume?: ProviderTerminalResumeAvailability | null;
  providerResumes?: readonly ProviderTerminalResumeOption[];
  resumeRequestConversationId?: string | null;
  onResumeRequestHandled?: () => void;
  onClose: () => void;
  visible?: boolean;
};

export type TerminalReplacement = {
  previousTerminalId: string;
  terminalId: string;
  preservePrevious: boolean;
};

export function providerTerminalExitPresentation(
  provider: ProviderTerminalResumeDescriptor,
  exitCode: number,
): { message: string; state: "closed" | "error" } {
  return exitCode === 0
    ? {
        message: `${provider.providerLabel} session ${provider.sessionId} ended.`,
        state: "closed",
      }
    : {
        message: `${provider.providerLabel} could not resume session ${provider.sessionId}. The saved session may be stale or unavailable; review the provider output above.`,
        state: "error",
      };
}

export const MAX_PERSISTED_TERMINAL_TABS = 4;
export const TERMINAL_CREATE_RETRY_DELAYS_MS = [400, 900] as const;
export const TERMINAL_SETTLING_RETRY_DELAYS_MS = [400, 900, 900] as const;

type CommandWithoutId = ClientCommand extends infer Command
  ? Command extends { requestId: string }
    ? Omit<Command, "requestId">
    : never
  : never;

export const command = (value: CommandWithoutId): ClientCommand => ({
  ...value,
  requestId: crypto.randomUUID(),
}) as ClientCommand;

const MAX_TERMINAL_STORAGE_LENGTH = 4_096;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const terminalPanelOwners = new Map<string, string>();

export type TerminalTab = {
  id: string;
  label: string;
  terminalId: string | null;
};

export function terminalStorageKey(projectId: string, conversationId?: string): string {
  return `inertia:terminal-sessions:v1:${projectId}:${conversationId ?? "project"}`;
}

export function claimTerminalPanelOwner(storageKey: string): string {
  const owner = crypto.randomUUID();
  terminalPanelOwners.set(storageKey, owner);
  try {
    window.sessionStorage.setItem(`${storageKey}:owner`, owner);
  } catch {
    // The in-memory token still prevents a stale panel from winning locally.
  }
  return owner;
}

export function isCurrentTerminalPanelOwner(
  storageKey: string,
  owner: string,
): boolean {
  try {
    const persisted = window.sessionStorage.getItem(`${storageKey}:owner`);
    if (persisted !== null) return persisted === owner;
  } catch {
    // Fall through to the same-renderer authority token.
  }
  return terminalPanelOwners.get(storageKey) === owner;
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

export function nextTerminalTabIndex(tabs: readonly TerminalTab[]): number {
  const used = new Set(tabs.flatMap(({ label }) => {
    const match = /^Terminal (\d+)$/u.exec(label);
    return match ? [Number(match[1]) - 1] : [];
  }));
  let index = 0;
  while (used.has(index)) index += 1;
  return index;
}

export function replaceTerminalTabWithoutHiding(
  tabs: readonly TerminalTab[],
  tabId: string,
  previousTerminalId: string,
  terminalId: string,
  preservePrevious: boolean,
): TerminalTab[] | null {
  const source = tabs.find((tab) => tab.id === tabId);
  const discardable = preservePrevious && tabs.length >= MAX_PERSISTED_TERMINAL_TABS
    ? tabs.find((tab) => tab.id !== tabId && tab.terminalId === null)
    : undefined;
  if (
    source?.terminalId !== previousTerminalId
    || tabs.some((tab) => tab.id !== tabId && tab.terminalId === terminalId)
    || (
      preservePrevious
      && tabs.length >= MAX_PERSISTED_TERMINAL_TABS
      && !discardable
    )
  ) return null;
  const retained = discardable
    ? tabs.filter((tab) => tab.id !== discardable.id)
    : tabs;
  const next = retained.map((tab) => tab.id === tabId
    ? { ...tab, terminalId }
    : tab);
  return preservePrevious
    ? [...next, newTerminalTab(nextTerminalTabIndex(retained), previousTerminalId)]
    : next;
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

export function useTerminalTabsLifecycle(
  storageKey: string,
  tabs: readonly TerminalTab[],
  sendCommand: TerminalPanelProps["sendCommand"],
): React.MutableRefObject<readonly TerminalTab[]> {
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  useEffect(() => {
    persistTerminalTabs(storageKey, tabs);
  }, [storageKey, tabs]);
  useEffect(() => () => {
    for (const { terminalId } of tabsRef.current) {
      if (!terminalId) continue;
      void sendCommand(command({
        type: "terminal.detach",
        payload: { terminalId },
      })).catch(() => undefined);
    }
  }, [sendCommand, storageKey]);
  return tabsRef;
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
}

export function waitForTerminalRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, delayMs));
}

export function terminalTheme(_theme: ThemePreference): {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
} {
  const styles = window.getComputedStyle(document.documentElement);
  return {
    background: styles.getPropertyValue("--terminal-bg").trim(),
    foreground: styles.getPropertyValue("--terminal-fg").trim(),
    cursor: styles.getPropertyValue("--accent").trim(),
    selectionBackground: styles.getPropertyValue("--terminal-selection").trim(),
  };
}
