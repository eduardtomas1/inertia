import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, rename, rm, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { BrowserWindow, Dialog, IpcMain, IpcMainInvokeEvent } from "electron";
import {
  COMPLETION_SOUND_EXTENSIONS,
  COMPLETION_SOUND_FILE_PATTERN,
  COMPLETION_SOUND_IPC,
  COMPLETION_SOUND_LIBRARY_MAX,
  COMPLETION_SOUND_MAX_BYTES,
  completionSoundName,
  isCompletionSoundFile,
  type CompletionSoundExtension,
  type CompletionSoundFile,
  type CompletionSoundImport,
  type CustomCompletionSound,
} from "../shared/completion-sound.js";

export class CompletionSoundError extends Error {}

const MAX_LABEL = `${COMPLETION_SOUND_MAX_BYTES / 1024 / 1024} MB`;
const FORMAT_LABEL = "WAV, MP3, OGG, Opus, FLAC, M4A, AAC or WebM";

const ascii = (bytes: Uint8Array, start: number, text: string): boolean =>
  bytes.byteLength >= start + text.length
  && [...text].every((character, index) => bytes[start + index] === character.charCodeAt(0));
const mpegFrame = (bytes: Uint8Array): boolean => bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0;
const adtsFrame = (bytes: Uint8Array): boolean => bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xf6) === 0xf0;
const ogg = (bytes: Uint8Array): boolean => ascii(bytes, 0, "OggS");

const SIGNATURES: Readonly<Record<CompletionSoundExtension, (bytes: Uint8Array) => boolean>> = {
  wav: (bytes) => ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WAVE"),
  mp3: (bytes) => ascii(bytes, 0, "ID3") || mpegFrame(bytes),
  ogg,
  oga: ogg,
  opus: ogg,
  flac: (bytes) => ascii(bytes, 0, "fLaC"),
  m4a: (bytes) => ascii(bytes, 4, "ftyp"),
  aac: (bytes) => ascii(bytes, 0, "ID3") || adtsFrame(bytes),
  webm: (bytes) => bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3,
};

export function completionSoundExtension(path: string): CompletionSoundExtension {
  const extension = extname(path).slice(1).toLowerCase();
  if (!(COMPLETION_SOUND_EXTENSIONS as readonly string[]).includes(extension)) {
    throw new CompletionSoundError(`Choose a ${FORMAT_LABEL} file.`);
  }
  return extension as CompletionSoundExtension;
}

export function validateCompletionSound(extension: CompletionSoundExtension, bytes: Uint8Array): void {
  if (!bytes.byteLength) throw new CompletionSoundError("That sound file is empty.");
  if (bytes.byteLength > COMPLETION_SOUND_MAX_BYTES) {
    throw new CompletionSoundError(`That sound file is larger than ${MAX_LABEL}. Choose a short clip of 1 to 3 seconds.`);
  }
  if (!SIGNATURES[extension](bytes)) {
    throw new CompletionSoundError(`That file is not a valid ${extension.toUpperCase()} audio file.`);
  }
}

const STAGING_SUFFIX = ".staging";

const managedEntry = (name: string): boolean =>
  COMPLETION_SOUND_FILE_PATTERN.test(name.endsWith(STAGING_SUFFIX) ? name.slice(0, -STAGING_SUFFIX.length) : name);

async function usableStore(directory: string): Promise<boolean> {
  const entry = await lstat(directory).catch(() => null);
  return entry?.isDirectory() === true;
}

async function readBounded(path: string): Promise<Buffer> {
  const named = await lstat(path, { bigint: true });
  if (named.isSymbolicLink() || !named.isFile()) throw new CompletionSoundError("Choose a regular audio file, not a link or folder.");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== named.dev || opened.ino !== named.ino) {
      throw new CompletionSoundError("That sound file changed while it was being read.");
    }
    const buffer = Buffer.alloc(COMPLETION_SOUND_MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, length, buffer.byteLength - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    return Buffer.from(buffer.subarray(0, length));
  } finally {
    await handle.close();
  }
}

export async function importCompletionSound(
  source: string,
  directory: string,
  keep: readonly CompletionSoundFile[] = [],
): Promise<CustomCompletionSound> {
  const extension = completionSoundExtension(source);
  let bytes: Buffer;
  try {
    bytes = await readBounded(source);
  } catch (error) {
    if (error instanceof CompletionSoundError) throw error;
    throw new CompletionSoundError("That sound file could not be read.");
  }
  validateCompletionSound(extension, bytes);
  const file: CompletionSoundFile = `${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}.${extension}`;
  if (!keep.includes(file) && keep.length >= COMPLETION_SOUND_LIBRARY_MAX) {
    throw new CompletionSoundError(`You can keep up to ${COMPLETION_SOUND_LIBRARY_MAX} sounds. Remove one to import another.`);
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!await usableStore(directory)) throw new CompletionSoundError("The sound library folder could not be used.");
  const staging = join(directory, `${file}${STAGING_SUFFIX}`);
  await rm(staging, { force: true });
  await writeFile(staging, bytes, { mode: 0o600, flag: "wx" });
  await rename(staging, join(directory, file));
  let seen = 0;
  for await (const entry of await opendir(directory)) {
    if (++seen > 256) break;
    if (entry.isFile() && managedEntry(entry.name) && entry.name !== file && !(keep as readonly string[]).includes(entry.name)) {
      await rm(join(directory, entry.name), { force: true }).catch(() => undefined);
    }
  }
  return { file, name: completionSoundName(basename(source, extname(source))) };
}

export async function readCompletionSound(directory: string, file: string): Promise<Uint8Array | null> {
  if (!COMPLETION_SOUND_FILE_PATTERN.test(file) || !await usableStore(directory)) return null;
  try {
    const bytes = await readBounded(join(directory, file));
    validateCompletionSound(completionSoundExtension(file), bytes);
    return new Uint8Array(bytes);
  } catch {
    return null;
  }
}

export function registerCompletionSoundIpc(options: {
  ipcMain: Pick<IpcMain, "handle">;
  assertTrusted: (event: IpcMainInvokeEvent, received: number, expected?: number) => void;
  window: () => BrowserWindow | null;
  dialog: Pick<Dialog, "showOpenDialog">;
  directory: string;
  defaultPath: () => string;
}): void {
  let importing = false;
  options.ipcMain.handle(COMPLETION_SOUND_IPC, async (event, ...args): Promise<CompletionSoundImport | Uint8Array | null | void> => {
    const action = args[0];
    options.assertTrusted(event, args.length, 2);
    if (action === "read") {
      if (typeof args[1] !== "string") throw new Error("Invalid completion sound");
      return await readCompletionSound(options.directory, args[1]);
    }
    if (action === "remove") {
      if (!isCompletionSoundFile(args[1])) throw new Error("Invalid completion sound");
      if (await usableStore(options.directory)) await rm(join(options.directory, args[1]), { force: true });
      return;
    }
    if (action !== "import") throw new Error("Invalid completion sound action");
    const keep = args[1];
    if (!Array.isArray(keep) || keep.length > COMPLETION_SOUND_LIBRARY_MAX || !keep.every(isCompletionSoundFile)) {
      throw new Error("Invalid completion sound library");
    }
    const window = options.window();
    if (!window || window.isDestroyed()) throw new Error("The settings window is unavailable.");
    if (importing) throw new Error("A sound import is already open.");
    importing = true;
    try {
      const result = await options.dialog.showOpenDialog(window, {
        title: "Choose a notification sound",
        defaultPath: options.defaultPath(),
        buttonLabel: "Use sound",
        filters: [{ name: "Audio", extensions: [...COMPLETION_SOUND_EXTENSIONS] }],
        properties: ["openFile"],
      });
      const source = result.canceled ? undefined : result.filePaths[0];
      if (!source) return { status: "cancelled" };
      return { status: "imported", sound: await importCompletionSound(source, options.directory, keep) };
    } catch (error) {
      if (error instanceof CompletionSoundError) return { status: "rejected", message: error.message };
      throw new Error("The sound could not be imported.");
    } finally {
      importing = false;
    }
  });
}
