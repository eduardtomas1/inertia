import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadMascotSprites, MascotSpriteError, mascotSprites, mascotSpriteTemplate, readMascotSprites, removeMascotSprites,
  saveMascotSprites, validateMascotSprite, writeMascotSpriteTemplate,
} from "../../src/main/mascot-sprites";
import { MASCOT_SPRITE_LABELS, MASCOT_SPRITE_MAX_BYTES, MASCOT_SPRITE_STATES } from "../../src/shared/mascot-sprites";

const assets = join(__dirname, "../../src/renderer/src/assets/mascot");
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function temporary(): string {
  const directory = mkdtempSync(join(tmpdir(), "mascot-sprites-"));
  directories.push(directory);
  return directory;
}

function png(size = 96, color = "#f5ce69"): Buffer {
  const canvas = createCanvas(size, size);
  const context = canvas.getContext("2d");
  context.fillStyle = color;
  context.fillRect(8, 8, size - 16, size - 16);
  return canvas.toBuffer("image/png");
}

function spriteFolder(files: Record<string, Buffer> = {}): string {
  const directory = temporary();
  for (const state of MASCOT_SPRITE_STATES) writeFileSync(join(directory, `${state}.png`), png());
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(directory, name), bytes);
  return directory;
}

function corruptPixels(bytes: Buffer): Buffer {
  const copy = Buffer.from(bytes);
  const table = Array.from({ length: 256 }, (_, value) => {
    let checksum = value;
    for (let bit = 0; bit < 8; bit += 1) checksum = checksum & 1 ? 0xedb88320 ^ (checksum >>> 1) : checksum >>> 1;
    return checksum >>> 0;
  });
  const offset = copy.indexOf("IDAT") - 4;
  const length = copy.readUInt32BE(offset);
  for (let index = offset + 10; index < offset + 4 + length; index += 1) copy[index]! ^= 0x5a;
  let checksum = 0xffffffff;
  for (const byte of copy.subarray(offset + 4, offset + 8 + length)) checksum = table[(checksum ^ byte) & 0xff]! ^ (checksum >>> 8);
  copy.writeUInt32BE((checksum ^ 0xffffffff) >>> 0, offset + 8 + length);
  return copy;
}

async function rejection(directory: string): Promise<string> {
  const error = await readMascotSprites(directory).then(() => null, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(MascotSpriteError);
  return (error as Error).message;
}

describe("mascot sprite validation", () => {
  it("accepts five still PNGs with optional animations and publishes content-addressed URLs", async () => {
    const directory = spriteFolder({ "idle.webp": readFileSync(join(assets, "idle.webp")), "notes.txt": Buffer.from("ignored") });
    const set = await readMascotSprites(directory);
    expect(set.id).toMatch(/^[0-9a-f]{16}$/u);
    expect(set.files.map((file) => file.name)).toEqual(["idle.png", "idle.webp", "thinking.png", "working.png", "idea.png", "pickup.png"]);
    expect((await readMascotSprites(directory)).id).toBe(set.id);
    const sprites = mascotSprites(set, "inertia://bundle/");
    expect(sprites.animated).toBe(1);
    expect(sprites.files.idle).toEqual({
      poster: `inertia://bundle/mascot-sprites/${set.id}/idle.png`,
      animation: `inertia://bundle/mascot-sprites/${set.id}/idle.webp`,
    });
    expect(sprites.files.working.animation).toBe(sprites.files.working.poster);
    writeFileSync(join(directory, "working.png"), png(96, "#557e81"));
    expect((await readMascotSprites(directory)).id).not.toBe(set.id);
  });

  it("names the missing state, wrong dimensions, formats, sizes and decode failures", async () => {
    const missing = spriteFolder();
    rmSync(join(missing, "thinking.png"));
    expect(await rejection(missing)).toBe("thinking.png is missing. The Thinking state needs a 96 × 96 PNG named thinking.png.");
    expect(await rejection(spriteFolder({ "idea.png": png(128) }))).toBe("idea.png must be 96 × 96 pixels, not 128 × 128.");
    expect(await rejection(spriteFolder({ "working.png": Buffer.from("not an image") }))).toBe("working.png is not a valid PNG image.");
    expect(await rejection(spriteFolder({ "idle.webp": png() }))).toBe("idle.webp is not a valid WebP image.");
    expect(await rejection(spriteFolder({ "pickup.webp": readFileSync(join(assets, "pickup.webp")), "pickup.gif": Buffer.from("GIF89a") })))
      .toBe("Keep one animation for pickup: pickup.webp or pickup.gif.");
    expect(await rejection(spriteFolder({ "idle.gif": Buffer.alloc(MASCOT_SPRITE_MAX_BYTES + 1) }))).toBe("idle.gif is larger than 512 KB. Each image must be 512 KB or smaller.");
    expect(() => validateMascotSprite("idle.jpg", png())).toThrow("idle.jpg must be a PNG, WebP or GIF image.");
    expect(() => validateMascotSprite("idle.png", Buffer.alloc(MASCOT_SPRITE_MAX_BYTES + 1))).toThrow("larger than 512 KB");
    const truncated = png();
    expect(() => validateMascotSprite("idle.png", truncated.subarray(0, truncated.byteLength - 20))).toThrow("idle.png is not a valid PNG image.");
    expect(() => validateMascotSprite("idle.png", corruptPixels(png()))).toThrow("idle.png could not be decoded. Save it again as a standard PNG.");
    expect(() => validateMascotSprite("idle.png", corruptPixels(readFileSync(join(assets, "idle.png"))))).toThrow("idle.png could not be decoded.");
    const folder = spriteFolder();
    rmSync(join(folder, "idle.png"));
    mkdirSync(join(folder, "idle.png"));
    expect(await rejection(folder)).toBe("idle.png must be a regular file.");
  });

  it("names misnamed files and unsupported formats instead of only reporting a missing state", async (context) => {
    const without = (name: string, extra: Record<string, Buffer>): string => {
      const directory = spriteFolder(extra);
      rmSync(join(directory, name));
      return directory;
    };
    expect(await rejection(without("idle.png", { "happy.png": png() }))).toBe(
      "idle.png is missing. happy.png is not a sprite file name. Name each still after its state: idle.png, thinking.png, working.png, idea.png, pickup.png.",
    );
    expect(await rejection(without("idle.png", { "idle.jpg": png() }))).toBe("idle.jpg is not a supported format. Save the Idle image as idle.png, a 96 × 96 PNG.");
    expect(await rejection(without("idea.png", { "d.png": png(), "c.webp": png(), "b.gif": png(), "a.jpeg": png(), "notes.txt": png() }))).toBe(
      "idea.png is missing. a.jpeg, b.gif, c.webp are not sprite file names. Name each still after its state: idle.png, thinking.png, working.png, idea.png, pickup.png.",
    );
    const hidden = await rejection(without("working.png", { "bad\u202egnp.png": png() }));
    expect(hidden).toContain("badgnp.png is not a sprite file name.");
    expect(hidden).not.toMatch(/[\u202a-\u202e\u2066-\u2069]/u);
    const cased = without("thinking.png", {});
    writeFileSync(join(cased, "Thinking.PNG"), png());
    if (existsSync(join(cased, "thinking.png"))) context.skip();
    expect(await rejection(cased)).toBe("Rename Thinking.PNG to thinking.png. Sprite file names are lowercase.");
  });

  it("rejects a sprite linked from outside the chosen folder on every platform", async (context) => {
    const outside = temporary();
    writeFileSync(join(outside, "secret.png"), png());
    const directory = spriteFolder();
    rmSync(join(directory, "idle.png"));
    try {
      symlinkSync(join(outside, "secret.png"), join(directory, "idle.png"), "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      context.skip();
    }
    expect(await rejection(directory)).toBe("idle.png must be a file in the chosen folder, not a link.");
  });
});

describe("mascot sprite persistence", () => {
  it("keeps a committed replacement authoritative when backup cleanup fails, including a failed reset", async () => {
    const root = join(temporary(), "mascot-sprites");
    const first = await readMascotSprites(spriteFolder());
    const next = await readMascotSprites(spriteFolder({ "working.png": png(96, "#557e81") }));
    await saveMascotSprites(root, first);
    let promoted = false;
    const move = async (from: string, to: string): Promise<void> => {
      await rename(from, to);
      if (from.endsWith(".staging")) promoted = true;
    };
    const remove: typeof rm = async (path, options) => {
      if (promoted && path === `${root}.previous`) throw new Error("backup is locked");
      await rm(path, options);
    };
    await expect(saveMascotSprites(root, next, move, remove)).resolves.toBeUndefined();
    expect((await loadMascotSprites(root))?.id).toBe(next.id);
    expect(existsSync(`${root}.previous`)).toBe(true);
    await expect(removeMascotSprites(root, remove)).rejects.toThrow("backup is locked");
    expect((await loadMascotSprites(root))?.id).toBe(next.id);
    await removeMascotSprites(root);
    expect(await loadMascotSprites(root)).toBeNull();
    expect(existsSync(`${root}.previous`)).toBe(false);
  });

  it("saves a set privately, replaces the previous set, survives a reload and resets to defaults", async () => {
    const root = join(temporary(), "mascot-sprites");
    expect(await loadMascotSprites(root)).toBeNull();
    const animated = await readMascotSprites(spriteFolder({ "idle.webp": readFileSync(join(assets, "idle.webp")) }));
    await saveMascotSprites(root, animated);
    expect((await loadMascotSprites(root))?.id).toBe(animated.id);
    if (process.platform !== "win32") expect(statSync(join(root, "idle.png")).mode & 0o777).toBe(0o600);
    const still = await readMascotSprites(spriteFolder());
    await saveMascotSprites(root, still);
    expect(readdirSync(root).sort()).toEqual(MASCOT_SPRITE_STATES.map((state) => `${state}.png`).sort());
    expect(readdirSync(join(root, "..")).sort()).toEqual(["mascot-sprites"]);
    expect((await loadMascotSprites(root))?.id).toBe(still.id);
    await removeMascotSprites(root);
    expect(await loadMascotSprites(root)).toBeNull();
    await removeMascotSprites(root);
  });

  it("keeps the applied set when its replacement cannot be moved into place", async () => {
    const root = join(temporary(), "mascot-sprites");
    const applied = await readMascotSprites(spriteFolder({ "idle.webp": readFileSync(join(assets, "idle.webp")) }));
    await saveMascotSprites(root, applied);
    const lockedStaging = async (from: string, to: string): Promise<void> => {
      if (from.endsWith(".staging")) throw new Error("staging is locked");
      await rename(from, to);
    };
    await expect(saveMascotSprites(root, await readMascotSprites(spriteFolder()), lockedStaging)).rejects.toThrow("staging is locked");
    expect((await loadMascotSprites(root))?.id).toBe(applied.id);
    expect(readdirSync(join(root, "..")).sort()).toEqual(["mascot-sprites"]);
  });

  it("restores the applied set after a replacement was interrupted between its moves", async () => {
    const root = join(temporary(), "mascot-sprites");
    const applied = await readMascotSprites(spriteFolder());
    await saveMascotSprites(root, applied);
    renameSync(root, `${root}.previous`);
    mkdirSync(`${root}.staging`);
    expect((await loadMascotSprites(root))?.id).toBe(applied.id);
    expect(existsSync(`${root}.previous`)).toBe(false);
    await removeMascotSprites(root);
    expect(await loadMascotSprites(root)).toBeNull();
  });

  it("ignores a stored set that no longer validates", async () => {
    const root = join(temporary(), "mascot-sprites");
    await saveMascotSprites(root, await readMascotSprites(spriteFolder()));
    writeFileSync(join(root, "idea.png"), png(64));
    expect(await loadMascotSprites(root)).toBeNull();
  });
});

describe("mascot sprite template", () => {
  it("documents every required image and ships default placeholders that import unchanged", async () => {
    const directory = join(temporary(), "Inertia mascot sprites");
    await writeMascotSpriteTemplate(directory);
    expect(readdirSync(directory).sort()).toEqual(["README.txt", "idea.png", "idle.png", "pickup.png", "template.json", "thinking.png", "working.png"]);
    const template = JSON.parse(readFileSync(join(directory, "template.json"), "utf8")) as ReturnType<typeof mascotSpriteTemplate>;
    expect(template).toMatchObject({
      format: "inertia-mascot-sprites", version: 1, width: 96, height: 96,
      requiredImages: 5, optionalAnimations: 5, maxBytesPerImage: 524_288,
    });
    expect(template.formats.still).toContain("PNG");
    expect(template.formats.animation).toContain("WebP or GIF");
    expect(template.states.map((entry) => [entry.state, entry.label, entry.still, entry.animation])).toEqual(MASCOT_SPRITE_STATES.map((state) => [
      state, MASCOT_SPRITE_LABELS[state], `${state}.png`, [`${state}.webp`, `${state}.gif`],
    ]));
    expect(template.states.find((entry) => entry.still === "idea.png")?.label).toBe("Complete");
    const readme = readFileSync(join(directory, "README.txt"), "utf8");
    expect(readme).toContain("Required: 5 still images, one per state.");
    expect(readme).toContain("Format: PNG, exactly 96 × 96 pixels, a single frame, up to 512 KB each.");
    expect(readme).toMatch(/^idea\.png +Complete: /mu);
    expect(readme).toContain("(for example idle.webp)");
    for (const state of MASCOT_SPRITE_STATES) {
      expect(readme).toContain(`${state}.png`);
      expect(readFileSync(join(directory, `${state}.png`))).toEqual(readFileSync(join(assets, `${state}.png`)));
    }
    expect((await readMascotSprites(directory)).files).toHaveLength(5);
    await expect(writeMascotSpriteTemplate(directory)).rejects.toThrow("Choose a new folder name for the template.");
  });
});
