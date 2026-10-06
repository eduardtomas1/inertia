import type { LimitResetCommandRunner } from "../components/composer/limitResetClient";
import {
  useCallback,
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
import { messageSendFailureText, runtimeCommandDelivery } from "../utils/connectionMessages";
import type { QueueCommandRunner } from "../components/composer/runtimeQueueClient";
import { RUNTIME_QUEUE_CHANGED } from "../components/composer/runtimeQueueEvents";
import type { BackgroundTaskCursor, BackgroundTasksResult } from "@shared/background-tasks";

export type ConversationBackgroundTasksLoader = (
  conversationId: string,
  before: BackgroundTaskCursor | null,
) => Promise<BackgroundTasksResult>;

export interface AppRuntimeActions {
  runQueueCommand: QueueCommandRunner;
  runLimitResetCommand: LimitResetCommandRunner;
  loadBackgroundTasks: ConversationBackgroundTasksLoader;
  sendingConversationIds: ReadonlySet<string>;
  run: (key: string, command: CommandWithoutId, options?: { reportError?: boolean; passive?: boolean }) => Promise<ServerEvent>;
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
  const runLimitResetCommand = useCallback<LimitResetCommandRunner>(async (command) => {
    const event = await sendCommand(withRequestId(command));
    if (event.type !== "request.result" || event.result.kind !== "conversation.limit-reset") throw new Error("The local service returned an unexpected reset response.");
    return event.result;
  }, [sendCommand]);
  const loadBackgroundTasks = useCallback<ConversationBackgroundTasksLoader>(async (conversationId, before) => {
    const event = await sendCommand(withRequestId({ type: "conversation.background-tasks.get", payload: { conversationId, before } }));
    if (event.type !== "request.result" || event.result.kind !== "conversation.background-tasks") {
      throw new Error("The local service returned an unexpected background tasks response.");
    }
    return event.result;
  }, [sendCommand]);
  const runQueueCommand = useCallback<QueueCommandRunner>(async (command) => {
    const adds = command.type === "message.queue.enqueue" || command.type === "message.queue.stop-and-send";
    const request = { ...command, requestId: adds ? command.payload.id : crypto.randomUUID() };
    const attachments = adds ? command.payload.attachments : [];
    let handoff = false;
    let ambiguous = false;
    try {
      if (adds) {
        const known = await sendCommand(withRequestId({ type: "message.queue.get", payload: {
          conversationId: command.payload.conversationId, id: command.payload.id,
        } }));
        if (known.type === "request.result" && known.result.kind === "message.queue" && known.result.receipt) return known.result;
      }
      if (attachments.length > 0) {
        await window.inertia.prepareAttachmentHandoff({ requestId: request.requestId, attachmentIds: attachments.map(({ id }) => id) });
        handoff = true;
      }
      const event = await sendCommand(request);
      if (event.type !== "request.result" || event.result.kind !== "message.queue") throw new Error("The local service returned an unexpected queue response.");
      return event.result;
    } catch (error) {
      ambiguous = runtimeCommandDelivery(error) === "ambiguous";
      throw error;
    } finally {
      if (handoff && !ambiguous) await window.inertia.finishAttachmentHandoff(request.requestId).catch(() => undefined);
    }
  }, [sendCommand]);
  const run = useCallback(async (
    key: string,
    command: CommandWithoutId,
    runOptions?: { reportError?: boolean; passive?: boolean },
  ): Promise<ServerEvent> => {
    const passive = runOptions?.passive === true;
    if (!passive) {
      setBusyAction(key);
      if (runOptions?.reportError !== false) setActionError(null);
    }
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
      if (!passive) setBusyAction((current) => current === key ? null : current);
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
      if (event.type === "request.result" && event.result.kind === "message.queue") {
        window.dispatchEvent(new CustomEvent(RUNTIME_QUEUE_CHANGED, { detail: targetConversationId }));
        return null;
      }
      throw new Error("The local service returned an unexpected message response.");
    } catch (error) {
      preserveAmbiguousHandoff = runtimeCommandDelivery(error) === "ambiguous";
      setActionError(messageSendFailureText(error));
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
    runQueueCommand,
    runLimitResetCommand,
    loadBackgroundTasks,
    sendingConversationIds,
    run,
    openProjectPath,
    sendMessageToConversation,
    compactConversation,
    updateConversationById,
  };
}
