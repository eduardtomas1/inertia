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
  MessageSendAcceptance,
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
import { runtimeCommandDelivery } from "../utils/connectionMessages";
import {
  forgetPersistedDraftConversation,
  forgetPersistedMaterializedDraftConversation,
  markPersistedDraftConversationMaterialized,
  readPersistedDraftConversation,
  readPersistedMaterializedDraftConversation,
  writePersistedDraftConversation,
} from "../utils/draftConversationPersistence";
import type {
  TranscriptMessageSendAcceptance,
} from "../utils/transcriptNavigation";

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
  materialized: {
    draftConversationId: string;
    conversationId: string;
    awaitingReconciliation: boolean;
  } | null;
}

export function useDraftConversation({
  snapshot,
  settings,
  run,
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
  sendMessage: (
    conversationId: string,
    content: string,
    attachments: ChatAttachment[],
    context?: TurnRequestContext,
    skillIds?: readonly string[],
    activate?: boolean,
  ) => Promise<MessageSendAcceptance | null>;
  persistedConversationId: string | null;
  updatePersistedConversation: (
    conversationId: string,
    change: ConversationUpdate,
  ) => Promise<void>;
  }) {
  const [draft, setDraft] = useState<DraftConversationState | null>(() => {
    const stored = readPersistedDraftConversation();
    return (
      stored
      &&
      !persistedConversationId
      && stored.conversation.projectId === snapshot?.activeProjectId
    )
      ? { ...stored, materialized: null }
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
      materialized: null,
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
    const persisted = readPersistedDraftConversation();
    const current = draftRef.current ?? (
      persisted ? { ...persisted, materialized: null } : null
    );
    replaceDraft(null, false);
    if (!current) return;
    if (current.materialized) {
      forgetPersistedMaterializedDraftConversation(
        current.materialized.conversationId,
      );
    } else {
      forgetPersistedDraftConversation(current.conversation.id);
    }
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
    const materialized = readPersistedMaterializedDraftConversation();
    const materializedShell = materialized
      ? snapshot.conversations.find(
          ({ id }) => id === materialized.materializedConversationId,
        )
      : null;
    if (materialized && materializedShell) {
      const accepted = (
        materializedShell.latestTurn !== null
        ||
        materializedShell.status !== "idle"
        || (
          materializedShell.title !== "New chat"
          && materializedShell.title !== "New thread"
        )
      );
      const current = draftRef.current;
      if (accepted) {
        forgetPersistedMaterializedDraftConversation(
          materialized.materializedConversationId,
        );
        if (
          current?.materialized
          && current.materialized.conversationId
            === materialized.materializedConversationId
        ) {
          replaceDraft(null, false);
        }
      } else if (
        current?.materialized
        && current.materialized.conversationId
          === materialized.materializedConversationId
        && current.materialized.awaitingReconciliation
      ) {
        replaceDraft({
          ...current,
          conversation: {
            ...materializedShell,
            id: current.conversation.id,
          },
          materialized: {
            ...current.materialized,
            awaitingReconciliation: false,
          },
        }, false);
      } else if (
        !current
        && snapshot.activeProjectId === materialized.conversation.projectId
      ) {
        replaceDraft({
          conversation: {
            ...materializedShell,
            id: materialized.draftConversationId,
          },
          payload: materialized.payload,
          materialized: {
            draftConversationId: materialized.draftConversationId,
            conversationId: materialized.materializedConversationId,
            awaitingReconciliation: false,
          },
        }, false);
      }
    } else if (
      materialized
      && !snapshot.projects.some(
        ({ id }) => id === materialized.conversation.projectId,
      )
    ) {
      forgetPersistedMaterializedDraftConversation(
        materialized.materializedConversationId,
      );
    }
    const current = draftRef.current;
    if (current) {
      const projectExists = snapshot.projects.some(
        ({ id }) => id === current.conversation.projectId,
      );
      if (!projectExists) {
        discard();
      } else if (
        (
          persistedConversationId
          && current.materialized?.conversationId !== persistedConversationId
        )
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
      replaceDraft({ ...stored, materialized: null }, false);
    }
  }, [
    discard,
    persistedConversationId,
    replaceDraft,
    snapshot,
  ]);

  const chooseModel = (selection: ModelSelection): boolean => {
    if (!draft || draft.materialized) return false;
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
      materialized: null,
    });
    return true;
  };

  const updateDraft = (change: ConversationUpdate): void => {
    const current = draftRef.current;
    if (!current || current.materialized) return;
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
        materialized: null,
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
    skillIds?: readonly string[],
  ): Promise<TranscriptMessageSendAcceptance | null> => {
    const sendingDraft = draftRef.current;
    if (!sendingDraft) return null;
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
    const materializedState: DraftConversationState = {
      conversation: sendingDraft.conversation,
      payload: sendingDraft.payload,
      materialized: {
        draftConversationId: sendingDraft.conversation.id,
        conversationId,
        awaitingReconciliation: false,
      },
    };
    markPersistedDraftConversationMaterialized({
      draftConversationId: sendingDraft.conversation.id,
      materializedConversationId: conversationId,
      conversation: materializedState.conversation,
      payload: materializedState.payload,
    });
    forgetPersistedDraftConversation(sendingDraft.conversation.id);
    if (stillOwnsDraft) replaceDraft(materializedState, false);

    try {
      const acceptance = await sendMessage(
        conversationId,
        content,
        attachments,
        context,
        skillIds,
        stillOwnsDraft,
      );
      forgetPersistedMaterializedDraftConversation(conversationId);
      if (
        draftRef.current?.materialized?.conversationId === conversationId
      ) {
        replaceDraft(null, false);
      }
      return acceptance
        ? {
            ...acceptance,
            materializedFromConversationId: sendingDraft.conversation.id,
          }
        : null;
    } catch (error) {
      if (
        draftRef.current?.materialized?.conversationId === conversationId
      ) {
        replaceDraft({
          ...materializedState,
          materialized: {
            ...materializedState.materialized!,
            awaitingReconciliation:
              runtimeCommandDelivery(error) === "ambiguous"
              || runtimeCommandDelivery(error) === null,
          },
        }, false);
      }
      throw error;
    }
  };

  const sendFromComposer = async (
    content: string,
    attachments: ChatAttachment[],
    context?: TurnRequestContext,
    skillIds?: readonly string[],
  ): Promise<TranscriptMessageSendAcceptance | null> => {
    const current = draftRef.current;
    if (current?.materialized) {
      if (current.materialized.awaitingReconciliation) {
        throw new Error(
          "Inertia is reconciling the first message after reconnecting.",
        );
      }
      try {
        const acceptance = await sendMessage(
          current.materialized.conversationId,
          content,
          attachments,
          context,
          skillIds,
          true,
        );
        forgetPersistedMaterializedDraftConversation(
          current.materialized.conversationId,
        );
        if (
          draftRef.current?.materialized?.conversationId
            === current.materialized.conversationId
        ) {
          replaceDraft(null, false);
        }
        return acceptance
          ? {
              ...acceptance,
              materializedFromConversationId:
                current.materialized.draftConversationId,
            }
          : null;
      } catch (error) {
        if (
          draftRef.current?.materialized?.conversationId
            === current.materialized.conversationId
        ) {
          replaceDraft({
            ...current,
            materialized: {
              ...current.materialized,
              awaitingReconciliation:
                runtimeCommandDelivery(error) === "ambiguous"
                || runtimeCommandDelivery(error) === null,
            },
          }, false);
        }
        throw error;
      }
    }
    if (persistedConversationId && !current) {
      return await sendMessage(
        persistedConversationId,
        content,
        attachments,
        context,
        skillIds,
      );
    }
    return await materializeAndSend(content, attachments, context, skillIds);
  };

  const updateConversation = async (change: ConversationUpdate): Promise<void> => {
    const current = draftRef.current;
    if (current?.materialized) {
      await updatePersistedConversation(
        current.materialized.conversationId,
        // Updates target the server-owned shell while Composer keeps its
        // stable local draft identity until reconciliation finishes.
        change,
      );
    } else if (current) {
      updateDraft(change);
    } else if (persistedConversationId) {
      await updatePersistedConversation(persistedConversationId, change);
    } else {
      updateDraft(change);
    }
  };

  return {
    conversation: draft?.conversation ?? null,
    requiresWorkspaceMaterialization: Boolean(
      draft?.payload.useWorktree && !draft.payload.worktreePath,
    ),
    start,
    importProject,
    clear,
    discard,
    chooseModel,
    sendFromComposer,
    updateConversation,
  };
}
