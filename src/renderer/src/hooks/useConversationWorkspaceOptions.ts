import { useMemo } from "react";

import type { Conversation, Project } from "@shared/contracts";

import {
  conversationWorkspaceOptions,
  visibleWorkspaceConversation,
  type ConversationWorkspaceOptions,
} from "../components/workspace-scene/conversationWorkspaceOptions";
import type { useConversationProjection } from "./useConversationProjection";
import type { useInertiaConnection } from "./useInertiaConnection";

const EMPTY_LIST: never[] = [];

export function useConversationWorkspaceOptions(input: {
  connection: ReturnType<typeof useInertiaConnection>;
  projection: ReturnType<typeof useConversationProjection>;
  draftConversation: Conversation | null;
  project: Project | null;
  workspaceToolsUnavailable: boolean;
}): ConversationWorkspaceOptions {
  const { connection, projection, draftConversation, project, workspaceToolsUnavailable } = input;
  const conversations = connection.snapshot?.conversations ?? EMPTY_LIST;
  const projects = connection.snapshot?.projects ?? EMPTY_LIST;
  const providers = connection.snapshot?.providers ?? EMPTY_LIST;
  const persistedConversation = projection.conversation;
  const persistedConversationId = persistedConversation?.id ?? null;
  return useMemo(() => conversationWorkspaceOptions({
    conversations,
    projects,
    providers,
    persistedConversationId,
    conversation: visibleWorkspaceConversation(persistedConversation, draftConversation),
    project,
    workspaceToolsUnavailable,
  }), [
    conversations,
    draftConversation,
    persistedConversation,
    persistedConversationId,
    project,
    projects,
    providers,
    workspaceToolsUnavailable,
  ]);
}
