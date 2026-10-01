import type { ChatMessage, ServerEvent } from "@shared/contracts";
import type { CommandWithoutId } from "../../lib/runtimeCommands";

export type ProjectMemoryCommand = Extract<CommandWithoutId, { type: `project.memory.${string}` }>;
export type ProjectMemoryCommandRunner = (command: ProjectMemoryCommand) => Promise<ServerEvent>;
export interface ProjectMemoryPanelProps {
  projectId: string;
  conversationId?: string;
  projectName: string;
  request: ProjectMemoryCommandRunner;
  disabled?: boolean;
  sourceMessage?: ChatMessage;
  onBusyChange?(busy: boolean): void;
  onDraftChange?(hasDraft: boolean): void;
}
