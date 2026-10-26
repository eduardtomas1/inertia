import { z } from "zod";

import { providerIdSchema } from "./contracts/client-command/common";

export const DUO_COMPARISON_BRIEF_TITLE_MAX_CHARS = 200;
export const DUO_COMPARISON_BRIEF_MAX_BYTES = 4_096;

const identifierSchema = z.string().min(1).max(128);

const duoComparisonBriefSideSchema = z.strictObject({
  conversationId: identifierSchema,
  providerId: providerIdSchema.nullable(),
  title: z.string().max(DUO_COMPARISON_BRIEF_TITLE_MAX_CHARS),
  status: z.enum(["completed", "failed", "cancelled", "interrupted"]),
  filesChanged: z.number().int().min(0).max(1_000_000).nullable(),
});

export const duoComparisonBriefSchema = z.strictObject({
  launchId: identifierSchema,
  sides: z.tuple([duoComparisonBriefSideSchema, duoComparisonBriefSideSchema]),
});

export type DuoComparisonBriefSide = z.infer<typeof duoComparisonBriefSideSchema>;
export type DuoComparisonBrief = z.infer<typeof duoComparisonBriefSchema>;

export function isDuoComparisonBrief(value: unknown): value is DuoComparisonBrief {
  return duoComparisonBriefSchema.safeParse(value).success;
}

export function duoComparisonBriefFromJson(value: string | null | undefined): DuoComparisonBrief | undefined {
  if (!value) return undefined;
  try {
    const parsed = duoComparisonBriefSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
