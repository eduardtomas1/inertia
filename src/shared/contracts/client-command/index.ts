import { z } from "zod";
import { issueReportCommandSchemas } from "./issue-report";
import { cliConversationCommandSchemas } from "./cli-conversations";

import { agentCommandSchemas } from "./agent";
import {
  appCommandSchemas,
  configurationCommandSchemas,
} from "./app";
import { gitCommandSchemas } from "./git";
import { workspaceCommandSchemas } from "./workspace";
import { promptPresetCommandSchema } from "./prompt-presets";
import { customAgentCommandSchemas } from "./custom-agents";
import { secretRequestCommandSchemas } from "./secret-requests";
import { todoCommandSchemas } from "./todos";
import { updatesCommandSchemas } from "./updates";
import { watcherCommandSchemas } from "./watcher";

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
  ...updatesCommandSchemas,
  ...watcherCommandSchemas,
  ...gitCommandSchemas,
  ...workspaceCommandSchemas,
]);

export type ClientCommand = z.infer<typeof clientCommandSchema>;
export type {
  SecretRequestCommandResult,
  SecretRequestDeclineResult,
  SecretRequestListEntry,
  SecretRequestListResult,
  SecretRequestRevokeResult,
} from "../secret-request-results";
