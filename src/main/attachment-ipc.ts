import { ipcMain, type IpcMainInvokeEvent } from "electron";

import { parseAttachmentHandoffRequest } from "../shared/attachment-handoff.js";
import type { AttachmentRegistry } from "./attachment-registry.js";
import { releaseRendererAttachment } from "./attachment-release-coordination.js";
import type { RuntimeSupervisor } from "./runtime-supervisor.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface AttachmentIpcOptions {
  channels: {
    prepare: string;
    finish: string;
    release: string;
  };
  assertTrusted(event: IpcMainInvokeEvent, actual: number, expected?: number): void;
  registry(): AttachmentRegistry;
  supervisor(): RuntimeSupervisor | null;
}

export function registerAttachmentLifecycleIpc(
  options: AttachmentIpcOptions,
): void {
  ipcMain.handle(options.channels.prepare, async (event, ...args) => {
    options.assertTrusted(event, args.length, 1);
    const request = parseAttachmentHandoffRequest(args[0]);
    if (!request) throw new Error("Invalid attachment handoff.");
    await options.registry().prepareHandoff(
      request.requestId,
      request.attachmentIds,
      (attachmentId) =>
        options.supervisor()?.ownsAttachment(attachmentId) === true,
    );
  });

  ipcMain.handle(options.channels.finish, (event, ...args) => {
    options.assertTrusted(event, args.length, 1);
    const [value] = args;
    if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
      throw new Error("Invalid attachment handoff.");
    }
    options.registry().finishHandoff(value);
  });

  ipcMain.handle(options.channels.release, async (event, ...args) => {
    options.assertTrusted(event, args.length, 1);
    const [value] = args;
    if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
      throw new Error("Invalid attachment.");
    }
    await releaseRendererAttachment(
      value,
      options.registry(),
      options.supervisor(),
    );
  });
}
