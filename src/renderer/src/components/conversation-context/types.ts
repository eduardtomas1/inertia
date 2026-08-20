import type { ServerEvent } from "@shared/contracts";
import type { CommandWithoutId } from "../../lib/runtimeCommands";

export interface ConversationContextSourceOption {
  conversationId: string;
  conversationTitle: string;
  projectName: string;
  workspaceRelation: "same-workspace" | "different-workspace";
  archived: boolean;
}

export type ConversationContextCommand = Extract<
  CommandWithoutId,
  { type: `conversation.context.${string}` }
>;

export type ConversationContextCommandRunner = (
  key: ConversationContextCommand["type"],
  command: ConversationContextCommand,
) => Promise<ServerEvent>;
