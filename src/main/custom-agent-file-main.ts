import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, rename, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { BrowserWindow, Dialog, IpcMain, IpcMainInvokeEvent } from "electron";

import { FILE_OPEN_NO_FOLLOW } from "../node/platform-file-open-flags.js";
import {
  customAgentExportFileName,
  customAgentExportSchema,
  MAX_CUSTOM_AGENT_EXPORT_BYTES,
  type CustomAgentDraft,
} from "../shared/custom-agents.js";
import { DESKTOP_IPC } from "../shared/desktop-ipc.js";
import type { CustomAgentExportResult, CustomAgentImportResult } from "../shared/desktop.js";

export class CustomAgentFileError extends Error {}

const FILE_MODE = 0o600;
const JSON_FILTERS = [{ name: "JSON", extensions: ["json"] }];
const NOT_AN_EXPORT = "That file is not an Inertia custom agents export.";
const SIZE_LABEL = `${MAX_CUSTOM_AGENT_EXPORT_BYTES / 1024 / 1024} MB`;

function missing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function removePartial(path: string): Promise<void> {
  try {
    const entry = await lstat(path);
    if (entry.isFile() && !entry.isSymbolicLink()) await unlink(path);
  } catch (error) {
    if (!missing(error)) throw error;
  }
}

export async function writeCustomAgentExportFile(selected: string, content: string): Promise<void> {
  if (Buffer.byteLength(content, "utf8") > MAX_CUSTOM_AGENT_EXPORT_BYTES) {
    throw new CustomAgentFileError(`The export is larger than ${SIZE_LABEL}.`);
  }
  if (!isAbsolute(selected)) throw new CustomAgentFileError("Choose a folder on this computer.");
  const parent = await realpath(dirname(selected));
  const target = join(parent, basename(selected));
  try {
    const previous = await lstat(target);
    if (!previous.isFile() || previous.isSymbolicLink() || previous.nlink !== 1) {
      throw new CustomAgentFileError("Choose a regular file, not a link or folder.");
    }
  } catch (error) {
    if (!missing(error)) throw error;
  }
  const partial = join(parent, `.inertia-agents-${randomUUID()}.partial`);
  let file: FileHandle | null = null;
  let published = false;
  try {
    file = await open(partial, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | FILE_OPEN_NO_FOLLOW, FILE_MODE);
    await file.writeFile(content, "utf8");
    await file.chmod(FILE_MODE);
    await file.sync();
    await file.close();
    file = null;
    await rename(partial, target);
    published = true;
  } finally {
    if (file) await file.close().catch(() => undefined);
    if (!published) await removePartial(partial).catch(() => undefined);
  }
}

export async function readCustomAgentExportFile(path: string): Promise<CustomAgentDraft[]> {
  const named = await lstat(path, { bigint: true });
  if (named.isSymbolicLink() || !named.isFile()) throw new CustomAgentFileError("Choose a regular file, not a link or folder.");
  if (named.size < 1n) throw new CustomAgentFileError("That file is empty.");
  if (named.size > BigInt(MAX_CUSTOM_AGENT_EXPORT_BYTES)) throw new CustomAgentFileError(`That file is larger than ${SIZE_LABEL}.`);
  const handle = await open(path, constants.O_RDONLY | FILE_OPEN_NO_FOLLOW | (constants.O_NONBLOCK ?? 0));
  let bytes: Buffer;
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== named.dev || opened.ino !== named.ino) {
      throw new CustomAgentFileError("That file changed while it was being read.");
    }
    const buffer = Buffer.alloc(MAX_CUSTOM_AGENT_EXPORT_BYTES + 1);
    let length = 0;
    while (length < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, length, buffer.byteLength - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_CUSTOM_AGENT_EXPORT_BYTES) throw new CustomAgentFileError(`That file is larger than ${SIZE_LABEL}.`);
    bytes = buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new CustomAgentFileError(NOT_AN_EXPORT);
  }
  const parsed = customAgentExportSchema.safeParse(value);
  if (!parsed.success) throw new CustomAgentFileError(NOT_AN_EXPORT);
  return parsed.data.agents;
}

export function registerCustomAgentFileIpc(options: {
  ipcMain: Pick<IpcMain, "handle">;
  assertTrusted: (event: IpcMainInvokeEvent, received: number, expected?: number) => void;
  window: () => BrowserWindow | null;
  dialog: Pick<Dialog, "showOpenDialog" | "showSaveDialog">;
  defaultPath: () => string;
}): void {
  let dialogOpen = false;
  options.ipcMain.handle(DESKTOP_IPC.customAgentFile, async (event, ...args): Promise<CustomAgentExportResult | CustomAgentImportResult> => {
    const action = args[0];
    options.assertTrusted(event, args.length, action === "export" ? 2 : 1);
    if (action !== "export" && action !== "import") throw new Error("Invalid custom agent file action");
    const payload = action === "export" ? customAgentExportSchema.safeParse(args[1]) : null;
    if (payload && !payload.success) throw new Error("Invalid custom agent export");
    const window = options.window();
    if (!window || window.isDestroyed()) throw new Error("The settings window is unavailable.");
    if (dialogOpen) throw new Error("A custom agent file dialog is already open.");
    dialogOpen = true;
    try {
      if (payload?.success) {
        const content = `${JSON.stringify(payload.data, null, 2)}\n`;
        if (Buffer.byteLength(content, "utf8") > MAX_CUSTOM_AGENT_EXPORT_BYTES) {
          return { status: "rejected", message: `The export is larger than ${SIZE_LABEL}.` };
        }
        const result = await options.dialog.showSaveDialog(window, {
          title: payload.data.agents.length === 1 ? "Export custom agent" : "Export custom agents",
          defaultPath: join(options.defaultPath(), customAgentExportFileName(payload.data.agents)),
          buttonLabel: "Export",
          filters: JSON_FILTERS,
          properties: ["createDirectory", "showOverwriteConfirmation"],
        });
        if (result.canceled || !result.filePath) return { status: "cancelled" };
        await writeCustomAgentExportFile(result.filePath, content);
        return { status: "exported" };
      }
      const result = await options.dialog.showOpenDialog(window, {
        title: "Import custom agents",
        defaultPath: options.defaultPath(),
        buttonLabel: "Import",
        filters: JSON_FILTERS,
        properties: ["openFile"],
      });
      const source = result.canceled ? undefined : result.filePaths[0];
      if (!source) return { status: "cancelled" };
      return { status: "imported", agents: await readCustomAgentExportFile(source) };
    } catch (error) {
      if (error instanceof CustomAgentFileError) return { status: "rejected", message: error.message };
      return { status: "rejected", message: action === "export" ? "The agents could not be exported." : "The agents could not be imported." };
    } finally {
      dialogOpen = false;
    }
  });
}
