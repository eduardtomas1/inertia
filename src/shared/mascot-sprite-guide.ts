import { MASCOT_SPRITE_MAX_BYTES, MASCOT_SPRITE_SIZE, type MascotSpriteState } from "./mascot-sprites";

const SIZE = `${MASCOT_SPRITE_SIZE} × ${MASCOT_SPRITE_SIZE}`;
const LIMIT = `${MASCOT_SPRITE_MAX_BYTES / 1024} KB`;

export const MASCOT_SPRITE_NOTES: Record<MascotSpriteState, string> = {
  idle: "Ready, or the latest chat stopped without finishing.",
  thinking: "Queued, starting, retrying, or waiting for your answer or approval.",
  working: "An agent is running, delegating, or stopping.",
  idea: "Plays once for about 3 seconds when work finishes.",
  pickup: "Shown while you drag the mascot.",
};

export const MASCOT_SPRITE_STEPS = [
  "Export template to get a folder with the five built-in images, a README and template.json.",
  `Replace each PNG with your own art in any image editor. Keep the file names and the ${SIZE} size.`,
  "Import sprites and choose that folder. Nothing changes until you apply.",
  "Check the preview, then apply. Reset to default brings the built-in mascot back at any time.",
] as const;

export const MASCOT_SPRITE_RULES = [
  `Each state needs a PNG: ${SIZE} pixels, a single frame, up to ${LIMIT}.`,
  "To animate a state, add a .webp or .gif with the same name, like working.webp. When animation is paused or reduced motion is on, the still PNG is shown.",
  "Use a transparent background and leave a little margin. The mascot is drawn at exact size without smoothing, so pixel art stays crisp.",
] as const;
