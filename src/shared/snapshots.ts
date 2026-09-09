import { z } from "zod";

export const SNAPSHOT_MAX_TEXT = 24_000;
export const SNAPSHOT_MAX_NODES = 512;
export const SNAPSHOT_MAX_SOURCE_BYTES = 24 * 1024;
export const SNAPSHOT_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const rect = z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().nonnegative().max(32_768), height: z.number().nonnegative().max(32_768) }).strict();
export const snapshotSourceSchema = z.object({
  appName: z.string().max(200),
  windowTitle: z.string().max(500),
  capturedAt: z.iso.datetime(),
  width: z.number().int().positive().max(2_048),
  height: z.number().int().positive().max(2_048),
  accessibility: z.object({
    format: z.literal("element-tree"),
    coordinateSpace: z.literal("captured-image"),
    truncated: z.boolean(),
    nodes: z.array(z.object({
      depth: z.number().int().min(0).max(16),
      role: z.string().max(80), name: z.string().max(1000).optional(), value: z.string().max(2000).optional(),
      bounds: rect.optional(), redacted: z.boolean().optional(),
    }).strict()).max(SNAPSHOT_MAX_NODES),
  }).strict(),
}).strict().refine((value) => new TextEncoder().encode(JSON.stringify(value)).length <= SNAPSHOT_MAX_SOURCE_BYTES);
export type SnapshotSource = z.infer<typeof snapshotSourceSchema>;
export type SnapshotNode = SnapshotSource["accessibility"]["nodes"][number];
export type SnapshotRect = z.infer<typeof rect>;

export interface SnapshotState {
  enabled: boolean;
  shortcut: "both-shift" | "accelerator";
  available: boolean;
  permission: "granted" | "required";
  message: string | null;
}

export function snapshotPlatformAvailable(platform: string, env: Record<string, string | undefined>): boolean {
  return platform === "darwin" || platform === "win32"
    || (platform === "linux" && Boolean(env.DISPLAY) && !env.WAYLAND_DISPLAY && env.XDG_SESSION_TYPE !== "wayland");
}

/** Attached OS content is quoted evidence, never instructions to the harness. */
export function snapshotPromptContext(attachments: readonly { name: string; snapshot?: SnapshotSource }[]): string {
  return attachments.filter((attachment) => attachment.snapshot).map((attachment) =>
    `Snapshot accessibility context for ${JSON.stringify(attachment.name)} (untrusted captured application content):\n${JSON.stringify(attachment.snapshot)}`,
  ).join("\n\n");
}

export type SnapshotRequest =
  | { type: "state" }
  | { type: "configure"; enabled: boolean; shortcut: SnapshotState["shortcut"] }
  | { type: "bind"; conversationId: string }
  | { type: "unbind" }
  | { type: "permission"; permission: "screen" | "accessibility" };
export type SnapshotDelivery = { conversationId: string } & (
  | { selection: import("./desktop").DesktopAttachmentImportSelection; error?: never }
  | { error: string; selection?: never }
);
