import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
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
import { persistCalledAgentId, readCalledAgentId } from "./calledAgentStorage";

export { persistCalledAgentId, readCalledAgentId } from "./calledAgentStorage";

const CALLING_PATTERN = /^\/calling(?:\s+([\w-]*))?$/u;
const CALLING_INVOCATION_PATTERN = /^\/calling(?:\s+([\w-]+))?(?:\s+([\s\S]*))?$/u;
const TYPED_CALL_PATTERN = /^\/calling\s+([\w-]+)\s+([\s\S]*)$/u;
const NO_CUSTOM_AGENTS: readonly CustomAgent[] = [];
const LOADING_MESSAGE = "Custom agents are still loading. Try again in a moment.";
const DELETED_MESSAGE = "The agent you called was deleted. Remove it to send.";
const RUNNING_MESSAGE = "Wait for this turn to finish before calling an agent.";

type SuggestionKeyEvent = Parameters<typeof handleComposerSuggestionKey>[0];

export type AgentCallSubmission =
  | { kind: "send"; content: string; agentId: string | null }
  | { kind: "hold"; error: string | null };

export function parseCallingCommand(message: string): string | null {
  const match = CALLING_PATTERN.exec(message.trim());
  return match ? (match[1] ?? "").toLowerCase() : null;
}

export function parseCallingInvocation(message: string): { handle: string | null; rest: string } | null {
  const match = CALLING_INVOCATION_PATTERN.exec(message.trim());
  return match ? { handle: match[1]?.toLowerCase() ?? null, rest: (match[2] ?? "").trim() } : null;
}

export function parseTypedCall(message: string): { handle: string; rest: string } | null {
  const match = TYPED_CALL_PATTERN.exec(message.trimStart());
  return match ? { handle: match[1]!.toLowerCase(), rest: match[2]!.trimStart() } : null;
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
  calledAgentId: string | null;
  calledAgentDeleted: boolean;
  canOpenSettings: boolean;
  setActiveAgentId: (agentId: string) => void;
  pick: (agent: CustomAgent, rest?: string) => void;
  remove: () => void;
  openPicker: () => void;
  openSettings: () => void;
  handleKey: (event: SuggestionKeyEvent) => boolean;
  resolveSubmit: (message: string, running: boolean) => AgentCallSubmission;
  clearSent: (conversationId: string, agentId: string | undefined) => void;
}

export function useComposerAgentCall({
  conversationId,
  message,
  customAgents,
  replaceMessage,
  textareaRef,
  onOpenSettings,
}: ComposerAgentCallOptions): ComposerAgentCall {
  const listboxId = `${useId()}-agents`;
  const loaded = customAgents !== undefined;
  const available = customAgents ?? NO_CUSTOM_AGENTS;
  const [called, setCalled] = useState(() => ({
    conversationId,
    agentId: readCalledAgentId(conversationId),
  }));
  const current = called.conversationId === conversationId
    ? called
    : { conversationId, agentId: readCalledAgentId(conversationId) };
  if (current !== called) setCalled(current);
  const [highlight, setHighlight] = useState<{ query: string; agentId: string } | null>(null);
  const [dismissedValue, setDismissedValue] = useState<string | null>(null);
  const query = parseCallingCommand(message);
  const agents = useMemo(
    () => query === null ? NO_CUSTOM_AGENTS : rankCustomAgents(available, query),
    [available, query],
  );
  const calledAgent = current.agentId
    ? available.find(({ id }) => id === current.agentId) ?? null
    : null;
  const calledAgentDeleted = Boolean(current.agentId && loaded && !calledAgent);
  const hasAgents = available.length > 0;
  const canOpenSettings = Boolean(onOpenSettings);
  const menuVisible = query !== null && dismissedValue !== message;
  const highlighted = highlight && highlight.query === query
    ? agents.find(({ id }) => id === highlight.agentId)
    : undefined;
  const active = highlighted ?? agents[0] ?? null;
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
  const pick = (agent: CustomAgent, rest = ""): void => {
    setCalledAgentId(agent.id);
    setHighlight(null);
    setDismissedValue(null);
    replaceMessage(rest);
    focusEditor();
  };
  const pickRef = useRef(pick);
  useLayoutEffect(() => {
    pickRef.current = pick;
  });
  useEffect(() => {
    if (!customAgents) return;
    const typed = parseTypedCall(message);
    const agent = typed && customAgents.find(({ handle }) => handle === typed.handle);
    if (typed && agent) pickRef.current(agent, typed.rest);
  }, [customAgents, message]);
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
  const setActiveAgentId = (agentId: string): void => setHighlight({ query: query ?? "", agentId });
  const move = (key: SidebarNavigationKey): void => {
    if (agents.length === 0) return;
    const next = nextSidebarNavigationIndex(agents.indexOf(active!), key, agents.length);
    setActiveAgentId(agents[next]!.id);
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
  const resolveSubmit = (text: string, running: boolean): AgentCallSubmission => {
    const invocation = parseCallingInvocation(text);
    if (invocation) {
      if (!loaded) return { kind: "hold", error: LOADING_MESSAGE };
      const agent = invocation.handle ? available.find(({ handle }) => handle === invocation.handle) : undefined;
      if (!agent) {
        if (invocation.handle) return { kind: "hold", error: `No custom agent answers to /calling ${invocation.handle}.` };
        setDismissedValue(null);
        return { kind: "hold", error: null };
      }
      if (!invocation.rest) {
        pick(agent);
        return { kind: "hold", error: null };
      }
      if (running) return { kind: "hold", error: RUNNING_MESSAGE };
      return { kind: "send", content: invocation.rest, agentId: agent.id };
    }
    if (!current.agentId) return { kind: "send", content: text, agentId: null };
    if (!loaded) return { kind: "hold", error: LOADING_MESSAGE };
    if (!calledAgent) return { kind: "hold", error: DELETED_MESSAGE };
    return { kind: "send", content: text, agentId: calledAgent.id };
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
    calledAgentId: current.agentId,
    calledAgentDeleted,
    canOpenSettings,
    setActiveAgentId,
    pick,
    remove,
    openPicker,
    openSettings,
    handleKey,
    resolveSubmit,
    clearSent,
  };
}
