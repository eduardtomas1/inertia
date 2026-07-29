import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

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
import {
  forgetPersistedDraftConversation,
  readPersistedDraftConversation,
  writePersistedDraftConversation,
} from "../utils/draftConversationPersistence";

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
    activate?: boolean,
  ) => Promise<void>;
  persistedConversationId: string | null;
  updatePersistedConversation: (
    conversationId: string,
    change: ConversationUpdate,
  ) => void;
  }) {
  const [draft, setDraft] = useState<DraftConversationState | null>(() => {
    const stored = readPersistedDraftConversation();
    return (
      !persistedConversationId
      && stored?.conversation.projectId === snapshot?.activeProjectId
    )
      ? stored
      : null;
  });
  const draftRef = useRef(draft);

  const replaceDraft = useCallback((
    next: DraftConversationState | null,
    persist = true,
  ): void => {
    draftRef.current = next;
    setDraft(next);
    if (next && persist) writePersistedDraftConversation(next);
  }, []);

  const start = (projectId: string): void => {
    discard();
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
    replaceDraft({
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

  const clear = useCallback((): void => {
    replaceDraft(null, false);
  }, [replaceDraft]);

  const discard = useCallback((): void => {
    const current = draftRef.current ?? readPersistedDraftConversation();
    replaceDraft(null, false);
    if (!current) return;
    forgetPersistedDraftConversation(current.conversation.id);
    try {
      window.localStorage.removeItem(
        `inertia:draft:${current.conversation.id}`,
      );
    } catch {
      // The draft is already unreachable when storage is unavailable.
    }
  }, [replaceDraft]);

  useEffect(() => {
    if (!snapshot) return;
    const current = draftRef.current;
    if (current) {
      const projectExists = snapshot.projects.some(
        ({ id }) => id === current.conversation.projectId,
      );
      if (!projectExists) {
        discard();
      } else if (
        persistedConversationId
        || snapshot.activeProjectId !== current.conversation.projectId
      ) {
        replaceDraft(null, false);
      }
      return;
    }
    if (persistedConversationId) return;
    const stored = readPersistedDraftConversation();
    if (!stored) return;
    const projectExists = snapshot.projects.some(
      ({ id }) => id === stored.conversation.projectId,
    );
    if (!projectExists) {
      forgetPersistedDraftConversation(stored.conversation.id);
      return;
    }
    if (snapshot.activeProjectId === stored.conversation.projectId) {
      replaceDraft(stored, false);
    }
  }, [
    discard,
    persistedConversationId,
    replaceDraft,
    snapshot,
  ]);

  const chooseModel = (selection: ModelSelection): boolean => {
    if (!draft) return false;
    const payload = withNewConversationModelSelection(
      draft.payload,
      selection,
    );
    replaceDraft({
      payload,
      conversation: buildDraftConversation(payload, {
        id: draft.conversation.id,
        now: draft.conversation.createdAt,
      }),
    });
    return true;
  };

  const updateDraft = (change: ConversationUpdate): void => {
    const current = draftRef.current;
    if (!current) return;
    const next = (() => {
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
    })();
    replaceDraft(next);
  };

  const materializeAndSend = async (
    content: string,
    attachments: ChatAttachment[],
    context?: TurnRequestContext,
  ): Promise<boolean> => {
    const sendingDraft = draftRef.current;
    if (!sendingDraft) return false;
    const creation = await run("conversation.create:draft", {
      type: "conversation.create",
      payload: {
        ...withNewConversationModelSelection(
          sendingDraft.payload,
          sendingDraft.conversation.modelSelection,
        ),
        providerId: sendingDraft.conversation.providerId,
        interactionMode: sendingDraft.conversation.interactionMode,
        accessMode: sendingDraft.conversation.accessMode,
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
    const stillOwnsDraft =
      draftRef.current?.conversation.id === sendingDraft.conversation.id;
    try {
      await sendMessage(
        conversationId,
        content,
        attachments,
        context,
        stillOwnsDraft,
      );
      forgetPersistedDraftConversation(sendingDraft.conversation.id);
      try {
        window.localStorage.removeItem(
          `inertia:draft:${sendingDraft.conversation.id}`,
        );
      } catch {
        // The submitted prompt no longer needs browser persistence.
      }
      if (
        draftRef.current?.conversation.id === sendingDraft.conversation.id
      ) {
        replaceDraft(null, false);
      }
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
    discard,
    chooseModel,
    sendFromComposer,
    updateConversation,
  };
}
