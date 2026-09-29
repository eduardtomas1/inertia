import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { IpcMainInvokeEvent } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CompletionSoundError,
  importCompletionSound,
  readCompletionSound,
  registerCompletionSoundIpc,
  validateCompletionSound,
} from "../../src/main/completion-sound-main";
import { COMPLETION_SOUND_IPC, COMPLETION_SOUND_MAX_BYTES } from "../../src/shared/completion-sound";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "inertia-completion-sound-main-"));
  temporaryDirectories.push(path);
  return path;
}

function wav(extra = 32): Buffer {
  const bytes = Buffer.alloc(12 + extra);
  bytes.write("RIFF", 0, "latin1");
  bytes.writeUInt32LE(4 + extra, 4);
  bytes.write("WAVE", 8, "latin1");
  return bytes;
}

describe("completion sound files", () => {
  it("recognises each supported container by its signature", () => {
    expect(() => validateCompletionSound("wav", wav())).not.toThrow();
    expect(() => validateCompletionSound("mp3", Buffer.from("ID3\u0004\u0000"))).not.toThrow();
    expect(() => validateCompletionSound("mp3", Buffer.from([0xff, 0xfb, 0x90, 0x00]))).not.toThrow();
    expect(() => validateCompletionSound("ogg", Buffer.from("OggS\u0000"))).not.toThrow();
    expect(() => validateCompletionSound("opus", Buffer.from("OggS\u0000"))).not.toThrow();
    expect(() => validateCompletionSound("flac", Buffer.from("fLaC\u0000"))).not.toThrow();
    expect(() => validateCompletionSound("m4a", Buffer.from("\u0000\u0000\u0000 ftypM4A "))).not.toThrow();
    expect(() => validateCompletionSound("aac", Buffer.from([0xff, 0xf1, 0x50, 0x80]))).not.toThrow();
    expect(() => validateCompletionSound("webm", Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01]))).not.toThrow();
  });

  it("rejects empty, oversized and mislabelled files with a readable reason", () => {
    expect(() => validateCompletionSound("wav", Buffer.alloc(0))).toThrow(CompletionSoundError);
    expect(() => validateCompletionSound("wav", Buffer.concat([wav(), Buffer.alloc(COMPLETION_SOUND_MAX_BYTES)])))
      .toThrow(/larger than 1 MB/u);
    expect(() => validateCompletionSound("mp3", Buffer.from("<html>not audio</html>"))).toThrow(/not a valid MP3/u);
    expect(() => validateCompletionSound("wav", Buffer.from("OggS\u0000"))).toThrow(/not a valid WAV/u);
  });

  it("adds content-addressed copies to the library and prunes only files outside it", async () => {
    const source = await directory();
    const store = await directory();
    const first = join(source, "Soft ding.WAV");
    const second = join(source, `bell${String.fromCharCode(0x200b)}.mp3`);
    const orphan = join(source, "orphan.wav");
    await writeFile(first, wav());
    await writeFile(second, Buffer.from("ID3\u0004\u0000rest"));
    await writeFile(orphan, wav(64));

    const imported = await importCompletionSound(first, store);
    expect(imported.file).toMatch(/^[0-9a-f]{16}\.wav$/u);
    expect(imported.name).toBe("Soft ding");
    expect(await readdir(store)).toEqual([imported.file]);
    expect(Buffer.from((await readCompletionSound(store, imported.file))!)).toEqual(wav());

    const abandoned = await importCompletionSound(orphan, store, [imported.file]);
    const added = await importCompletionSound(second, store, [imported.file]);
    expect(added.name).toBe("bell");
    expect((await readdir(store)).sort()).toEqual([imported.file, added.file].sort());
    expect(await readCompletionSound(store, abandoned.file)).toBeNull();
    expect(await readFile(join(store, added.file), "latin1")).toBe("ID3\u0004\u0000rest");
    expect(await importCompletionSound(first, store, [imported.file, added.file])).toEqual(imported);
  });

  it("refuses a ninth sound but still accepts one already in the library", async () => {
    const source = await directory();
    const store = await directory();
    await writeFile(join(source, "one.wav"), wav());
    await writeFile(join(source, "two.wav"), wav(48));
    const first = await importCompletionSound(join(source, "one.wav"), store);
    const keep = [first.file, ...Array.from({ length: 7 }, (_, index) => `${index.toString(16).padStart(16, "0")}.wav` as const)];
    await expect(importCompletionSound(join(source, "two.wav"), store, keep)).rejects.toThrow(/up to 8 sounds/u);
    await expect(importCompletionSound(join(source, "one.wav"), store, keep)).resolves.toEqual(first);
  });

  it("refuses links, folders, unknown extensions and oversized sources", async () => {
    const source = await directory();
    const store = await directory();
    await writeFile(join(source, "real.wav"), wav());
    await symlink(join(source, "real.wav"), join(source, "link.wav"));
    await writeFile(join(source, "clip.exe"), wav());
    await writeFile(join(source, "huge.wav"), Buffer.concat([wav(), Buffer.alloc(COMPLETION_SOUND_MAX_BYTES)]));

    await expect(importCompletionSound(join(source, "link.wav"), store)).rejects.toThrow(/not a link/u);
    await expect(importCompletionSound(source + "/", store)).rejects.toThrow(CompletionSoundError);
    await expect(importCompletionSound(join(source, "clip.exe"), store)).rejects.toThrow(/Choose a WAV/u);
    await expect(importCompletionSound(join(source, "huge.wav"), store)).rejects.toThrow(/larger than 1 MB/u);
    await expect(importCompletionSound(join(source, "missing.wav"), store)).rejects.toThrow(/could not be read/u);
    expect(await readdir(store)).toEqual([]);
  });

  it("refuses a sound library folder that is a link and leaves its target untouched", async () => {
    const source = await directory();
    const elsewhere = await directory();
    const parent = await directory();
    const store = join(parent, "completion-sounds");
    await writeFile(join(source, "ding.wav"), wav());
    await writeFile(join(elsewhere, "keep.txt"), "not a sound");
    await writeFile(join(elsewhere, "0123456789abcdef.wav"), wav());
    await symlink(elsewhere, store, "junction");

    await expect(importCompletionSound(join(source, "ding.wav"), store)).rejects.toThrow(CompletionSoundError);
    expect(await readCompletionSound(store, "0123456789abcdef.wav")).toBeNull();
    expect((await readdir(elsewhere)).sort()).toEqual(["0123456789abcdef.wav", "keep.txt"]);
  });

  it("prunes only the sound files it manages", async () => {
    const source = await directory();
    const store = await directory();
    await writeFile(join(source, "ding.wav"), wav());
    await writeFile(join(store, "notes.txt"), "keep me");
    await mkdir(join(store, "nested"));
    await writeFile(join(store, "nested", "0123456789abcdef.wav"), wav());
    await writeFile(join(store, "fedcba9876543210.wav"), wav(48));
    await writeFile(join(store, "fedcba9876543210.mp3.staging"), "partial");

    const imported = await importCompletionSound(join(source, "ding.wav"), store);
    expect((await readdir(store)).sort()).toEqual([imported.file, "nested", "notes.txt"].sort());
    expect(await readdir(join(store, "nested"))).toEqual(["0123456789abcdef.wav"]);
  });

  it("reads only stored file names", async () => {
    const store = await directory();
    await writeFile(join(store, "0123456789abcdef.wav"), wav());
    expect(await readCompletionSound(store, "0123456789abcdef.wav")).not.toBeNull();
    for (const file of ["../0123456789abcdef.wav", "0123456789ABCDEF.wav", "0123456789abcdef.exe", "missing"]) {
      expect(await readCompletionSound(store, file)).toBeNull();
    }
  });
});

describe("completion sound IPC", () => {
  async function register(options: { canceled?: boolean; path?: string; trusted?: boolean } = {}) {
    const store = await directory();
    const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>();
    const assertTrusted = vi.fn((_event: IpcMainInvokeEvent, received: number, expected = 0) => {
      if (options.trusted === false || received !== expected) throw new Error("Rejected untrusted renderer request");
    });
    const showOpenDialog = vi.fn(async () => ({ canceled: options.canceled ?? false, filePaths: options.path ? [options.path] : [] }));
    const window = { isDestroyed: () => false };
    registerCompletionSoundIpc({
      ipcMain: { handle: (channel: string, handler: never) => { handlers.set(channel, handler); } } as never,
      assertTrusted,
      window: () => window as never,
      dialog: { showOpenDialog } as never,
      directory: store,
      defaultPath: () => "/music",
    });
    const invoke = (...args: unknown[]) => handlers.get(COMPLETION_SOUND_IPC)!({} as IpcMainInvokeEvent, ...args);
    return { store, invoke, showOpenDialog, assertTrusted };
  }

  it("imports through the native picker and reports rejections without throwing", async () => {
    const source = await directory();
    await writeFile(join(source, "ding.wav"), wav());
    await writeFile(join(source, "fake.mp3"), "not audio");

    const accepted = await register({ path: join(source, "ding.wav") });
    const result = await accepted.invoke("import", []) as { status: string; sound: { file: string; name: string } };
    expect(result).toEqual({ status: "imported", sound: { file: expect.stringMatching(/\.wav$/u), name: "ding" } });
    expect(accepted.showOpenDialog).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      properties: ["openFile"],
      filters: [{ name: "Audio", extensions: expect.arrayContaining(["wav", "mp3", "ogg", "flac", "m4a"]) }],
    }));
    expect(await accepted.invoke("read", result.sound.file)).toBeInstanceOf(Uint8Array);
    await accepted.invoke("remove", result.sound.file);
    expect(await accepted.invoke("read", result.sound.file)).toBeNull();

    expect(await (await register({ canceled: true })).invoke("import", [])).toEqual({ status: "cancelled" });
    expect(await (await register({ path: join(source, "fake.mp3") })).invoke("import", []))
      .toEqual({ status: "rejected", message: "That file is not a valid MP3 audio file." });
  });

  it("rejects untrusted senders, unknown actions and malformed arguments", async () => {
    const untrusted = await register({ trusted: false });
    await expect(untrusted.invoke("import", [])).rejects.toThrow(/untrusted/u);
    const trusted = await register();
    await expect(trusted.invoke("delete-everything", [])).rejects.toThrow(/Invalid completion sound action/u);
    await expect(trusted.invoke("read")).rejects.toThrow(/untrusted/u);
    await expect(trusted.invoke("import")).rejects.toThrow(/untrusted/u);
    await expect(trusted.invoke("read", 42)).rejects.toThrow(/Invalid completion sound/u);
    await expect(trusted.invoke("remove", "../../settings.json")).rejects.toThrow(/Invalid completion sound/u);
    await expect(trusted.invoke("import", "/etc/passwd")).rejects.toThrow(/Invalid completion sound library/u);
    await expect(trusted.invoke("import", ["../x.wav"])).rejects.toThrow(/Invalid completion sound library/u);
    await expect(trusted.invoke("import", Array.from({ length: 9 }, (_, index) => `${index.toString(16).padStart(16, "0")}.wav`)))
      .rejects.toThrow(/Invalid completion sound library/u);
    expect(trusted.showOpenDialog).not.toHaveBeenCalled();
  });
});
