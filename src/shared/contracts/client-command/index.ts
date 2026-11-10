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
import { customAgentCommandSchemas } from "./custom-agents";
import { secretRequestCommandSchemas } from "./secret-requests";
import { todoCommandSchemas } from "./todos";
import { libraryCommandSchemas } from "./library";
import { updatesCommandSchemas } from "./updates";
import { watcherCommandSchemas } from "./watcher";
import { worktreeCommandSchemas } from "./worktrees";

export const clientCommandSchema = z.discriminatedUnion("type", [
  ...appCommandSchemas,
  ...issueReportCommandSchemas,
  ...cliConversationCommandSchemas,
  ...agentCommandSchemas,
  ...configurationCommandSchemas,
  ...promptPresetCommandSchema.options,
  ...customAgentCommandSchemas,
  ...secretRequestCommandSchemas,
  ...todoCommandSchemas,
  ...libraryCommandSchemas,
  ...updatesCommandSchemas,
  ...watcherCommandSchemas,
  ...gitCommandSchemas,
  ...gitHistoryCommandSchemas,
  ...workspaceCommandSchemas,
  ...terminalLinkCommandSchemas,
  ...worktreeCommandSchemas,
]);

export type ClientCommand = z.infer<typeof clientCommandSchema>;
export type {
  SecretRequestCommandResult,
  SecretRequestDeclineResult,
  SecretRequestListEntry,
  SecretRequestListResult,
  SecretRequestRevokeResult,
} from "../secret-request-results";
