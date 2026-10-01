import { pullRequestsResultSchema, stackReviewResultSchema } from "../pull-requests";
export const pullRequestResultValidators = {
  "conversation.pull-requests": (value: Record<string, unknown>) => pullRequestsResultSchema.safeParse(value).success,
  "conversation.stack-review": (value: Record<string, unknown>) => stackReviewResultSchema.safeParse(value).success,
};
