import { z } from "zod";
import { issueReportCommandSchemas } from "./issue-report";

import { agentCommandSchemas } from "./agent";
import {
  appCommandSchemas,
  configurationCommandSchemas,
} from "./app";
import { gitCommandSchemas } from "./git";
import { workspaceCommandSchemas } from "./workspace";
import { promptPresetCommandSchema } from "./prompt-presets";
import { conversationNotesCommandSchemas } from "../../conversation-notes";

export const clientCommandSchema = z.discriminatedUnion("type", [
  ...appCommandSchemas,
  ...issueReportCommandSchemas,
  ...agentCommandSchemas,
  ...configurationCommandSchemas,
  ...promptPresetCommandSchema.options,
  ...conversationNotesCommandSchemas,
  ...gitCommandSchemas,
  ...workspaceCommandSchemas,
]);

export type ClientCommand = z.infer<typeof clientCommandSchema>;
