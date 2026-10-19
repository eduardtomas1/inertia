import { z } from "zod";
import { issueReportCommandSchemas } from "./issue-report";
import { cliConversationCommandSchemas } from "./cli-conversations";

import { agentCommandSchemas } from "./agent";
import {
  appCommandSchemas,
  configurationCommandSchemas,
} from "./app";
import { gitCommandSchemas, gitHistoryCommandSchemas } from "./git";
import { workspaceCommandSchemas } from "./workspace";
import { terminalLinkCommandSchemas } from "./terminal-links";
import { promptPresetCommandSchema } from "./prompt-presets";
import { todoCommandSchemas } from "./todos";
import { updatesCommandSchemas } from "./updates";
import { worktreeCommandSchemas } from "./worktrees";

export const clientCommandSchema = z.discriminatedUnion("type", [
  ...appCommandSchemas,
  ...issueReportCommandSchemas,
  ...cliConversationCommandSchemas,
  ...agentCommandSchemas,
  ...configurationCommandSchemas,
  ...promptPresetCommandSchema.options,
  ...todoCommandSchemas,
  ...updatesCommandSchemas,
  ...gitCommandSchemas,
  ...gitHistoryCommandSchemas,
  ...workspaceCommandSchemas,
  ...terminalLinkCommandSchemas,
  ...worktreeCommandSchemas,
]);

export type ClientCommand = z.infer<typeof clientCommandSchema>;
