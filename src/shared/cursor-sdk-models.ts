import { z } from "zod";

export const MAX_CURSOR_SDK_MODELS = 512;

export const cursorSdkModelSchema = z.object({
  id: z.string().min(1).max(512).refine((value) => !/[\u0000-\u001f\u007f]/u.test(value)),
  displayName: z.string().min(1).max(256).refine((value) => !/[\u0000-\u001f\u007f]/u.test(value)),
});

export type CursorSdkModel = z.infer<typeof cursorSdkModelSchema>;

export function cursorSdkModelIdsUnique(models: readonly CursorSdkModel[]): boolean {
  return new Set(models.map(({ id }) => id)).size === models.length;
}

export const cursorSdkModelsSchema = z.array(cursorSdkModelSchema)
  .max(MAX_CURSOR_SDK_MODELS).refine(cursorSdkModelIdsUnique);
