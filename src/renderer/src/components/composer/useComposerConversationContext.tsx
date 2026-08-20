import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useState,
} from "react";
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

const ConversationContextDialog = lazy(async () => ({
  default: (await import("../conversation-context/ConversationContextDialog"))
    .ConversationContextDialog,
}));
type ContextDialogState =
  | { kind: "create" }
  | { kind: "preview"; packetId: string }
  | null;

export interface ComposerConversationContextController {
  contextPacketIds: string[];
  draftContextPackets: ConversationContextPacketSummary[];
  dialog: ContextDialogState;
  closeDialog(): void;
  openCreate(): void;
  openPreview(packetId: string): void;
  remove(packetId: string): Promise<void>;
}

export function composerConversationContextToolbarProps(
  controller: ComposerConversationContextController,
  sourceCount: number,
  enabled: boolean,
) {
  return {
    contextAvailable: enabled && sourceCount > 0
      && controller.draftContextPackets.length
        < MAX_CONVERSATION_CONTEXT_PACKETS_PER_TURN,
    contextCount: controller.draftContextPackets.length,
    onOpenContext: controller.openCreate,
  };
}

export function useComposerConversationContext(input: {
  conversationId: string;
  contextPackets: readonly ConversationContextPacketSummary[];
  onCommand?: ConversationContextCommandRunner;
}): ComposerConversationContextController {
  const { contextPackets, conversationId, onCommand } = input;
  const [dialog, setDialog] = useState<ContextDialogState>(null);

  useEffect(() => {
    setDialog(null);
  }, [conversationId]);

  const draftContextPackets = useMemo(() => contextPackets.filter(
    ({ consumedMessageId }) => consumedMessageId === null,
  ), [contextPackets]);
  const contextPacketIds = useMemo(
    () => draftContextPackets.map(({ id }) => id),
    [draftContextPackets],
  );
  const remove = async (packetId: string): Promise<void> => {
    if (!onCommand) return;
    await onCommand("conversation.context.remove", {
      type: "conversation.context.remove",
      payload: { packetId, targetConversationId: conversationId },
    });
  };

  return {
    contextPacketIds,
    draftContextPackets,
    dialog,
    closeDialog: () => setDialog(null),
    openCreate: () => setDialog({ kind: "create" }),
    openPreview: (packetId) => setDialog({ kind: "preview", packetId }),
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
  return (
    <ConversationContextPacketStrip
      packets={controller.draftContextPackets}
      disabled={disabled}
      onPreview={controller.openPreview}
      onRemove={(packetId) => {
        void controller.remove(packetId).catch(() => undefined);
      }}
    />
  );
}

export function ComposerConversationContextDialog({
  controller,
  targetConversationId,
  sources,
  agentRequest,
  onCommand,
}: {
  controller: ComposerConversationContextController;
  targetConversationId: string;
  sources: readonly ConversationContextSourceOption[];
  agentRequest: AgentConversationContextRequest | null;
  onCommand?: ConversationContextCommandRunner;
}): React.JSX.Element | null {
  if ((!controller.dialog && !agentRequest) || !onCommand) return null;
  return (
    <Suspense fallback={null}>
      <ConversationContextDialog
        targetConversationId={targetConversationId}
        sources={sources}
        previewPacketId={controller.dialog?.kind === "preview"
          ? controller.dialog.packetId
          : null}
        agentRequest={agentRequest}
        onCommand={onCommand}
        onClose={agentRequest ? () => undefined : controller.closeDialog}
      />
    </Suspense>
  );
}
