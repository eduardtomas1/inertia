import {
  useCallback,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

import type {
  ChatAttachment,
  Conversation,
  MessageSendAcceptance,
  ServerEvent,
  TurnRequestContext,
} from "@shared/contracts";
import {
  commandRefreshesConversationDetail,
  withRequestId,
  type CommandWithoutId,
} from "../lib/runtimeCommands";
import { runtimeCommandDelivery } from "../utils/connectionMessages";

export interface AppRuntimeActions {
  sendingConversationIds: ReadonlySet<string>;
  run: (key: string, command: CommandWithoutId) => Promise<ServerEvent>;
  openProjectPath: (
    request: Parameters<typeof window.inertia.openProjectPath>[0],
  ) => void;
  sendMessageToConversation: (
    conversationId: string,
    content: string,
    attachments: ChatAttachment[],
    context?: TurnRequestContext,
    skillIds?: readonly string[],
    activate?: boolean,
  ) => Promise<MessageSendAcceptance | null>;
  updateConversationById: (
    conversationId: string,
    update: Partial<Pick<
      Conversation,
      | "providerId"
      | "modelSelection"
      | "model"
      | "reasoningEffort"
      | "interactionMode"
      | "accessMode"
    >>,
  ) => Promise<void>;
}

export function useAppRuntimeActions(options: {
  sendCommand: (
    command: ReturnType<typeof withRequestId>,
  ) => Promise<ServerEvent>;
  refreshDetail: () => void;
  setBusyAction: Dispatch<SetStateAction<string | null>>;
  setActionError: Dispatch<SetStateAction<string | null>>;
}): AppRuntimeActions {
  const {
    sendCommand,
    refreshDetail,
    setBusyAction,
    setActionError,
  } = options;
  const [sendingConversationIds, setSendingConversationIds] = useState(
    () => new Set<string>(),
  );
  const run = useCallback(async (
    key: string,
    command: CommandWithoutId,
  ): Promise<ServerEvent> => {
    setBusyAction(key);
    setActionError(null);
    try {
      const event = await sendCommand(withRequestId(command));
      if (commandRefreshesConversationDetail(command, event)) refreshDetail();
      return event;
    } catch (error) {
      setActionError(
        error instanceof Error
          ? error.message
          : "That action could not be completed.",
      );
      throw error;
    } finally {
      setBusyAction((current) => current === key ? null : current);
    }
  }, [refreshDetail, sendCommand, setActionError, setBusyAction]);
  const openProjectPath = useCallback((
    pathRequest: Parameters<typeof window.inertia.openProjectPath>[0],
  ): void => {
    void window.inertia.openProjectPath(pathRequest)
      .then((error) => {
        if (error) setActionError(error);
      })
      .catch((error: unknown) => {
        setActionError(
          error instanceof Error
            ? error.message
            : "The project path could not be opened.",
        );
      });
  }, [setActionError]);
  const sendMessageToConversation = useCallback(async (
    targetConversationId: string,
    content: string,
    attachments: ChatAttachment[],
    context?: TurnRequestContext,
    skillIds?: readonly string[],
    activate = true,
  ): Promise<MessageSendAcceptance | null> => {
    setSendingConversationIds((current) =>
      new Set(current).add(targetConversationId));
    setActionError(null);
    const command = withRequestId({
      type: "message.send",
      payload: {
        conversationId: targetConversationId,
        content,
        attachments,
        ...(skillIds?.length ? { skillIds: [...skillIds] } : {}),
        activate,
        ...(context ? { context } : {}),
      },
    });
    let handoffPrepared = false;
    let preserveAmbiguousHandoff = false;
    try {
      if (attachments.length > 0) {
        await window.inertia.prepareAttachmentHandoff({
          requestId: command.requestId,
          attachmentIds: attachments.map(({ id }) => id),
        });
        handoffPrepared = true;
      }
      const event = await sendCommand(command);
      if (
        event.type === "request.result"
        && event.result.kind === "message.accepted"
      ) return event.result;
      if (event.type === "request.ok") return null;
      throw new Error("The local service returned an unexpected message response.");
    } catch (error) {
      preserveAmbiguousHandoff = runtimeCommandDelivery(error) === "ambiguous";
      setActionError(
        error instanceof Error
          ? error.message
          : "The message could not be sent.",
      );
      throw error;
    } finally {
      if (handoffPrepared && !preserveAmbiguousHandoff) {
        await window.inertia.finishAttachmentHandoff(command.requestId)
          .catch(() => undefined);
      }
      setSendingConversationIds((current) => {
        const next = new Set(current);
        next.delete(targetConversationId);
        return next;
      });
    }
  }, [sendCommand, setActionError]);
  const updateConversationById = useCallback(async (
    targetConversationId: string,
    update: Parameters<AppRuntimeActions["updateConversationById"]>[1],
  ): Promise<void> => {
    const { modelSelection, ...legacyUpdate } = update;
    await run(`conversation.update:${targetConversationId}`, {
      type: "conversation.update",
      payload: {
        conversationId: targetConversationId,
        ...legacyUpdate,
        ...(modelSelection
          ? {
              modelSelection: {
                ...modelSelection,
                providerOptions: { ...modelSelection.providerOptions },
                capabilities: modelSelection.capabilities.map(
                  (capability) => ({ ...capability }),
                ),
              },
            }
          : {}),
      },
    });
  }, [run]);

  return {
    sendingConversationIds,
    run,
    openProjectPath,
    sendMessageToConversation,
    updateConversationById,
  };
}
