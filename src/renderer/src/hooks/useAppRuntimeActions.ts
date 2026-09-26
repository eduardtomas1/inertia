import {
  useCallback,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

import type {
  ChatAttachment,
  Conversation,
  ConversationCompactionResult,
  MessageSendAcceptance,
  ServerEvent,
  TurnRequestContext,
} from "@shared/contracts";
import {
  commandRefreshesConversationDetail,
  withRequestId,
  type CommandWithoutId,
} from "../lib/runtimeCommands";
import { RuntimeCommandError, runtimeCommandDelivery } from "../utils/connectionMessages";

export interface AppRuntimeActions {
  sendingConversationIds: ReadonlySet<string>;
  run: (key: string, command: CommandWithoutId, options?: { reportError?: boolean }) => Promise<ServerEvent>;
  openProjectPath: (
    request: Parameters<typeof window.inertia.openProjectPath>[0],
  ) => void;
  sendMessageToConversation: (
    conversationId: string,
    content: string,
    attachments: ChatAttachment[],
    context?: TurnRequestContext,
    activate?: boolean,
  ) => Promise<MessageSendAcceptance | null>;
  compactConversation: (
    conversationId: string,
    instruction?: string,
  ) => Promise<ConversationCompactionResult>;
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
  const pendingTextSends = useRef(new Set<string>());
  const run = useCallback(async (
    key: string,
    command: CommandWithoutId,
    runOptions?: { reportError?: boolean },
  ): Promise<ServerEvent> => {
    setBusyAction(key);
    setActionError(null);
    try {
      const event = await sendCommand(withRequestId(command));
      if (commandRefreshesConversationDetail(command, event)) refreshDetail();
      return event;
    } catch (error) {
      if (runOptions?.reportError !== false) setActionError(
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
        attachments: attachments.map(({ id, name, path, mimeType, size }) => ({ id, name, path, mimeType, size })),
        activate,
        ...(context ? { context } : {}),
      },
    });
    let handoffPrepared = false;
    let preserveAmbiguousHandoff = false;
    let ownsTextSend = false;
    let textIdentity: typeof import("../lib/messageSendIdentity") | null = null;
    const clearTextIdentity = (): void => {
      if (attachments.length !== 0) return;
      // Keeping a confirmed UUID after storage failure is safe: it can only replay.
      try { textIdentity?.clearTextSendIdentity(sessionStorage, targetConversationId, command.requestId); } catch { /* best effort */ }
    };
    try {
      if (attachments.length === 0 && command.type === "message.send") {
        try {
          textIdentity = await import("../lib/messageSendIdentity");
          command.requestId = await textIdentity.prepareTextSendIdentity(sessionStorage, command.payload, command.requestId);
        } catch {
          throw new RuntimeCommandError("Message delivery identity could not be saved. Free local storage before retrying.", "not-sent");
        }
        if (pendingTextSends.current.has(command.requestId)) {
          throw new RuntimeCommandError("This message is already being sent. Wait for its acknowledgement.", "ambiguous");
        }
        pendingTextSends.current.add(command.requestId);
        ownsTextSend = true;
      }
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
      ) { clearTextIdentity(); return event.result; }
      if (event.type === "request.ok") { clearTextIdentity(); return null; }
      throw new Error("The local service returned an unexpected message response.");
    } catch (error) {
      preserveAmbiguousHandoff = runtimeCommandDelivery(error) === "ambiguous";
      if (ownsTextSend && ["not-sent", "rejected"].includes(runtimeCommandDelivery(error) ?? "")) clearTextIdentity();
      setActionError(
        error instanceof Error
          ? error.message
          : "The message could not be sent.",
      );
      throw error;
    } finally {
      if (ownsTextSend) pendingTextSends.current.delete(command.requestId);
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
  const compactConversation = useCallback(async (
    targetConversationId: string,
    instruction?: string,
  ): Promise<ConversationCompactionResult> => {
    // The composer owns this operation's pending and error state by
    // conversation. Do not promote a hidden owner's failure into the global
    // action toast for whichever conversation is currently visible.
    const event = await sendCommand(withRequestId({
      type: "conversation.compact",
      payload: {
        conversationId: targetConversationId,
        ...(instruction ? { instruction } : {}),
      },
    }));
    if (
      event.type !== "request.result"
      || event.result.kind !== "conversation.compacted"
    ) {
      throw new Error(
        "The local service returned an unexpected compaction response.",
      );
    }
    return event.result;
  }, [sendCommand]);

  return {
    sendingConversationIds,
    run,
    openProjectPath,
    sendMessageToConversation,
    compactConversation,
    updateConversationById,
  };
}
