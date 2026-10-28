import { useEffect, useRef } from "react";
import type {
  ClientCommand,
  ColorThemeId,
  ProviderTerminalResumeAvailability,
  ProviderTerminalResumeDescriptor,
  ServerEvent,
  ThemePreference,
} from "@shared/contracts";
import { MAX_PERSISTED_TERMINAL_TABS } from "@shared/terminal-handoff";
import {
  newTerminalTab,
  persistTerminalTabs,
  type TerminalTab,
} from "./terminalTabStorage";
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
  lightColorTheme?: ColorThemeId;
  darkColorTheme?: ColorThemeId;
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

export { MAX_PERSISTED_TERMINAL_TABS };
export {
  liveTerminalIdsForHandoff,
  markTerminalPanelMounted,
  newTerminalTab,
  persistTerminalTabs,
  readPersistedTerminalTabs,
  terminalStorageKey,
  type TerminalTab,
} from "./terminalTabStorage";
export const TERMINAL_CREATE_RETRY_DELAYS_MS = [400, 900] as const;
export const TERMINAL_SETTLING_RETRY_DELAYS_MS = [400, 900, 900] as const;
export const TERMINAL_CLOSE_FAILURE_MESSAGE = "Terminal did not stop";

type CommandWithoutId = ClientCommand extends infer Command
  ? Command extends { requestId: string }
    ? Omit<Command, "requestId">
    : never
  : never;

export const command = (value: CommandWithoutId): ClientCommand => ({
  ...value,
  requestId: crypto.randomUUID(),
}) as ClientCommand;

export const terminalCloseCommand = (terminalId: string): ClientCommand => command({
  type: "terminal.close",
  payload: { terminalId },
});

export const terminalDetachCommand = (terminalId: string): ClientCommand => command({
  type: "terminal.detach",
  payload: { terminalId },
});

export const terminalSize = (cols: number, rows: number): { cols: number; rows: number } => ({
  cols: Math.min(400, Math.max(20, cols)),
  rows: Math.min(200, Math.max(4, rows)),
});

export const terminalResizeCommand = (
  terminalId: string,
  size: { cols: number; rows: number },
): ClientCommand => command({
  type: "terminal.resize",
  payload: { terminalId, ...size },
});

export const ignoreCommandFailure = (result: Promise<ServerEvent>): void => {
  void result.catch(() => undefined);
};

const terminalPanelOwners = new Map<string, string>();

export function claimTerminalPanelOwner(
  storageKey: string,
  owner: string,
): void {
  terminalPanelOwners.set(storageKey, owner);
  try {
    window.sessionStorage.setItem(`${storageKey}:owner`, owner);
  } catch {
    // The in-memory token still prevents a stale panel from winning locally.
  }
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

export function nextTerminalTabIndex(tabs: readonly TerminalTab[]): number {
  const used = new Set(tabs.flatMap(({ label }) => {
    const match = /^Terminal (\d+)$/u.exec(label);
    return match ? [Number(match[1]) - 1] : [];
  }));
  let index = 0;
  while (used.has(index)) index += 1;
  return index;
}

export function appendTerminalTab(
  tabs: TerminalTab[],
  activate: (id: string) => void,
): TerminalTab[] {
  if (tabs.length >= MAX_PERSISTED_TERMINAL_TABS) return tabs;
  const tab = newTerminalTab(nextTerminalTabIndex(tabs));
  window.queueMicrotask(() => activate(tab.id));
  return [...tabs, tab];
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
      ignoreCommandFailure(sendCommand(terminalDetachCommand(terminalId)));
    }
  }, [sendCommand, storageKey]);
  return tabsRef;
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
