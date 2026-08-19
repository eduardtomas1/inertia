import type { ConversationContextPacket } from "@shared/contracts";
import type { CommandWithoutId } from "../../lib/runtimeCommands";

export interface ConversationContextSourceOption {
  conversationId: string;
  conversationTitle: string;
  projectId: string;
  projectName: string;
  workspaceLabel: string;
  workspaceRelation: "same-workspace" | "different-workspace";
  archived: boolean;
  updatedAt: string;
}

export type ConversationContextCommand = Extract<
  CommandWithoutId,
  { type: `conversation.context.${string}` }
>;

export type ConversationContextCommandRunner = (
  key: ConversationContextCommand["type"],
  command: ConversationContextCommand,
) => Promise<unknown>;

export type ConversationContextDialogResult =
  | { kind: "created"; packet: ConversationContextPacket }
  | { kind: "removed"; packetId: string };
