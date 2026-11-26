import { ipcMain, type IpcMainInvokeEvent } from "electron";

import { parseAttachmentHandoffRequest } from "../shared/attachment-handoff.js";
import type { DesktopWindowContext } from "../shared/desktop.js";
import type { AttachmentRegistry } from "./attachment-registry.js";
import { releaseRendererAttachment } from "./attachment-release-coordination.js";
import {
  attachmentWindowOwnerForContext,
  attachmentWindowScopeForRegistry,
  type AttachmentWindowScopeTracker,
} from "./attachment-window-scope.js";
import type { RuntimeSupervisor } from "./runtime-supervisor.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface AttachmentIpcOptions {
  channels: {
    prepare: string;
    finish: string;
    release: string;
  };
  assertTrusted(event: IpcMainInvokeEvent, actual: number, expected?: number): DesktopWindowContext;
  registry(): AttachmentRegistry;
  supervisor(): RuntimeSupervisor | null;
  scopeTracker?: () => AttachmentWindowScopeTracker;
}

export function registerAttachmentLifecycleIpc(
  options: AttachmentIpcOptions,
): void {
  const resolveTracker = (): AttachmentWindowScopeTracker =>
    options.scopeTracker?.() ?? attachmentWindowScopeForRegistry(options.registry());

  ipcMain.handle(options.channels.prepare, async (event, ...args) => {
    const context = options.assertTrusted(event, args.length, 1);
    const request = parseAttachmentHandoffRequest(args[0]);
    if (!request) throw new Error("Invalid attachment handoff.");
    const tracker = resolveTracker();
    if (context.role === "detached-chat") {
      for (const attachmentId of request.attachmentIds) {
        if (!tracker.canAccessTemporaryAttachment(attachmentId, context)) {
          throw new Error("Invalid attachment handoff.");
        }
      }
    }
    await options.registry().prepareHandoff(
      request.requestId,
      request.attachmentIds,
      (attachmentId) =>
        options.supervisor()?.ownsAttachment(attachmentId) === true,
    );
    tracker.recordHandoff(
      request.requestId,
      attachmentWindowOwnerForContext(context),
    );
  });

  ipcMain.handle(options.channels.finish, (event, ...args) => {
    const context = options.assertTrusted(event, args.length, 1);
    const [value] = args;
    if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
      throw new Error("Invalid attachment handoff.");
    }
    const tracker = resolveTracker();
    if (!tracker.canFinishHandoff(value, context)) {
      throw new Error("Invalid attachment handoff.");
    }
    options.registry().finishHandoff(value);
    tracker.forgetHandoff(value);
  });

  ipcMain.handle(options.channels.release, async (event, ...args) => {
    const context = options.assertTrusted(event, args.length, 1);
    const [value] = args;
    if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
      throw new Error("Invalid attachment.");
    }
    const tracker = resolveTracker();
    if (!tracker.canAccessTemporaryAttachment(value, context)) {
      throw new Error("Invalid attachment.");
    }
    await releaseRendererAttachment(
      value,
      options.registry(),
      options.supervisor(),
    );
    tracker.forgetAttachment(value);
  });
}
