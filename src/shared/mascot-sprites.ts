export const MASCOT_SPRITE_STATES = ["idle", "thinking", "working", "idea", "pickup"] as const;
export type MascotSpriteState = (typeof MASCOT_SPRITE_STATES)[number];
export const MASCOT_SPRITE_LABELS: Record<MascotSpriteState, string> = {
  idle: "Idle", thinking: "Thinking", working: "Working", idea: "Complete", pickup: "Picked up",
};
export const MASCOT_SPRITE_SIZE = 96;
export const MASCOT_SPRITE_MAX_BYTES = 512 * 1024;
export interface MascotSpriteFiles { animation: string; poster: string }
export interface MascotSprites {
  id: string;
  animated: number;
  files: Record<MascotSpriteState, MascotSpriteFiles>;
}
export type MascotSpriteAction = "import" | "apply" | "reset" | "export-template";
export type MascotSpriteImport =
  | { status: "cancelled" }
  | { status: "invalid"; message: string }
  | { status: "ready"; sprites: MascotSprites };
export type MascotTemplateExport =
  | { status: "cancelled" | "exported" }
  | { status: "invalid"; message: string };
