import { lazy, Suspense, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type {
  AgentConversationContextRequest,
  ConversationContextPacketSummary,
} from "@shared/contracts";
import { MAX_CONVERSATION_CONTEXT_PACKETS_PER_TURN } from "@shared/conversation-context";
import type {
  ConversationContextCommandRunner,
  ConversationContextSourceOption,
} from "../conversation-context/types";
const ConversationContextPacketStrip = lazy(async () => ({
  default: (await import("../conversation-context/ConversationContextPacketStrip")).ConversationContextPacketStrip,
}));

const PreviewCard = lazy(async () => ({
  default: (await import("./ComposerConversationContextCards"))
    .ConversationContextPreviewCard,
}));
const RequestCard = lazy(async () => ({
  default: (await import("./ComposerConversationContextCards"))
    .ConversationContextRequestCard,
}));
const ChatReferenceConfirmation = lazy(async () => ({
  default: (await import("./ComposerConversationContextCards")).ChatReferenceConfirmation,
}));

export interface ComposerConversationContextController {
  contextPacketIds: string[];
  draftContextPackets: ConversationContextPacketSummary[];
  enabled: boolean;
  canReferenceChat: boolean;
  referencing: boolean;
  isReferencing(): boolean;
  error: string | null;
  previewPacketId: string | null;
  confirmation: ConversationContextSourceOption | null;
  confirmReference(accepted: boolean): void;
  referenceChat(source: ConversationContextSourceOption): Promise<boolean>;
  togglePreview(packetId: string): void;
  dismissError(): void;
  remove(packetId: string): Promise<void>;
}

export function useComposerConversationContext(input: {
  conversationId: string;
  workspaceKey: string;
  contextPackets: readonly ConversationContextPacketSummary[];
  enabled: boolean;
  onCommand?: ConversationContextCommandRunner;
}): ComposerConversationContextController {
  const { contextPackets, conversationId, workspaceKey, enabled, onCommand } = input;
  const [previewPacketId, setPreviewPacketId] = useState<string | null>(null);
  const pendingRequests = useRef(new Map<string, string | null>());
  const [, refresh] = useReducer((revision: number) => revision + 1, 0);
  const [error, setError] = useState<{ conversationId: string; message: string } | null>(null);
  const [confirmation, setConfirmation] = useState<{
    conversationId: string;
    workspaceKey: string;
    source: ConversationContextSourceOption;
  } | null>(null);
  const confirmationReply = useRef<((accepted: boolean) => void) | null>(null);
  const confirmReference = (accepted: boolean): void => {
    const reply = confirmationReply.current;
    confirmationReply.current = null;
    setConfirmation(null);
    reply?.(accepted);
  };
  useEffect(() => {
    setConfirmation(null);
    return () => {
      confirmationReply.current?.(false);
      confirmationReply.current = null;
    };
  }, [conversationId, workspaceKey, enabled]);
  const isReferencing = (): boolean => {
    return pendingRequests.current.has(conversationId)
      && !contextPackets.some(({ id }) => id === pendingRequests.current.get(conversationId));
  };
  const referencing = isReferencing();
  const pendingPacketId = pendingRequests.current.get(conversationId);
  useEffect(() => {
    if (!referencing && pendingRequests.current.get(conversationId) === pendingPacketId) {
      pendingRequests.current.delete(conversationId);
    }
  }, [conversationId, referencing, pendingPacketId]);

  useEffect(() => {
    setPreviewPacketId(null);
    setError(null);
  }, [conversationId, enabled]);

  const draftContextPackets = useMemo(
    () => enabled
      ? contextPackets.filter(({ consumedMessageId }) =>
          consumedMessageId === null)
      : [],
    [contextPackets, enabled],
  );
  const contextPacketIds = useMemo(
    () => draftContextPackets.map(({ id }) => id),
    [draftContextPackets],
  );

  const remove = async (packetId: string): Promise<void> => {
    if (!enabled || !onCommand) return;
    setPreviewPacketId((current) => current === packetId ? null : current);
    await onCommand("conversation.context.remove", {
      type: "conversation.context.remove",
      payload: { packetId, targetConversationId: conversationId },
    });
  };

  const referenceChat = async (
    source: ConversationContextSourceOption,
  ): Promise<boolean> => {
    if (!enabled || !onCommand || isReferencing()) return false;
    if (draftContextPackets.length >= MAX_CONVERSATION_CONTEXT_PACKETS_PER_TURN) {
      setError({ conversationId, message: "Send or remove a referenced chat before adding another." });
      return false;
    }
    pendingRequests.current.set(conversationId, null);
    refresh();
    setError(null);
    try {
      const acknowledgedWorkspaceDifference = source.workspaceRelation === "different-workspace"
        && await new Promise<boolean>((resolve) => {
          confirmationReply.current = resolve;
          setConfirmation({ conversationId, workspaceKey, source });
        });
      if (source.workspaceRelation === "different-workspace" && !acknowledgedWorkspaceDifference) {
        pendingRequests.current.delete(conversationId);
        return false;
      }
      const event = await onCommand("conversation.context.create", {
        type: "conversation.context.create",
        payload: {
          sourceConversationId: source.conversationId,
          targetConversationId: conversationId,
          acknowledgedWorkspaceDifference,
        },
      });
      if (event.type !== "request.result"
        || event.result.kind !== "conversation.context.packet"
        || event.result.packet.targetConversationId !== conversationId
        || event.result.packet.sourceConversationId !== source.conversationId
        || event.result.packet.consumedMessageId !== null) throw new Error("Invalid chat reference response.");
      pendingRequests.current.set(conversationId, event.result.packet.id);
      return true;
    } catch {
      pendingRequests.current.delete(conversationId);
      setError({ conversationId, message: `${source.conversationTitle} could not be referenced.` });
      return false;
    } finally {
      refresh();
    }
  };

  return {
    contextPacketIds,
    draftContextPackets,
    enabled,
    canReferenceChat: enabled
      && Boolean(onCommand)
      && !referencing
      && draftContextPackets.length < MAX_CONVERSATION_CONTEXT_PACKETS_PER_TURN,
    referencing,
    isReferencing,
    error: error?.conversationId === conversationId ? error.message : null,
    previewPacketId,
    confirmation: confirmation?.conversationId === conversationId
      && confirmation.workspaceKey === workspaceKey && enabled
      ? confirmation.source : null,
    confirmReference,
    referenceChat,
    togglePreview: (packetId) => {
      if (!enabled) return;
      setPreviewPacketId((current) => current === packetId ? null : packetId);
    },
    dismissError: () => setError(null),
    remove,
  };
}

export function ComposerConversationContextStrip({
  controller,
  disabled,
  onConfirmationClosed,
}: {
  controller: ComposerConversationContextController;
  disabled: boolean;
  onConfirmationClosed?: () => void;
}): React.JSX.Element | null {
  if (!controller.enabled) return null;
  return (
    <>
      {controller.draftContextPackets.length > 0 && (
        <Suspense fallback={null}>
          <ConversationContextPacketStrip
            packets={controller.draftContextPackets}
            disabled={disabled}
            onPreview={controller.togglePreview}
            onRemove={(packetId) => {
              void controller.remove(packetId).catch(() => undefined);
            }}
          />
        </Suspense>
      )}
      {controller.confirmation ? (
        <Suspense fallback={null}>
          <ChatReferenceConfirmation source={controller.confirmation} onConfirm={(accepted) => {
            controller.confirmReference(accepted);
            onConfirmationClosed?.();
          }} />
        </Suspense>
      ) : controller.referencing ? <p role="status">Adding chat reference…</p> : null}
      {controller.error && (
        <p className="composer-limit-warning" role="alert">
          {controller.error}
        </p>
      )}
    </>
  );
}

export function ComposerConversationContextPreview({
  controller,
  targetConversationId,
  onCommand,
}: {
  controller: ComposerConversationContextController;
  targetConversationId: string;
  onCommand?: ConversationContextCommandRunner;
}): React.JSX.Element | null {
  if (!controller.previewPacketId || !onCommand) return null;
  return (
    <Suspense fallback={null}>
      <PreviewCard
        key={`${targetConversationId}/${controller.previewPacketId}/${controller.contextPacketIds.join(",")}`}
        packetId={controller.previewPacketId}
        targetConversationId={targetConversationId}
        onCommand={onCommand}
        onDismiss={() => controller.togglePreview(controller.previewPacketId!)}
      />
    </Suspense>
  );
}

export function ComposerConversationContextRequestCard({
  request,
  sources,
  onCommand,
}: {
  request: AgentConversationContextRequest | null;
  sources: readonly ConversationContextSourceOption[];
  onCommand?: ConversationContextCommandRunner;
}): React.JSX.Element | null {
  if (!request || !onCommand) return null;
  return (
    <Suspense fallback={null}>
      <RequestCard key={`${request.targetConversationId}/${request.requestId}`} request={request} sources={sources} onCommand={onCommand} />
    </Suspense>
  );
}
