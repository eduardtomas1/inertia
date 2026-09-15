import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { inflateSync } from "node:zlib";
import idea from "../renderer/src/assets/mascot/idea.png?inline";
import idle from "../renderer/src/assets/mascot/idle.png?inline";
import pickup from "../renderer/src/assets/mascot/pickup.png?inline";
import thinking from "../renderer/src/assets/mascot/thinking.png?inline";
import working from "../renderer/src/assets/mascot/working.png?inline";
import {
  MASCOT_SPRITE_MAX_BYTES, MASCOT_SPRITE_SIZE, MASCOT_SPRITE_STATES,
  type MascotSprites, type MascotSpriteState,
} from "../shared/mascot.js";
import { decodedImageMatches, inspectImageMetadata } from "./attachment-image-validation.js";

const FORMATS = {
  png: { type: "image/png", label: "PNG" },
  webp: { type: "image/webp", label: "WebP" },
  gif: { type: "image/gif", label: "GIF" },
} as const;
type SpriteExtension = keyof typeof FORMATS;
export interface MascotSpriteFile {
  name: string;
  type: (typeof FORMATS)[SpriteExtension]["type"];
  bytes: Buffer;
}
export interface MascotSpriteSet { id: string; files: MascotSpriteFile[] }

const DEFAULT_STILLS: Record<MascotSpriteState, string> = { idle, thinking, working, idea, pickup };
const STATE_NOTES: Record<MascotSpriteState, string> = {
  idle: "Ready, or the latest chat stopped without finishing.",
  thinking: "Queued, starting, retrying, or waiting for your answer or approval.",
  working: "An agent is running, delegating, or stopping.",
  idea: "Work complete. Its animation plays once for about 3 seconds.",
  pickup: "Shown while you drag the mascot.",
};
const PNG_CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] as const;
const SIZE_LABEL = `${MASCOT_SPRITE_SIZE} × ${MASCOT_SPRITE_SIZE} pixels`;
const BYTES_LABEL = `${MASCOT_SPRITE_MAX_BYTES / 1024} KB`;

export class MascotSpriteError extends Error {}

function pngPixelsDecode(bytes: Buffer): boolean {
  try {
    const data: Buffer[] = [];
    let header: Buffer | undefined;
    for (let offset = 8; offset + 12 <= bytes.byteLength;) {
      const length = bytes.readUInt32BE(offset);
      const type = bytes.toString("latin1", offset + 4, offset + 8);
      if (type === "IHDR") header = bytes.subarray(offset + 8, offset + 8 + length);
      if (type === "IDAT") data.push(bytes.subarray(offset + 8, offset + 8 + length));
      offset += 12 + length;
    }
    if (!header) return false;
    const width = header.readUInt32BE(0);
    const height = header.readUInt32BE(4);
    const bits = header[8]! * PNG_CHANNELS[header[9]!]!;
    const rows: number[] = [];
    for (const [x, y, dx, dy] of header[12] ? ADAM7 : [[0, 0, 1, 1] as const]) {
      const columns = Math.ceil((width - x) / dx);
      const count = Math.ceil((height - y) / dy);
      if (columns > 0) for (let row = 0; row < count; row += 1) rows.push(1 + Math.ceil((columns * bits) / 8));
    }
    const expected = rows.reduce((total, size) => total + size, 0);
    const pixels = inflateSync(Buffer.concat(data), { maxOutputLength: expected + 1 });
    if (pixels.byteLength !== expected) return false;
    let offset = 0;
    for (const size of rows) {
      if (pixels[offset]! > 4) return false;
      offset += size;
    }
    return true;
  } catch { return false; }
}

export function validateMascotSprite(name: string, bytes: Buffer): MascotSpriteFile {
  const extension = name.slice(name.lastIndexOf(".") + 1);
  if (!Object.hasOwn(FORMATS, extension)) throw new MascotSpriteError(`${name} must be a PNG, WebP or GIF image.`);
  const format = FORMATS[extension as SpriteExtension];
  if (bytes.byteLength > MASCOT_SPRITE_MAX_BYTES) throw new MascotSpriteError(`${name} is larger than ${BYTES_LABEL}.`);
  const metadata = inspectImageMetadata(bytes, format.type);
  if (!metadata) throw new MascotSpriteError(`${name} is not a valid ${format.label} image.`);
  if (metadata.width !== MASCOT_SPRITE_SIZE || metadata.height !== MASCOT_SPRITE_SIZE) {
    throw new MascotSpriteError(`${name} must be ${SIZE_LABEL}, not ${metadata.width} × ${metadata.height}.`);
  }
  if (extension === "png" && metadata.frames !== 1) throw new MascotSpriteError(`${name} must be a single still frame.`);
  if (!decodedImageMatches(bytes, metadata) || (extension === "png" && !pngPixelsDecode(bytes))) {
    throw new MascotSpriteError(`${name} could not be decoded.`);
  }
  return { name, type: format.type, bytes };
}

async function readSprite(directory: string, name: string): Promise<Buffer | null> {
  const path = join(directory, name);
  let handle;
  try {
    const named = await lstat(path, { bigint: true });
    const outside = `${name} must be a file in the chosen folder, not a link.`;
    if (named.isSymbolicLink()) throw new MascotSpriteError(outside);
    if (!named.isFile()) throw new MascotSpriteError(`${name} must be a regular file.`);
    if (dirname(await realpath(path)) !== await realpath(directory)) throw new MascotSpriteError(outside);
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== named.dev || opened.ino !== named.ino) {
      throw new MascotSpriteError(`${name} changed while it was being read.`);
    }
    const buffer = Buffer.alloc(MASCOT_SPRITE_MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, length, buffer.byteLength - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MASCOT_SPRITE_MAX_BYTES) throw new MascotSpriteError(`${name} is larger than ${BYTES_LABEL}.`);
    return Buffer.from(buffer.subarray(0, length));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof MascotSpriteError) throw error;
    throw new MascotSpriteError(`${name} could not be read.`);
  } finally { await handle?.close(); }
}

export async function readMascotSprites(directory: string): Promise<MascotSpriteSet> {
  const files: MascotSpriteFile[] = [];
  for (const state of MASCOT_SPRITE_STATES) {
    const still = await readSprite(directory, `${state}.png`);
    if (!still) throw new MascotSpriteError(`Add ${state}.png. Every state needs a ${MASCOT_SPRITE_SIZE} × ${MASCOT_SPRITE_SIZE} PNG.`);
    files.push(validateMascotSprite(`${state}.png`, still));
    const animations: Array<[string, Buffer]> = [];
    for (const name of [`${state}.webp`, `${state}.gif`]) {
      const bytes = await readSprite(directory, name);
      if (bytes) animations.push([name, bytes]);
    }
    if (animations.length > 1) throw new MascotSpriteError(`Keep one animation for ${state}: ${state}.webp or ${state}.gif.`);
    files.push(...animations.map(([name, bytes]) => validateMascotSprite(name, bytes)));
  }
  const hash = createHash("sha256");
  for (const file of files) hash.update(`${file.name}:${file.bytes.byteLength}:`).update(file.bytes);
  return { id: hash.digest("hex").slice(0, 16), files };
}

export function mascotSprites(set: MascotSpriteSet, origin: string): MascotSprites {
  const url = (name: string): string => `${origin}mascot-sprites/${set.id}/${name}`;
  const files = {} as MascotSprites["files"];
  let animated = 0;
  for (const state of MASCOT_SPRITE_STATES) {
    const animation = set.files.find((file) => file.name.startsWith(`${state}.`) && file.type !== "image/png");
    if (animation) animated += 1;
    files[state] = { poster: url(`${state}.png`), animation: url(animation?.name ?? `${state}.png`) };
  }
  return { id: set.id, animated, files };
}

export async function saveMascotSprites(root: string, set: MascotSpriteSet): Promise<void> {
  const staging = `${root}.staging`;
  await rm(staging, { recursive: true, force: true });
  try {
    await mkdir(staging, { mode: 0o700 });
    for (const file of set.files) await writeFile(join(staging, file.name), file.bytes, { mode: 0o600, flag: "wx" });
    await rm(root, { recursive: true, force: true });
    await rename(staging, root);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function removeMascotSprites(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

export async function loadMascotSprites(root: string): Promise<MascotSpriteSet | null> {
  try {
    const stat = await lstat(root);
    return stat.isDirectory() ? await readMascotSprites(root) : null;
  } catch { return null; }
}

export function mascotSpriteTemplate() {
  return {
    format: "inertia-mascot-sprites",
    version: 1,
    width: MASCOT_SPRITE_SIZE,
    height: MASCOT_SPRITE_SIZE,
    requiredImages: MASCOT_SPRITE_STATES.length,
    optionalAnimations: MASCOT_SPRITE_STATES.length,
    maxBytesPerImage: MASCOT_SPRITE_MAX_BYTES,
    formats: {
      still: `PNG with a single frame, exactly ${SIZE_LABEL}. Transparent backgrounds work best.`,
      animation: `Optional animated WebP or GIF, exactly ${SIZE_LABEL}, up to 256 frames. It loops while the state is active.`,
    },
    states: MASCOT_SPRITE_STATES.map((state) => ({
      state, shows: STATE_NOTES[state], still: `${state}.png`, animation: [`${state}.webp`, `${state}.gif`],
    })),
  };
}

export function mascotSpriteReadme(): string {
  const width = Math.max(...MASCOT_SPRITE_STATES.map((state) => state.length)) + 6;
  return [
    "Inertia mascot sprites",
    "",
    `Required: ${MASCOT_SPRITE_STATES.length} still images, one PNG per state, exactly ${SIZE_LABEL}, up to ${BYTES_LABEL} each.`,
    `Optional: ${MASCOT_SPRITE_STATES.length} animations, one animated WebP or GIF per state (for example idle.webp),`,
    `exactly ${SIZE_LABEL}, up to ${BYTES_LABEL} each. A state without an animation shows its still image.`,
    "",
    ...MASCOT_SPRITE_STATES.map((state) => `${`${state}.png`.padEnd(width)}${STATE_NOTES[state]}`),
    "",
    "The PNG files in this folder are the default artwork. Replace them with your own and keep the file names.",
    "Pixel art works best: the mascot is drawn at its exact size without smoothing.",
    "",
    "Then open Settings > General > Desktop mascot, choose Import sprites, select this folder, and apply the preview.",
    "Other files in this folder are ignored.",
    "",
  ].join("\n");
}

export async function writeMascotSpriteTemplate(directory: string): Promise<void> {
  try { await mkdir(directory); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new MascotSpriteError("That name is already in use. Choose a new folder name for the template.");
    }
    throw error;
  }
  const write = (name: string, data: string | Buffer): Promise<void> => writeFile(join(directory, name), data, { flag: "wx" });
  await write("template.json", `${JSON.stringify(mascotSpriteTemplate(), null, 2)}\n`);
  await write("README.txt", mascotSpriteReadme());
  for (const state of MASCOT_SPRITE_STATES) {
    const source = DEFAULT_STILLS[state];
    await write(`${state}.png`, Buffer.from(source.slice(source.indexOf(",") + 1), "base64"));
  }
}
