import { useId, useMemo, useState, type RefObject } from "react";
import type { CustomAgent } from "@shared/custom-agents";
import { paletteScore } from "../../utils/paletteMatch";
import {
  handleComposerSuggestionKey,
  shouldSubmitComposerKey,
} from "../../utils/composerKeyboard";
import {
  nextSidebarNavigationIndex,
  type SidebarNavigationKey,
} from "../../utils/sidebarModel";

const CALLING_PATTERN = /^\/calling(?:\s+([\w-]*))?$/u;
const CALLED_AGENT_KEY_PREFIX = "inertia:called-agent:";
const NO_CUSTOM_AGENTS: readonly CustomAgent[] = [];
const knownAgents = new Map<string, CustomAgent>();

type SuggestionKeyEvent = Parameters<typeof handleComposerSuggestionKey>[0];

export function parseCallingCommand(message: string): string | null {
  const match = CALLING_PATTERN.exec(message.trim());
  return match ? (match[1] ?? "").toLowerCase() : null;
}

export function rankCustomAgents(
  agents: readonly CustomAgent[],
  query: string,
): CustomAgent[] {
  const ordered = [...agents].sort((left, right) => left.position - right.position);
  if (!query) return ordered;
  return ordered
    .map((agent) => ({
      agent,
      rank: agent.handle === query
        ? 6
        : agent.handle.startsWith(query)
          ? 5
          : paletteScore(agent.name, agent.handle, query, agent.handle.replaceAll("-", " ")),
    }))
    .filter(({ rank }) => rank >= 3)
    .sort((left, right) => right.rank - left.rank)
    .map(({ agent }) => agent);
}

export function readCalledAgentId(conversationId: string): string | null {
  try {
    return window.localStorage.getItem(`${CALLED_AGENT_KEY_PREFIX}${conversationId}`);
  } catch {
    return null;
  }
}

export function persistCalledAgentId(conversationId: string, agentId: string | null): void {
  try {
    const key = `${CALLED_AGENT_KEY_PREFIX}${conversationId}`;
    if (agentId) window.localStorage.setItem(key, agentId);
    else window.localStorage.removeItem(key);
  } catch {
    return;
  }
}

export interface ComposerAgentCallOptions {
  conversationId: string;
  message: string;
  customAgents?: readonly CustomAgent[];
  replaceMessage: (next: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onOpenSettings?: () => void;
}

export interface ComposerAgentCall {
  query: string | null;
  menuVisible: boolean;
  listboxId: string;
  agents: readonly CustomAgent[];
  hasAgents: boolean;
  activeAgentId: string | null;
  activeOptionId: string | undefined;
  calledAgent: CustomAgent | null;
  canOpenSettings: boolean;
  setActiveAgentId: (agentId: string) => void;
  pick: (agent: CustomAgent) => void;
  remove: () => void;
  openPicker: () => void;
  openSettings: () => void;
  handleKey: (event: SuggestionKeyEvent) => boolean;
  clearSent: (conversationId: string, agentId: string | undefined) => void;
}

export function useComposerAgentCall({
  conversationId,
  message,
  customAgents = NO_CUSTOM_AGENTS,
  replaceMessage,
  textareaRef,
  onOpenSettings,
}: ComposerAgentCallOptions): ComposerAgentCall {
  const listboxId = `${useId()}-agents`;
  const [called, setCalled] = useState(() => ({
    conversationId,
    agentId: readCalledAgentId(conversationId),
  }));
  const current = called.conversationId === conversationId
    ? called
    : { conversationId, agentId: readCalledAgentId(conversationId) };
  if (current !== called) setCalled(current);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [dismissedValue, setDismissedValue] = useState<string | null>(null);
  const query = parseCallingCommand(message);
  const agents = useMemo(
    () => query === null ? NO_CUSTOM_AGENTS : rankCustomAgents(customAgents, query),
    [customAgents, query],
  );
  const liveCalled = current.agentId
    ? customAgents.find(({ id }) => id === current.agentId) ?? null
    : null;
  if (liveCalled) knownAgents.set(liveCalled.id, liveCalled);
  const calledAgent = liveCalled ?? (current.agentId ? knownAgents.get(current.agentId) ?? null : null);
  const hasAgents = customAgents.length > 0;
  const canOpenSettings = Boolean(onOpenSettings);
  const menuVisible = query !== null && dismissedValue !== message;
  const active = agents.find(({ id }) => id === highlightedId) ?? agents[0] ?? null;
  const activeOptionId = !menuVisible
    ? undefined
    : active
      ? `${listboxId}-${active.id}`
      : !hasAgents && canOpenSettings ? `${listboxId}-settings` : undefined;

  const focusEditor = (): void => {
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  };
  const setCalledAgentId = (agentId: string | null): void => {
    persistCalledAgentId(conversationId, agentId);
    setCalled({ conversationId, agentId });
  };
  const pick = (agent: CustomAgent): void => {
    knownAgents.set(agent.id, agent);
    setCalledAgentId(agent.id);
    setHighlightedId(null);
    setDismissedValue(null);
    replaceMessage("");
    focusEditor();
  };
  const remove = (): void => {
    setCalledAgentId(null);
    focusEditor();
  };
  const openPicker = (): void => {
    setDismissedValue(null);
    replaceMessage("/calling ");
    focusEditor();
  };
  const openSettings = (): void => {
    setDismissedValue(message);
    onOpenSettings?.();
  };
  const move = (key: SidebarNavigationKey): void => {
    if (agents.length === 0) return;
    const next = nextSidebarNavigationIndex(agents.indexOf(active!), key, agents.length);
    setHighlightedId(agents[next]!.id);
  };
  const handleKey = (event: SuggestionKeyEvent): boolean => {
    if (!menuVisible) return false;
    const accept = active
      ? () => pick(active)
      : !hasAgents && canOpenSettings ? openSettings : undefined;
    if (handleComposerSuggestionKey(event, () => setDismissedValue(message), move, accept)) return true;
    if (!shouldSubmitComposerKey(event)) return false;
    event.preventDefault();
    return true;
  };
  const clearSent = (sentConversationId: string, agentId: string | undefined): void => {
    if (!agentId) return;
    if (readCalledAgentId(sentConversationId) === agentId) persistCalledAgentId(sentConversationId, null);
    setCalled((previous) => previous.conversationId === sentConversationId && previous.agentId === agentId
      ? { conversationId: sentConversationId, agentId: null }
      : previous);
  };

  return {
    query,
    menuVisible,
    listboxId,
    agents,
    hasAgents,
    activeAgentId: active?.id ?? null,
    activeOptionId,
    calledAgent,
    canOpenSettings,
    setActiveAgentId: setHighlightedId,
    pick,
    remove,
    openPicker,
    openSettings,
    handleKey,
    clearSent,
  };
}
