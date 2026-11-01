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
import { todoCommandSchemas } from "./todos";
import { updatesCommandSchemas } from "./updates";
import { watcherCommandSchemas } from "./watcher";
import { forkCommandSchemas } from "./forks";
import { cursorSdkCommandSchemas } from "./cursor-sdk";
import { delegationCommandSchemas } from "./delegation";
import { observedChildCommandSchemas } from "./observed-children";

export const clientCommandSchema = z.discriminatedUnion("type", [
  ...appCommandSchemas,
  ...issueReportCommandSchemas,
  ...cliConversationCommandSchemas,
  ...agentCommandSchemas,
  ...configurationCommandSchemas,
  ...promptPresetCommandSchema.options,
  ...todoCommandSchemas,
  ...updatesCommandSchemas,
  ...watcherCommandSchemas,
  ...forkCommandSchemas,
  ...cursorSdkCommandSchemas,
  ...delegationCommandSchemas,
  ...observedChildCommandSchemas,
  ...gitCommandSchemas,
  ...workspaceCommandSchemas,
]);

export type ClientCommand = z.infer<typeof clientCommandSchema>;
