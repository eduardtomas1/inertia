import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { net, protocol, type Protocol } from "electron";

import type { RuntimeHtmlRenderDocument } from "../node/runtime-html-render-protocol.js";
import { HTML_RENDER_PROTOCOL_HOST, isHtmlRenderId } from "../shared/html-render.js";
import { parseWorkspaceImagePreviewUrl } from "../shared/workspace-image-preview.js";
import type { AttachmentRegistry } from "./attachment-registry.js";
import {
  resolveAttachmentPreviewResponse,
  type ConversationAttachmentAccess,
} from "./conversation-attachment-access.js";
import { htmlRenderDocumentResponse, htmlRenderUnavailableResponse } from "./html-render-document.js";
import type { RuntimeSupervisor } from "./runtime-supervisor.js";
import { resolveWorkspaceImagePreviewResponse } from "./workspace-image-preview.js";

export const APP_SCHEME = "inertia";
export const APP_HOST = "bundle";

function isContained(root: string, target: string): boolean {
  const child = relative(root, target);
  return child === ""
    || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

/** `<scheme>://render/<renderId>`; a fragment never reaches the handler in practice and is ignored. */
function parseHtmlRenderUrl(url: URL): string | null {
  if (
    url.hostname !== HTML_RENDER_PROTOCOL_HOST
    || url.port
    || url.username
    || url.password
    || url.search
  ) return null;
  const renderId = url.pathname.slice(1);
  return url.pathname.startsWith("/") && isHtmlRenderId(renderId) ? renderId : null;
}

/**
 * A well-formed id that cannot be shown (unknown, from another conversation's
 * window, or unreadable) gets the same themed 404, so a frame neither shows
 * raw text nor learns whether a page exists elsewhere.
 */
async function resolveHtmlRenderResponse(
  runtimeSupervisor: RuntimeSupervisor | null,
  renderId: string,
  conversationScope: string | undefined,
): Promise<Response> {
  let render: RuntimeHtmlRenderDocument | null | undefined;
  try {
    render = await runtimeSupervisor?.readHtmlRender(renderId);
  } catch {
    render = null;
  }
  // A detached window may only show pages from the conversation it was opened for.
  if (!render || (conversationScope && render.conversationId !== conversationScope)) {
    return htmlRenderUnavailableResponse();
  }
  return htmlRenderDocumentResponse(render.html);
}

export function registerAppProtocol(options: {
  scheme?: string;
  attachmentRegistry: () => AttachmentRegistry | null;
  conversationAttachments: () => ConversationAttachmentAccess | null;
  runtimeSupervisor: () => RuntimeSupervisor | null;
  mascotSprite?: (id: string, name: string) => { type: string; bytes: Buffer } | null;
  conversationScope?: string;
}, target: Pick<Protocol, "handle"> = protocol): void {
  const rendererRoot = fileURLToPath(new URL("../renderer/", import.meta.url));
  target.handle(options.scheme ?? APP_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname === HTML_RENDER_PROTOCOL_HOST) {
        const renderId = parseHtmlRenderUrl(url);
        if (!renderId) throw new Error();
        return await resolveHtmlRenderResponse(options.runtimeSupervisor(), renderId, options.conversationScope);
      }
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
      const sprite = /^mascot-sprites\/([0-9a-f]{16})\/([a-z]+\.(?:png|webp|gif))$/u.exec(requestedPath);
      if (sprite) {
        const file = options.mascotSprite?.(sprite[1]!, sprite[2]!);
        if (!file) throw new Error();
        return new Response(new Uint8Array(file.bytes), {
          headers: { "Content-Type": file.type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
        });
      }
      const workspaceImageRequest = parseWorkspaceImagePreviewUrl(url);
      if (workspaceImageRequest) {
        if (
          options.conversationScope
          && workspaceImageRequest.conversationId
            !== options.conversationScope
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
  mascotSprite?: (id: string, name: string) => { type: string; bytes: Buffer } | null;
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
      conversationScope: conversationId,
    }, target);
    registrations.set(target, scope);
  };
}
