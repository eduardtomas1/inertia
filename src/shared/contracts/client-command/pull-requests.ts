import { z } from "zod";
import { pullRequestKeySchema, stackActionSchema } from "../../pull-requests";
import { requestBase } from "./common";
const owner = { conversationId: z.string().uuid() };
export const pullRequestCommandSchemas = [
  z.object({ ...requestBase, type: z.literal("conversation.prs.get"), payload: z.object(owner).strict() }).strict(),
  z.object({ ...requestBase, type: z.literal("conversation.prs.refresh"), payload: z.object(owner).strict() }).strict(),
  z.object({ ...requestBase, type: z.literal("conversation.prs.link"), payload: z.object({ ...owner, url: z.string().min(1).max(4096) }).strict() }).strict(),
  z.object({ ...requestBase, type: z.literal("conversation.prs.unlink"), payload: z.object({ ...owner, key: pullRequestKeySchema }).strict() }).strict(),
  z.object({ ...requestBase, type: z.literal("conversation.stack.prepare"), payload: z.object({ ...owner, key: pullRequestKeySchema, action: stackActionSchema }).strict() }).strict(),
  z.object({ ...requestBase, type: z.literal("conversation.stack.execute"), payload: z.object({ ...owner, reviewId: z.string().uuid() }).strict() }).strict(),
] as const;
