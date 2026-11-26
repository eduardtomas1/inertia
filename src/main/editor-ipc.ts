import { lstat } from "node:fs/promises";
import { extname } from "node:path";

import { ipcMain, type IpcMainInvokeEvent } from "electron";

import type { RuntimeEditorContextResult } from "../node/runtime-editor-protocol.js";
import type { DesktopWindowContext, OpenProjectPathRequest } from "../shared/desktop.js";
import {
  isEditorId,
  parseGetAvailableEditorsRequest,
  type DetectedEditor,
  type EditorPosition,
  type PreferredEditor,
} from "../shared/editors.js";
import type { EditorLauncher } from "./editor-launcher.js";

export interface EditorIpcOptions {
  channel: string;
  assertTrusted: (
    event: IpcMainInvokeEvent,
    argumentCount: number,
    expectedArguments: number,
  ) => DesktopWindowContext;
  launcher: EditorLauncher;
}

export interface EditorRuntimeBridge {
  editorContext(filePath?: string, conversationId?: string): Promise<RuntimeEditorContextResult>;
}

export function registerEditorIpc(options: EditorIpcOptions): void {
  ipcMain.handle(options.channel, async (event, ...args) => {
    if (args.length > 1) {
      options.assertTrusted(event, args.length, 1);
    }
    options.assertTrusted(event, args.length, args.length);
    const request = parseGetAvailableEditorsRequest(args[0]);
    if (!request) {
      throw new Error("Invalid editor list request");
    }
    return await options.launcher.detectAvailableEditors(request);
  });
}

export async function resolveContextMenuEditorState(
  launcher: EditorLauncher,
  runtime: EditorRuntimeBridge | null,
): Promise<{ preferredEditor: PreferredEditor; detectedEditors: DetectedEditor[] }> {
  const [detectedEditors, context] = await Promise.all([
    launcher.detectAvailableEditors().catch(() => [] as DetectedEditor[]),
    runtime
      ? runtime.editorContext().catch(() => ({ preferredEditor: "system" as const }))
      : Promise.resolve({ preferredEditor: "system" as const }),
  ]);
  return { preferredEditor: context.preferredEditor, detectedEditors };
}

export async function openProjectPathInEditor(
  launcher: EditorLauncher,
  runtime: EditorRuntimeBridge,
  resolvedPath: string,
  request: OpenProjectPathRequest,
): Promise<string> {
  const context = await runtime.editorContext(resolvedPath, request.conversationId);
  if (!context.authorizedPath || !context.projectRoot) {
    throw new Error("The requested path is outside the authorized project.");
  }
  const editor = request.editor ?? (isEditorId(context.preferredEditor) ? context.preferredEditor : null);
  if (!editor) {
    throw new Error("Choose an editor in Settings before opening files in an editor.");
  }
  await launcher.launchEditor({
    editor,
    targetPath: context.authorizedPath,
    authorizedRoot: context.projectRoot,
    projectRoot: context.projectRoot,
    ...(request.line !== undefined ? { line: request.line } : {}),
    ...(request.column !== undefined ? { column: request.column } : {}),
  });
  return "";
}

export async function tryOpenLinkInPreferredEditor(
  launcher: EditorLauncher,
  runtime: EditorRuntimeBridge | null,
  filePath: string,
  position: EditorPosition,
  conversationId?: string,
): Promise<boolean> {
  if (!runtime) return false;
  let context: RuntimeEditorContextResult;
  try {
    context = await runtime.editorContext(filePath, conversationId);
  } catch {
    return false;
  }
  if (!isEditorId(context.preferredEditor) || !context.authorizedPath || !context.projectRoot) {
    return false;
  }
  const metadata = await lstat(context.authorizedPath).catch(() => null);
  if (!metadata || !metadata.isFile() || metadata.isSymbolicLink()) {
    return false;
  }
  if (extname(context.authorizedPath).toLowerCase() === ".code-workspace") {
    return false;
  }
  await launcher.launchEditor({
    editor: context.preferredEditor,
    targetPath: context.authorizedPath,
    authorizedRoot: context.projectRoot,
    projectRoot: context.projectRoot,
    ...(position.line !== undefined ? { line: position.line } : {}),
    ...(position.column !== undefined ? { column: position.column } : {}),
  });
  return true;
}
