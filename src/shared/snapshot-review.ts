import { z } from "zod";

export const snapshotReviewAreaSchema = z.object({
  x: z.number().int().min(0).max(2048), y: z.number().int().min(0).max(2048),
  width: z.number().int().positive().max(2048), height: z.number().int().positive().max(2048),
}).strict();
export type SnapshotReviewArea = z.infer<typeof snapshotReviewAreaSchema>;
export const snapshotReviewRequestSchemas = [
  z.object({ type: z.literal("review-start"), reviewId: z.uuid(), conversationId: z.uuid() }).strict(),
  z.object({ type: z.literal("review-select"), reviewId: z.uuid(), sourceId: z.string().min(1).max(200) }).strict(),
  z.object({ type: z.literal("review-edit"), reviewId: z.uuid(), revision: z.number().int().nonnegative(),
    operation: z.enum(["crop", "mask"]), area: snapshotReviewAreaSchema }).strict(),
  z.object({ type: z.literal("review-approve"), reviewId: z.uuid(), revision: z.number().int().nonnegative() }).strict(),
  z.object({ type: z.literal("review-cancel"), reviewId: z.uuid() }).strict(),
] as const;
export type SnapshotReviewRequest = z.infer<(typeof snapshotReviewRequestSchemas)[number]>;
export type SnapshotReview = { reviewId: string } & (
  | { stage: "sources"; sources: { id: string; name: string; preview: string }[] }
  | { stage: "image"; revision: number; preview: string; width: number; height: number }
  | { stage: "closed"; message?: string }
);

export function reviewedSnapshotBackend(platform: string, env: Record<string, string | undefined>): "system-picker" | "window-picker" | null {
  if (platform !== "linux") return null;
  if (env.WAYLAND_DISPLAY || env.XDG_SESSION_TYPE === "wayland") return "system-picker";
  return env.DISPLAY ? "window-picker" : null;
}
