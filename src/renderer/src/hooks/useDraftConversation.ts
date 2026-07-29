import { useCallback, useState } from "react";

import type {
  AppSettings,
  AppSnapshot,
  ChatAttachment,
  ClientCommand,
  Conversation,
  ModelSelection,
  ServerEvent,
  TurnRequestContext,
} from "@shared/contracts";
import { legacyProviderIdForHarness } from "../../../shared/model-routing";
import {
  buildDraftConversation,
  buildNewConversationPayload,
  withNewConversationModelSelection,
} from "../lib/newConversation";
import { projectNameFromPath } from "../lib/format";
import type { CommandWithoutId } from "../lib/runtimeCommands";

type ConversationCreatePayload = Extract<
  ClientCommand,
  { type: "conversation.create" }
>["payload"];

type ConversationUpdate = Partial<Pick<
  Conversation,
  | "providerId"
  | "modelSelection"
  | "model"
  | "reasoningEffort"
  | "interactionMode"
  | "accessMode"
>>;

interface DraftConversationState {
  conversation: Conversation;
  payload: ConversationCreatePayload;
}

export function useDraftConversation({
  snapshot,
  settings,
  run,
  request,
  sendMessage,
  persistedConversationId,
  updatePersistedConversation,
}: {
  snapshot: AppSnapshot | null;
  settings: AppSettings;
  run: (
    key: string,
    command: CommandWithoutId,
  ) => Promise<ServerEvent>;
  request: (command: CommandWithoutId) => Promise<ServerEvent>;
  sendMessage: (
    conversationId: string,
    content: string,
    attachments: ChatAttachment[],
    context?: TurnRequestContext,
  ) => Promise<void>;
  persistedConversationId: string | null;
  updatePersistedConversation: (
    conversationId: string,
    change: ConversationUpdate,
  ) => void;
}) {
  const [draft, setDraft] = useState<DraftConversationState | null>(null);

  const start = (projectId: string): void => {
    const backendDefault = snapshot?.backendDefaults?.find(
      ({ scope }) => scope === "global",
    );
    const defaultPayload = buildNewConversationPayload(projectId, settings);
    const payload = backendDefault
      ? withNewConversationModelSelection(
          defaultPayload,
          backendDefault.selection,
        )
      : defaultPayload;
    setDraft({
      conversation: buildDraftConversation(payload),
      payload,
    });
  };

  const importProject = async (): Promise<boolean> => {
    const path = await window.inertia.selectDirectory();
    if (!path) return false;
    const event = await run("project.create", {
      type: "project.create",
      payload: { name: projectNameFromPath(path), path },
    });
    if (
      event.type !== "request.result"
      || event.result.kind !== "project.created"
    ) {
      throw new Error(
        "The local service returned an unexpected project response.",
      );
    }
    start(event.result.projectId);
    return true;
  };

  const clear = useCallback((): void => setDraft(null), []);

  const chooseModel = (selection: ModelSelection): boolean => {
    if (!draft) return false;
    const payload = withNewConversationModelSelection(
      draft.payload,
      selection,
    );
    setDraft({
      payload,
      conversation: buildDraftConversation(payload, {
        id: draft.conversation.id,
        now: draft.conversation.createdAt,
      }),
    });
    return true;
  };

  const updateDraft = (change: ConversationUpdate): void => {
    setDraft((current) => {
      if (!current) return current;
      const selection = change.modelSelection
        ? {
            ...change.modelSelection,
            providerOptions: { ...change.modelSelection.providerOptions },
            capabilities: change.modelSelection.capabilities.map(
              (capability) => ({ ...capability }),
            ),
          }
        : change.reasoningEffort !== undefined
          ? {
              ...current.conversation.modelSelection,
              reasoningEffort: change.reasoningEffort,
            }
          : current.conversation.modelSelection;
      const providerId = change.providerId
        ?? legacyProviderIdForHarness(selection.harnessId)
        ?? current.conversation.providerId;
      const conversation = {
        ...current.conversation,
        ...change,
        providerId,
        modelSelection: selection,
        model: selection.modelId === "provider-default"
          ? ""
          : selection.modelId,
        reasoningEffort: selection.reasoningEffort
          ?? change.reasoningEffort
          ?? current.conversation.reasoningEffort,
        updatedAt: new Date().toISOString(),
      };
      return {
        conversation,
        payload: {
          ...withNewConversationModelSelection(current.payload, selection),
          interactionMode: conversation.interactionMode,
          accessMode: conversation.accessMode,
        },
      };
    });
  };

  const materializeAndSend = async (
    content: string,
    attachments: ChatAttachment[],
    context?: TurnRequestContext,
  ): Promise<boolean> => {
    if (!draft) return false;
    const creation = await run("conversation.create:draft", {
      type: "conversation.create",
      payload: {
        ...withNewConversationModelSelection(
          draft.payload,
          draft.conversation.modelSelection,
        ),
        providerId: draft.conversation.providerId,
        interactionMode: draft.conversation.interactionMode,
        accessMode: draft.conversation.accessMode,
        activate: false,
      },
    });
    if (
      creation.type !== "request.result"
      || creation.result.kind !== "conversation.created"
    ) {
      throw new Error("The local service returned an unexpected chat response.");
    }
    const conversationId = creation.result.conversationId;
    try {
      await sendMessage(conversationId, content, attachments, context);
      window.localStorage.removeItem(
        `inertia:draft:${draft.conversation.id}`,
      );
      setDraft((current) => (
        current?.conversation.id === draft.conversation.id ? null : current
      ));
      return true;
    } catch (error) {
      void request({
        type: "conversation.delete",
        payload: { conversationId },
      }).catch(() => undefined);
      throw error;
    }
  };

  const sendFromComposer = async (
    content: string,
    attachments: ChatAttachment[],
    context?: TurnRequestContext,
  ): Promise<void> => {
    if (persistedConversationId) {
      await sendMessage(
        persistedConversationId,
        content,
        attachments,
        context,
      );
      return;
    }
    await materializeAndSend(content, attachments, context);
  };

  const updateConversation = (change: ConversationUpdate): void => {
    if (persistedConversationId) {
      updatePersistedConversation(persistedConversationId, change);
    } else {
      updateDraft(change);
    }
  };

  return {
    conversation: draft?.conversation ?? null,
    start,
    importProject,
    clear,
    chooseModel,
    sendFromComposer,
    updateConversation,
  };
}
