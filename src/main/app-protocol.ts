import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { net, protocol } from "electron";

import { parseWorkspaceImagePreviewUrl } from "../shared/workspace-image-preview.js";
import type { AttachmentRegistry } from "./attachment-registry.js";
import {
  resolveAttachmentPreviewResponse,
  type ConversationAttachmentAccess,
} from "./conversation-attachment-access.js";
import type { RuntimeSupervisor } from "./runtime-supervisor.js";
import { resolveWorkspaceImagePreviewResponse } from "./workspace-image-preview.js";

export const APP_SCHEME = "inertia";
export const APP_HOST = "bundle";

function isContained(root: string, target: string): boolean {
  const child = relative(root, target);
  return child === ""
    || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

export function registerAppProtocol(options: {
  attachmentRegistry: () => AttachmentRegistry | null;
  conversationAttachments: () => ConversationAttachmentAccess | null;
  runtimeSupervisor: () => RuntimeSupervisor | null;
}): void {
  const rendererRoot = fileURLToPath(new URL("../renderer/", import.meta.url));
  protocol.handle(APP_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      if (
        url.hostname !== APP_HOST
        || url.username
        || url.password
        || url.search
        || url.hash
      ) throw new Error();
      const requestedPath = decodeURIComponent(url.pathname)
        .replace(/^\/+/, "") || "index.html";
      if (requestedPath.includes("\0")) throw new Error();
      const previewId = /^attachment-preview\/([0-9a-f-]{36})$/iu
        .exec(requestedPath)?.[1];
      if (previewId) {
        const response = await resolveAttachmentPreviewResponse(
          options.attachmentRegistry(),
          options.conversationAttachments(),
          previewId,
        );
        if (!response) throw new Error();
        return response;
      }
      const workspaceImageRequest = parseWorkspaceImagePreviewUrl(url);
      if (workspaceImageRequest) {
        const runtimeSupervisor = options.runtimeSupervisor();
        if (!runtimeSupervisor) throw new Error();
        return await resolveWorkspaceImagePreviewResponse(
          runtimeSupervisor,
          workspaceImageRequest,
          request.signal,
        );
      }
      const target = resolve(rendererRoot, requestedPath);
      if (!isContained(rendererRoot, target)) throw new Error();
      return net.fetch(pathToFileURL(target).toString());
    } catch {
      return new Response("Not found", {
        status: 404,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }
  });
}
