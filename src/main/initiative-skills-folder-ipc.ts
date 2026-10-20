import { realpath } from "node:fs";
import { lstat } from "node:fs/promises";
import { promisify } from "node:util";

import type { IpcMain, IpcMainInvokeEvent } from "electron";

import { parseInitiativeSkillsFolderRequest, type RuntimePathRequest } from "../shared/desktop.js";

export const INITIATIVE_SKILLS_FOLDER_OPEN_REFUSAL = "The skills folder could not be opened.";

export interface InitiativeSkillsFolderFilesystem {
  lstat(path: string): Promise<{ isDirectory(): boolean; isSymbolicLink(): boolean }>;
  realpath(path: string): Promise<string>;
}

const nativeRealpath = promisify(realpath.native);

// The runtime resolved the folder with the native realpath; compare like with like.
const nodeFilesystem: InitiativeSkillsFolderFilesystem = {
  lstat: async (path) => await lstat(path),
  realpath: async (path) => await nativeRealpath(path),
};

export interface InitiativeSkillsFolderIpcOptions {
  ipcMain: Pick<IpcMain, "handle">;
  channel: string;
  /** Main-window trust only: the Initiatives page never runs in a detached chat. */
  assertTrusted(event: IpcMainInvokeEvent, argumentCount: number, expectedArguments: number): void;
  /** The supervised runtime, which creates, contains and resolves the folder. */
  runtime(): { resolveProjectPath(request: RuntimePathRequest): Promise<string> } | null;
  openPath(path: string): Promise<string>;
  filesystem?: InitiativeSkillsFolderFilesystem;
}

/**
 * Opens a folder the runtime resolved and contained, after checking it again
 * here: the path must still be a real directory, not a link, and resolve to
 * itself, so a link swapped in after the runtime's check (at the folder or any
 * folder above it) is refused instead of being opened in the file manager.
 */
export async function openVerifiedDirectory(
  path: string,
  openPath: (path: string) => Promise<string>,
  filesystem: InitiativeSkillsFolderFilesystem = nodeFilesystem,
): Promise<void> {
  let verified = false;
  try {
    const status = await filesystem.lstat(path);
    verified = status.isDirectory() && !status.isSymbolicLink()
      && await filesystem.realpath(path) === path;
  } catch {
    verified = false;
  }
  if (!verified || await openPath(path)) throw new Error(INITIATIVE_SKILLS_FOLDER_OPEN_REFUSAL);
}

/**
 * `openInitiativeSkillsFolder`: only an initiative id crosses the bridge. The
 * runtime refuses an initiative without the folder turned on, a folder that
 * fails containment and any request in recovery safety mode; main re-checks
 * the resolved folder before the file manager opens it.
 */
export function registerInitiativeSkillsFolderIpc(options: InitiativeSkillsFolderIpcOptions): void {
  options.ipcMain.handle(options.channel, async (event, ...args) => {
    options.assertTrusted(event, args.length, 1);
    const initiativeId = parseInitiativeSkillsFolderRequest(args[0]);
    if (!initiativeId) throw new Error("Invalid initiative skills folder request");
    const runtime = options.runtime();
    if (!runtime) throw new Error("The local runtime is not available");
    const path = await runtime.resolveProjectPath({ initiativeId });
    await openVerifiedDirectory(path, options.openPath, options.filesystem);
  });
}
