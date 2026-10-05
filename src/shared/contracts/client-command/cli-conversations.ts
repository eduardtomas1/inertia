import { z } from "zod";
import { requestBase } from "./common";

const project = { projectId: z.string().uuid() };
const candidate = { ...project, candidateId: z.string().uuid() };
export const cliConversationCommandSchemas = [
  z.object({ ...requestBase, type: z.literal("conversation.cli.scan"), payload: z.object(project).strict() }),
  z.object({ ...requestBase, type: z.literal("conversation.cli.preview"), payload: z.object(candidate).strict() }),
  z.object({ ...requestBase, type: z.literal("conversation.cli.import"), payload: z.object({ ...candidate, revision: z.string().regex(/^[a-f0-9]{64}$/u) }).strict() }),
] as const;
