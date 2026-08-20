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
  commandEnabled: boolean,
  handoffEnabled: boolean,
) {
  return {
    contextAvailable: handoffEnabled && commandEnabled && sourceCount > 0
      && controller.draftContextPackets.length
        < MAX_CONVERSATION_CONTEXT_PACKETS_PER_TURN,
    contextCount: controller.draftContextPackets.length,
    conversationContextHandoffEnabled: handoffEnabled,
    onOpenContext: controller.openCreate,
  };
}

export function useComposerConversationContext(input: {
  conversationId: string;
  contextPackets: readonly ConversationContextPacketSummary[];
  enabled: boolean;
  onCommand?: ConversationContextCommandRunner;
}): ComposerConversationContextController {
  const { contextPackets, conversationId, enabled, onCommand } = input;
  const [dialog, setDialog] = useState<ContextDialogState>(null);

  useEffect(() => {
    setDialog(null);
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
    openCreate: () => {
      if (enabled) setDialog({ kind: "create" });
    },
    openPreview: (packetId) => {
      if (enabled) setDialog({ kind: "preview", packetId });
    },
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
