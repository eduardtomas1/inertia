import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import type {
  AgentConversationContextRequest,
  ConversationContextPacketSummary,
} from "@shared/contracts";
import { MAX_CONVERSATION_CONTEXT_PACKETS_PER_TURN } from "@shared/conversation-context";
import type {
  ConversationContextCommandRunner,
  ConversationContextSourceOption,
} from "../conversation-context/types";
import { ConversationContextPacketStrip } from "../conversation-context/ConversationContextPacketStrip";

const PreviewCard = lazy(async () => ({
  default: (await import("./ComposerConversationContextCards"))
    .ConversationContextPreviewCard,
}));
const RequestCard = lazy(async () => ({
  default: (await import("./ComposerConversationContextCards"))
    .ConversationContextRequestCard,
}));

export interface ComposerConversationContextController {
  contextPacketIds: string[];
  draftContextPackets: ConversationContextPacketSummary[];
  enabled: boolean;
  canReferenceChat: boolean;
  referencing: boolean;
  error: string | null;
  previewPacketId: string | null;
  referenceChat(source: ConversationContextSourceOption): Promise<boolean>;
  togglePreview(packetId: string): void;
  dismissError(): void;
  remove(packetId: string): Promise<void>;
}

export function useComposerConversationContext(input: {
  conversationId: string;
  contextPackets: readonly ConversationContextPacketSummary[];
  enabled: boolean;
  onCommand?: ConversationContextCommandRunner;
}): ComposerConversationContextController {
  const { contextPackets, conversationId, enabled, onCommand } = input;
  const [previewPacketId, setPreviewPacketId] = useState<string | null>(null);
  const [referencing, setReferencing] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    if (!enabled || !onCommand || referencing) return false;
    if (draftContextPackets.length >= MAX_CONVERSATION_CONTEXT_PACKETS_PER_TURN) {
      setError("Send or remove a referenced chat before adding another.");
      return false;
    }
    setReferencing(true);
    setError(null);
    try {
      const event = await onCommand("conversation.context.create", {
        type: "conversation.context.create",
        payload: {
          sourceConversationId: source.conversationId,
          targetConversationId: conversationId,
          acknowledgedWorkspaceDifference:
            source.workspaceRelation === "different-workspace",
        },
      });
      if (event.type !== "request.result") {
        setError(`${source.conversationTitle} could not be referenced.`);
        return false;
      }
      return true;
    } catch {
      setError(`${source.conversationTitle} could not be referenced.`);
      return false;
    } finally {
      setReferencing(false);
    }
  };

  return {
    contextPacketIds,
    draftContextPackets,
    enabled,
    canReferenceChat: enabled
      && Boolean(onCommand)
      && draftContextPackets.length < MAX_CONVERSATION_CONTEXT_PACKETS_PER_TURN,
    referencing,
    error,
    previewPacketId,
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
}: {
  controller: ComposerConversationContextController;
  disabled: boolean;
}): React.JSX.Element | null {
  if (!controller.enabled) return null;
  return (
    <>
      <ConversationContextPacketStrip
        packets={controller.draftContextPackets}
        disabled={disabled}
        onPreview={controller.togglePreview}
        onRemove={(packetId) => {
          void controller.remove(packetId).catch(() => undefined);
        }}
      />
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
        packetId={controller.previewPacketId}
        targetConversationId={targetConversationId}
        onCommand={onCommand}
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
      <RequestCard request={request} sources={sources} onCommand={onCommand} />
    </Suspense>
  );
}
