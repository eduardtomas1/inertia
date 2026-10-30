import type { ServerEvent } from "@shared/contracts";
import type { CommandWithoutId } from "../../lib/runtimeCommands";

export type ForkCommand = Extract<CommandWithoutId, {
  type: "conversation.fork" | "conversation.fork.history" | "conversation.rollback" | "conversation.merge-back";
}>;
export type ForkCommandRunner = (key: ForkCommand["type"], command: ForkCommand) => Promise<ServerEvent>;
export interface ForkSurface { projectId: string; conversationId: string; run: ForkCommandRunner; rolledBack: ReadonlySet<string> }
