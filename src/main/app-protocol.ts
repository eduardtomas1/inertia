import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { net, protocol, type Protocol } from "electron";

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
  scheme?: string;
  attachmentRegistry: () => AttachmentRegistry | null;
  conversationAttachments: () => ConversationAttachmentAccess | null;
  runtimeSupervisor: () => RuntimeSupervisor | null;
  workspaceImageConversationId?: string;
}, target: Pick<Protocol, "handle"> = protocol): void {
  const rendererRoot = fileURLToPath(new URL("../renderer/", import.meta.url));
  target.handle(options.scheme ?? APP_SCHEME, async (request) => {
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
        if (
          options.workspaceImageConversationId
          && workspaceImageRequest.conversationId
            !== options.workspaceImageConversationId
        ) throw new Error();
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

export function createAppProtocolRegistrar(options: {
  scheme: string;
  attachmentRegistry: () => AttachmentRegistry | null;
  conversationAttachments: () => ConversationAttachmentAccess | null;
  runtimeSupervisor: () => RuntimeSupervisor | null;
}): (target?: Pick<Protocol, "handle" | "isProtocolHandled">, conversationId?: string) => void {
  const registrations = new WeakMap<
    Pick<Protocol, "handle" | "isProtocolHandled">,
    string | null
  >();
  return (target = protocol, conversationId) => {
    const scope = conversationId ?? null;
    if (registrations.has(target)) {
      if (registrations.get(target) !== scope) {
        throw new Error("The renderer protocol session already has another conversation scope.");
      }
      return;
    }
    if (target.isProtocolHandled(options.scheme)) {
      if (scope !== null) {
        throw new Error("The renderer protocol session already has another conversation scope.");
      }
      return;
    }
    registerAppProtocol({
      ...options,
      workspaceImageConversationId: conversationId,
    }, target);
    registrations.set(target, scope);
  };
}
