import { z } from "zod";

export const PROJECT_ICON_NAMES = ["folder", "code", "database", "globe", "terminal", "layers", "box", "sparkles"] as const;
export const PROJECT_ICON_SIZE = 64;
export const MAX_PROJECT_ICON_DATA_LENGTH = 131_072;
function boundedPng(value: string): boolean {
  try {
    const header = atob(value.slice("data:image/png;base64,".length, "data:image/png;base64,".length + 44));
    const integer = (offset: number): number => [0, 1, 2, 3].reduce((total, index) => total * 256 + header.charCodeAt(offset + index), 0);
    return header.length >= 33 && integer(8) === 13 && header.slice(12, 16) === "IHDR"
      && [integer(16), integer(20)].every((size) => size > 0 && size <= PROJECT_ICON_SIZE);
  } catch { return false; }
}
export const projectPreferencesSchema = z.strictObject({
  workspace: z.enum(["local", "worktree"]).nullable(),
  autoPull: z.boolean(),
  browserAccess: z.boolean().nullable(),
  icon: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("symbol"), name: z.enum(PROJECT_ICON_NAMES) }),
    z.strictObject({ kind: z.literal("image"), data: z.string().max(MAX_PROJECT_ICON_DATA_LENGTH).regex(/^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/u).refine(boundedPng, "Use a normalized small PNG icon.") }),
  ]).nullable(),
  actions: z.array(z.strictObject({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(80),
    executable: z.string().trim().min(1).max(4096).refine((value) => !/[\0\r\n]/u.test(value)),
    args: z.array(z.string().max(4096).refine((value) => !value.includes("\0"))).max(64),
  })).max(20),
}).refine((value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 192 * 1024, "Project settings exceed the local command size limit.")
  .refine((value) => new Set(value.actions.map(({ id }) => id)).size === value.actions.length, "Project actions must have distinct identities.");

export type ProjectPreferences = z.infer<typeof projectPreferencesSchema>;

export function defaultProjectPreferences(): ProjectPreferences {
  return { workspace: null, autoPull: false, browserAccess: null, icon: null, actions: [] };
}

/** Corrupt or older preferences must never block opening a project. */
export function parseProjectPreferences(value: unknown): ProjectPreferences {
  try {
    if (typeof value === "string" && value.length > 192 * 1024) return defaultProjectPreferences();
    const input = typeof value === "string" ? JSON.parse(value) : value;
    const result = projectPreferencesSchema.safeParse(input);
    return result.success ? result.data : defaultProjectPreferences();
  } catch { return defaultProjectPreferences(); }
}
