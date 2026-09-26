import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { ProjectImportInput } from "../../../shared/project-import";
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
import { providerIdForHarness } from "../../../shared/model-routing";
import {
  buildDraftConversation,
  buildNewConversationPayload,
  withNewConversationModelSelection,
} from "../lib/newConversation";
import { defaultConversationPayloadForProject } from "../utils/defaultConversationSelection";
import { projectNameFromPath } from "../lib/format";
import type { CommandWithoutId } from "../lib/runtimeCommands";
import type { ConversationContextCommandRunner } from "../components/conversation-context/types";
import { runtimeCommandDelivery } from "../utils/connectionMessages";
import {
  forgetPersistedDraftConversation,
  forgetPersistedMaterializedDraftConversation,
  markPersistedDraftConversationMaterialized,
  markPersistedMaterializedDraftConversationAccepted,
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

const REFERENCE_DRAFT_CHANGED = "The new chat changed before its reference could be added.";

interface DraftConversationState {
  conversation: Conversation;
  payload: ConversationCreatePayload;
  materialized: {
    acceptedTurnId: string | null;
    acceptedUserMessageId: string | null;
    draftConversationId: string;
    conversationId: string;
    awaitingReconciliation: boolean;
    recoveryMode: boolean;
  } | null;
}

export function useDraftConversation({
  snapshot,
  settings,
  run,
  runNavigationCommand,
  sendMessage,
  persistedConversationId,
  updatePersistedConversation,
  onMaterialized,
}: {
  snapshot: AppSnapshot | null;
  settings: AppSettings;
  run: (
    key: string,
    command: CommandWithoutId,
  ) => Promise<ServerEvent>;
  runNavigationCommand?: (
    key: string,
    command: CommandWithoutId,
  ) => Promise<ServerEvent>;
  sendMessage: (
    conversationId: string,
    content: string,
    attachments: ChatAttachment[],
    context?: TurnRequestContext,
    activate?: boolean,
  ) => Promise<MessageSendAcceptance | null>;
  persistedConversationId: string | null;
  updatePersistedConversation: (
    conversationId: string,
    change: ConversationUpdate,
  ) => Promise<void>;
  onMaterialized?: (projectId: string, draftConversationId: string, conversationId: string) => void;
  }) {
  const [draft, setDraft] = useState<DraftConversationState | null>(() => {
    const stored = readPersistedDraftConversation();
    return (
      stored
      && !stored.resumeAfterSearch
      &&
      !persistedConversationId
      && stored.conversation.projectId === snapshot?.activeProjectId
    )
      ? { ...stored, materialized: null }
      : null;
  });
  const draftRef = useRef(draft);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const selectionWhenDraftOpenedRef = useRef(persistedConversationId);
  const independentDraftRef = useRef(false);
  const explicitModelRef = useRef(false);

  const replaceDraft = useCallback((
    next: DraftConversationState | null,
    persist = true,
  ): void => {
    draftRef.current = next;
    setDraft(next);
    if (next && persist) writePersistedDraftConversation(next);
  }, []);

  const start = (projectId: string, independent = false, resume = false): void => {
    const stored = resume ? readPersistedDraftConversation() : null;
    if (stored && snapshot?.projects.some(({ id }) => id === stored.conversation.projectId)) {
      independentDraftRef.current = independent;
      selectionWhenDraftOpenedRef.current = persistedConversationId;
      writePersistedDraftConversation({ ...stored, resumeAfterSearch: false });
      replaceDraft({ conversation: stored.conversation, payload: stored.payload, materialized: null }, false);
      return;
    }
    discard();
    independentDraftRef.current = independent;
    explicitModelRef.current = false;
    selectionWhenDraftOpenedRef.current = persistedConversationId;
    const payload = snapshot
      ? defaultConversationPayloadForProject(snapshot, settings, projectId)
      : buildNewConversationPayload(projectId, settings);
    replaceDraft({
      conversation: buildDraftConversation(payload),
      payload,
      materialized: null,
    });
  };

  const changeProject = (projectId: string): void => {
    const current = draftRef.current;
    if (!current || current.materialized || current.conversation.projectId === projectId
      || !snapshot?.projects.some(({ id }) => id === projectId)) return;
    const defaults = defaultConversationPayloadForProject(snapshot, settings, projectId);
    const payload = {
      ...(explicitModelRef.current
        ? withNewConversationModelSelection(defaults, current.conversation.modelSelection)
        : defaults),
      interactionMode: current.conversation.interactionMode,
      accessMode: current.conversation.accessMode,
    };
    // Keep the composer identity (prompt and attachments), but rebuild the
    // project-owned checkout and defaults. Selecting a project is not navigation.
    replaceDraft({
      conversation: buildDraftConversation(payload, {
        id: current.conversation.id,
        now: current.conversation.createdAt,
      }),
      payload,
      materialized: null,
    });
  };

  const importProject = async (input?: ProjectImportInput): Promise<boolean> => {
    const path = input?.path ?? await window.inertia.selectDirectory();
    if (!path) return false;
    const event = await (runNavigationCommand ?? run)("project.create", {
      type: "project.create",
      payload: { name: input?.clone?.directoryName ?? projectNameFromPath(path), path, ...(input?.clone ? { clone: input.clone } : {}) },
    });
    if (
      event.type !== "request.result"
      || event.result.kind !== "project.created"
    ) {
      throw new Error(
        "The local service returned an unexpected project response.",
      );
    }
    // Project import is an explicit navigation boundary. Keep the new-chat
    // draft alive while the project snapshot catches up, including when the
    // imported path resolves to an already-known project.
    start(event.result.projectId, true);
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
    const inMemory = draftRef.current;
    const materialized = inMemory?.materialized
      ? {
          acceptedTurnId: inMemory.materialized.acceptedTurnId,
          acceptedUserMessageId:
            inMemory.materialized.acceptedUserMessageId,
          draftConversationId: inMemory.materialized.draftConversationId,
          materializedConversationId:
            inMemory.materialized.conversationId,
          conversation: inMemory.conversation,
          payload: inMemory.payload,
        }
      : readPersistedMaterializedDraftConversation();
    const materializedShell = materialized
      ? snapshot.conversations.find(
          ({ id }) => id === materialized.materializedConversationId,
        )
      : null;
    if (materialized && materializedShell) {
      const current = draftRef.current;
      const currentMaterialized = (
        current?.materialized?.conversationId
          === materialized.materializedConversationId
      )
        ? current.materialized
        : null;
      const acceptedTurnId = currentMaterialized?.acceptedTurnId
        ?? materialized.acceptedTurnId;
      const exactAcceptedTurn = acceptedTurnId !== null
        && materializedShell.latestTurn?.id === acceptedTurnId;
      const crashRecoveryAccepted = acceptedTurnId === null && (
        currentMaterialized === null
        || currentMaterialized.recoveryMode
      ) && (
        materializedShell.latestTurn !== null
        ||
        materializedShell.status !== "idle"
        || (
          materializedShell.title !== "New chat"
          && materializedShell.title !== "New thread"
        )
      );
      const accepted = persistedConversationId
          === materialized.materializedConversationId
        && (exactAcceptedTurn || crashRecoveryAccepted);
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
            acceptedTurnId: materialized.acceptedTurnId,
            acceptedUserMessageId: materialized.acceptedUserMessageId,
            draftConversationId: materialized.draftConversationId,
            conversationId: materialized.materializedConversationId,
            awaitingReconciliation: false,
            recoveryMode: true,
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
      } else if (!independentDraftRef.current && (
        (
          persistedConversationId
          // Opening a global draft leaves the prior chat selected. Refreshing
          // that same selection is not navigation away from the new draft.
          && persistedConversationId !== selectionWhenDraftOpenedRef.current
          && current.materialized?.conversationId !== persistedConversationId
        )
        || snapshot.activeProjectId !== current.conversation.projectId
      )) {
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
    if (!stored.resumeAfterSearch && snapshot.activeProjectId === stored.conversation.projectId) {
      replaceDraft({ ...stored, materialized: null }, false);
    }
  }, [
    discard,
    persistedConversationId,
    replaceDraft,
    snapshot,
    draft?.materialized?.acceptedTurnId,
  ]);

  const chooseModel = (
    selection: ModelSelection,
    configuration?: Pick<Conversation, "accessMode" | "interactionMode">,
  ): boolean => {
    if (!draft || draft.materialized) return false;
    explicitModelRef.current = true;
    const payload = withNewConversationModelSelection(
      { ...draft.payload, ...configuration },
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
    if (change.modelSelection || change.reasoningEffort !== undefined || change.providerId) {
      explicitModelRef.current = true;
    }
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
        ?? providerIdForHarness(selection.harnessId)
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

  const createDraftConversation = async (
    sendingDraft: DraftConversationState,
    preserveDraftId: boolean,
  ): Promise<string> => {
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
        ...(preserveDraftId ? { draftConversationId: sendingDraft.conversation.id } : {}),
      },
    });
    if (
      creation.type !== "request.result"
      || creation.result.kind !== "conversation.created"
    ) {
      throw new Error("The local service returned an unexpected chat response.");
    }
    return creation.result.conversationId;
  };

  const materializeDraft = async (
    sendingDraft: DraftConversationState,
    preserveDraftId = false,
  ): Promise<DraftConversationState> => {
    const conversationId = preserveDraftId && snapshotRef.current?.conversations.some(({ id, projectId }) => (
      id === sendingDraft.conversation.id && projectId === sendingDraft.conversation.projectId
    ))
      ? sendingDraft.conversation.id
      : await createDraftConversation(sendingDraft, preserveDraftId);
    const stillOwnsDraft =
      draftRef.current?.conversation.id === sendingDraft.conversation.id;
    if (preserveDraftId && (conversationId !== sendingDraft.conversation.id || draftRef.current !== sendingDraft)) {
      throw new Error(REFERENCE_DRAFT_CHANGED);
    }
    const materializedState: DraftConversationState = {
      conversation: sendingDraft.conversation,
      payload: sendingDraft.payload,
      materialized: {
        acceptedTurnId: null,
        acceptedUserMessageId: null,
        draftConversationId: sendingDraft.conversation.id,
        conversationId,
        awaitingReconciliation: false,
        recoveryMode: false,
      },
    };
    markPersistedDraftConversationMaterialized({
      acceptedTurnId: null,
      acceptedUserMessageId: null,
      draftConversationId: sendingDraft.conversation.id,
      materializedConversationId: conversationId,
      conversation: materializedState.conversation,
      payload: materializedState.payload,
    });
    forgetPersistedDraftConversation(sendingDraft.conversation.id);
    if (stillOwnsDraft) {
      if (sendingDraft.conversation.id !== conversationId) {
        onMaterialized?.(sendingDraft.conversation.projectId, sendingDraft.conversation.id, conversationId);
      }
      replaceDraft(materializedState, false);
    }
    return materializedState;
  };

  const runConversationContextCommand: ConversationContextCommandRunner = async (key, command) => {
    const current = draftRef.current;
    if (command.type === "conversation.context.create"
      && current?.conversation.id === command.payload.targetConversationId) {
      const saved = current.materialized ? current : await materializeDraft(current, true);
      if (saved.materialized!.conversationId !== current.conversation.id) {
        throw new Error("Reopen the saved chat before adding a reference.");
      }
      if (draftRef.current !== saved) {
        throw new Error(REFERENCE_DRAFT_CHANGED);
      }
      // Reference packets require a durable target. Retain the composer's ID
      // and draft text, then subscribe through ordinary conversation selection.
      // No provider turn is started until the user sends their message.
      await (runNavigationCommand ?? run)("conversation.select", {
        type: "conversation.select",
        payload: { conversationId: saved.materialized!.conversationId },
      });
      if (draftRef.current?.conversation.id !== current.conversation.id) {
        throw new Error(REFERENCE_DRAFT_CHANGED);
      }
      forgetPersistedMaterializedDraftConversation(saved.materialized!.conversationId);
      replaceDraft(null, false);
    }
    return run(key, command);
  };

  const materializeAndSend = async (
    content: string,
    attachments: ChatAttachment[],
    context?: TurnRequestContext,
  ): Promise<TranscriptMessageSendAcceptance | null> => {
    const sendingDraft = draftRef.current;
    if (!sendingDraft) return null;
    const materializedState = await materializeDraft(sendingDraft);
    const conversationId = materializedState.materialized!.conversationId;
    const stillOwnsDraft = draftRef.current?.conversation.id === sendingDraft.conversation.id;

    try {
      const acceptance = await sendMessage(
        conversationId,
        content,
        attachments,
        context,
        stillOwnsDraft,
      );
      if (!acceptance || acceptance.conversationId !== conversationId) {
        if (
          draftRef.current?.materialized?.conversationId === conversationId
        ) {
          replaceDraft({
            ...draftRef.current,
            materialized: {
              ...draftRef.current.materialized,
              awaitingReconciliation: true,
              recoveryMode: true,
            },
          }, false);
        }
        if (acceptance) {
          throw new Error(
            "The local service acknowledged a different chat than the one created for this draft.",
          );
        }
        return null;
      }
      markPersistedMaterializedDraftConversationAccepted(
        conversationId,
        acceptance.turnId,
        acceptance.userMessageId,
      );
      if (
        draftRef.current?.materialized?.conversationId === conversationId
      ) {
        replaceDraft({
          ...draftRef.current,
          materialized: {
            ...draftRef.current.materialized,
            acceptedTurnId: acceptance.turnId,
            acceptedUserMessageId: acceptance.userMessageId,
          },
        }, false);
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
          ...draftRef.current,
          materialized: {
            ...draftRef.current.materialized,
            awaitingReconciliation:
              runtimeCommandDelivery(error) === "ambiguous"
              || runtimeCommandDelivery(error) === null,
            recoveryMode:
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
  ): Promise<TranscriptMessageSendAcceptance | null> => {
    const current = draftRef.current;
    if (current?.materialized) {
      if (
        current.materialized.awaitingReconciliation
        || current.materialized.acceptedTurnId !== null
      ) {
        throw new Error(
          current.materialized.acceptedTurnId !== null
            ? "The first message was accepted and is waiting for the chat snapshot."
            : "Inertia is reconciling the first message after reconnecting.",
        );
      }
      try {
        const acceptance = await sendMessage(
          current.materialized.conversationId,
          content,
          attachments,
          context,
          true,
        );
        if (
          !acceptance
          || acceptance.conversationId
            !== current.materialized.conversationId
        ) {
          if (
            draftRef.current?.materialized?.conversationId
              === current.materialized.conversationId
          ) {
            replaceDraft({
              ...draftRef.current,
              materialized: {
                ...draftRef.current.materialized,
                awaitingReconciliation: true,
                recoveryMode: true,
              },
            }, false);
          }
          if (acceptance) {
            throw new Error(
              "The local service acknowledged a different chat than the materialized draft.",
            );
          }
          return null;
        }
        markPersistedMaterializedDraftConversationAccepted(
          current.materialized.conversationId,
          acceptance.turnId,
          acceptance.userMessageId,
        );
        if (
          draftRef.current?.materialized?.conversationId
            === current.materialized.conversationId
        ) {
          replaceDraft({
            ...draftRef.current,
            materialized: {
              ...draftRef.current.materialized,
              acceptedTurnId: acceptance.turnId,
              acceptedUserMessageId: acceptance.userMessageId,
              recoveryMode: false,
            },
          }, false);
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
            ...draftRef.current,
            materialized: {
              ...draftRef.current.materialized,
              awaitingReconciliation:
                runtimeCommandDelivery(error) === "ambiguous"
                || runtimeCommandDelivery(error) === null,
              recoveryMode:
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
      );
    }
    return await materializeAndSend(content, attachments, context);
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

  const draftConversation = draft?.conversation;
  const materializedConversationId = draft?.materialized?.conversationId;
  const workspaceConversation = useMemo(
    () => draftConversation && materializedConversationId
      ? { ...draftConversation, id: materializedConversationId }
      : null,
    [draftConversation, materializedConversationId],
  );

  return {
    conversation: draft?.conversation ?? null,
    workspaceConversation,
    layoutConversationId: draft?.materialized?.conversationId ?? draft?.conversation.id ?? null,
    requiresWorkspaceMaterialization: Boolean(
      draft?.payload.useWorktree && !draft.conversation.worktreePath,
    ),
    start,
    changeProject,
    importProject,
    clear,
    discard,
    chooseModel,
    sendFromComposer,
    updateConversation,
    runConversationContextCommand,
  };
}
