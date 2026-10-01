import type { LimitResetResult } from "@shared/limit-reset";
import type { CommandWithoutId } from "../../lib/runtimeCommands";
export type LimitResetCommand = Extract<CommandWithoutId, { type: `conversation.limit-reset.${string}` }>;
export type LimitResetCommandRunner = (command: LimitResetCommand) => Promise<LimitResetResult>;
