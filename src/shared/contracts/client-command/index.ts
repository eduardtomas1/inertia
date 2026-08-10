import { z } from "zod";

import { agentCommandSchemas } from "./agent";
import {
  appCommandSchemas,
  configurationCommandSchemas,
} from "./app";
import { gitCommandSchemas } from "./git";
import { workspaceCommandSchemas } from "./workspace";
import { promptPresetCommandSchema } from "./prompt-presets";

export const clientCommandSchema = z.discriminatedUnion("type", [
  ...appCommandSchemas,
  ...agentCommandSchemas,
  ...configurationCommandSchemas,
  ...promptPresetCommandSchema.options,
  ...gitCommandSchemas,
  ...workspaceCommandSchemas,
]);

export type ClientCommand = z.infer<typeof clientCommandSchema>;
