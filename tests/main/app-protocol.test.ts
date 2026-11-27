import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Protocol } from "electron";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: true },
  net: { fetch: vi.fn() },
  protocol: { handle: vi.fn() },
}));

import { net } from "electron";
import { createAppProtocolRegistrar } from "../../src/main/app-protocol";
import type { AttachmentRegistry } from "../../src/main/attachment-registry";
import { attachmentWindowScopeForRegistry } from "../../src/main/attachment-window-scope";
import type { ConversationAttachmentAccess } from "../../src/main/conversation-attachment-access";
import { HTML_RENDER_CONTENT_SECURITY_POLICY } from "../../src/main/html-render-document";
import type { RuntimeSupervisor } from "../../src/main/runtime-supervisor";
import { HTML_RENDER_THEME_STYLE_ID } from "../../src/shared/html-render";
import { workspaceMediaPreviewUrl } from "../../src/shared/workspace-media-preview";

function subject(): ReturnType<typeof createAppProtocolRegistrar> {
  return createAppProtocolRegistrar({
    scheme: "inertia-canary",
    attachmentRegistry: () => null,
    conversationAttachments: () => null,
    runtimeSupervisor: () => null,
  });
}

function protocolTarget(): {
  target: Pick<Protocol, "handle" | "isProtocolHandled">;
  handle: ReturnType<typeof vi.fn>;
} {
  let handled = false;
  const handle = vi.fn();
  handle.mockImplementation(() => { handled = true; });
  return {
    target: {
      handle,
      isProtocolHandled: () => handled,
    } as unknown as Pick<Protocol, "handle" | "isProtocolHandled">,
    handle,
  };
}

describe("application protocol registration", () => {
  it("registers a persistent session only once when the main window reopens", () => {
    const register = subject();
    const { target, handle } = protocolTarget();
    register(target);
    register(target);
    expect(handle).toHaveBeenCalledTimes(1);
    expect(handle).toHaveBeenCalledWith("inertia-canary", expect.any(Function));
  });

  it("fails closed if a registered session is reused for another conversation", () => {
    const register = subject();
    const { target, handle } = protocolTarget();
    register(target, "conversation-one");
    expect(() => register(target, "conversation-two"))
      .toThrow("another conversation scope");
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it("serves only brokered mascot sprites with explicit image headers", async () => {
    vi.mocked(net.fetch).mockResolvedValue(new Response("", { status: 404 }));
    const register = createAppProtocolRegistrar({
      scheme: "inertia", attachmentRegistry: () => null, conversationAttachments: () => null, runtimeSupervisor: () => null,
      mascotSprite: (id, name) => id === "0123456789abcdef" && name === "idle.png" ? { type: "image/png", bytes: Buffer.from("sprite") } : null,
    });
    const { target, handle } = protocolTarget();
    register(target);
    const serve = handle.mock.calls[0]![1] as (request: Request) => Promise<Response>;
    const request = (path: string) => ({ url: `inertia://bundle/${path}`, signal: new AbortController().signal }) as Request;
    const response = await serve(request("mascot-sprites/0123456789abcdef/idle.png"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await response.text()).toBe("sprite");
    for (const path of [
      "mascot-sprites/0123456789abcdef/thinking.png", "mascot-sprites/fedcba9876543210/idle.png",
      "mascot-sprites/0123456789abcdef/idle.png?cache=1", "mascot-sprites/0123456789abcdef/%2e%2e%2fidle.png",
    ]) expect((await serve(request(path))).status).toBe(404);
  });
});


describe("visual reply protocol route", () => {
  const renderId = "55555555-5555-4555-8555-555555555555";
  const conversationId = "22222222-2222-4222-8222-222222222222";
  const page = { conversationId, title: "Weekly chart", html: "<html><head></head><body><p>chart</p></body></html>" };

  function serveRenders(
    readHtmlRender: (id: string) => Promise<typeof page | null>,
    scope?: string,
  ): { serve: (url: string) => Promise<Response>; read: ReturnType<typeof vi.fn> } {
    const read = vi.fn(readHtmlRender);
    const register = createAppProtocolRegistrar({
      scheme: "inertia",
      attachmentRegistry: () => null,
      conversationAttachments: () => null,
      runtimeSupervisor: () => ({ readHtmlRender: read }) as unknown as RuntimeSupervisor,
    });
    const { target, handle } = protocolTarget();
    register(target, scope);
    const handler = handle.mock.calls[0]![1] as (request: Request) => Promise<Response>;
    return {
      serve: (url) => handler({ url, signal: new AbortController().signal } as Request),
      read,
    };
  }

  it("serves a stored page with the sandbox headers and the bootstrap", async () => {
    const { serve, read } = serveRenders(async () => page);
    const response = await serve(`inertia://render/${renderId}`);
    expect(read).toHaveBeenCalledWith(renderId);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(Object.fromEntries(response.headers.entries())).toEqual({
      "content-type": "text/html; charset=utf-8",
      "content-length": String(Buffer.byteLength(body)),
      "content-security-policy": HTML_RENDER_CONTENT_SECURITY_POLICY,
      "x-content-type-options": "nosniff",
      "x-dns-prefetch-control": "off",
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
      "permissions-policy": "camera=(), microphone=(), geolocation=(), display-capture=(), fullscreen=()",
    });
    expect(body).toContain(`<style id="${HTML_RENDER_THEME_STYLE_ID}">`);
    expect(body).toContain("<p>chart</p>");
  });

  it("ignores a fragment that reaches the handler", async () => {
    const { serve } = serveRenders(async () => page);
    expect((await serve(`inertia://render/${renderId}#theme=%7B%7D`)).status).toBe(200);
  });

  it.each([
    ["a malformed id", "inertia://render/not-a-render"],
    ["a non-uuid hex id", `inertia://render/${"a".repeat(36)}`],
    ["an empty path", "inertia://render/"],
    ["a nested path", `inertia://render/${renderId}/index.html`],
    ["a parent path", `inertia://render/x/${renderId}`],
    ["an encoded separator", `inertia://render/%2e%2e%2f${renderId}`],
    ["a query string", `inertia://render/${renderId}?x=1`],
    ["userinfo", `inertia://user@render/${renderId}`],
    ["a password", `inertia://user:secret@render/${renderId}`],
    ["a port", `inertia://render:8080/${renderId}`],
  ])("returns 404 without asking the runtime for %s", async (_label, url) => {
    const { serve, read } = serveRenders(async () => page);
    const response = await serve(url);
    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(read).not.toHaveBeenCalled();
  });

  it("treats a render path under the bundle host as a bundle file, never as a page", async () => {
    vi.mocked(net.fetch).mockResolvedValue(new Response("", { status: 404 }));
    const { serve, read } = serveRenders(async () => page);
    expect((await serve(`inertia://bundle/render/${renderId}`)).status).toBe(404);
    expect(read).not.toHaveBeenCalled();
    expect(vi.mocked(net.fetch).mock.calls.at(-1)?.[0]).toMatch(/^file:.*\/render\/55555555-5555-4555-8555-555555555555$/u);
  });

  async function expectUnavailablePage(response: Response): Promise<void> {
    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("Content-Security-Policy")).toBe(HTML_RENDER_CONTENT_SECURITY_POLICY);
    expect(response.headers.get("X-DNS-Prefetch-Control")).toBe("off");
    const body = await response.text();
    expect(body).toContain(`<style id="${HTML_RENDER_THEME_STYLE_ID}">`);
    expect(body).toContain("This page is no longer available.");
    expect(body).not.toContain("Not found");
  }

  async function expectTemporarilyUnavailablePage(response: Response): Promise<void> {
    expect(response.status).toBe(503);
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("Content-Security-Policy")).toBe(HTML_RENDER_CONTENT_SECURITY_POLICY);
    const body = await response.text();
    expect(body).toContain(`<style id="${HTML_RENDER_THEME_STYLE_ID}">`);
    expect(body).toContain("This page is temporarily unavailable.");
    expect(body).not.toContain("no longer available");
  }

  it("serves the themed unavailable page for an unknown render", async () => {
    await expectUnavailablePage(await serveRenders(async () => null).serve(`inertia://render/${renderId}`));
  });

  it("serves a temporary notice when the runtime rejects, times out, or is not running", async () => {
    const rejected = serveRenders(() => Promise.reject(new Error("The visual reply request timed out.")));
    await expectTemporarilyUnavailablePage(await rejected.serve(`inertia://render/${renderId}`));
    const thrown = serveRenders(() => { throw new Error("The runtime is restarting."); });
    await expectTemporarilyUnavailablePage(await thrown.serve(`inertia://render/${renderId}`));
    const foreignScope = serveRenders(() => Promise.reject(new Error("timed out")), "33333333-3333-4333-8333-333333333333");
    await expectTemporarilyUnavailablePage(await foreignScope.serve(`inertia://render/${renderId}`));

    const register = createAppProtocolRegistrar({
      scheme: "inertia", attachmentRegistry: () => null, conversationAttachments: () => null, runtimeSupervisor: () => null,
    });
    const { target, handle } = protocolTarget();
    register(target);
    const handler = handle.mock.calls[0]![1] as (request: Request) => Promise<Response>;
    await expectTemporarilyUnavailablePage(
      await handler({ url: `inertia://render/${renderId}`, signal: new AbortController().signal } as Request),
    );
  });

  it("serves a detached window only pages from its own conversation", async () => {
    const matching = serveRenders(async () => page, conversationId);
    expect((await matching.serve(`inertia://render/${renderId}`)).status).toBe(200);
    const foreign = serveRenders(async () => page, "33333333-3333-4333-8333-333333333333");
    const response = await foreign.serve(`inertia://render/${renderId}`);
    // Indistinguishable from a page that does not exist.
    await expectUnavailablePage(response);
  });
});

describe("detached-chat attachment preview isolation", () => {
  const attachmentId = "77777777-7777-4777-8777-777777777777";
  const tempAttachmentId = "88888888-8888-4888-8888-888888888888";

  function makeRetainedStore(): ConversationAttachmentAccess {
    const bytes = Buffer.from("conversation-b-secret-attachment", "utf8");
    return Promise.resolve({
      preview: vi.fn(async (id: string) => id === attachmentId ? {
        attachment: { id, name: "secret.txt", mimeType: "text/plain", size: bytes.byteLength },
        bytes,
      } : null),
    }) as unknown as ConversationAttachmentAccess;
  }

  function makeRegistry(): AttachmentRegistry {
    const bytes = Buffer.from("staged-draft-bytes", "utf8");
    return {
      preview: vi.fn(async (id: string) => id === tempAttachmentId ? {
        bytes,
        mimeType: "text/plain",
        size: bytes.byteLength,
      } : null),
    } as unknown as AttachmentRegistry;
  }

  it("blocks cross-conversation retained previews and fails closed when runtimeSupervisor is unavailable", async () => {
    const retained = makeRetainedStore();
    const attachmentConversations = vi.fn(async () => ["conv-b"]);
    const register = createAppProtocolRegistrar({
      scheme: "inertia",
      attachmentRegistry: () => null,
      conversationAttachments: () => retained,
      runtimeSupervisor: () => ({ attachmentConversations }) as unknown as RuntimeSupervisor,
    });
    const { target, handle } = protocolTarget();
    register(target, "conv-a");
    const serve = handle.mock.calls[0]![1] as (request: Request) => Promise<Response>;

    const denied = await serve({
      url: `inertia://bundle/attachment-preview/${attachmentId}`,
      signal: new AbortController().signal,
    } as Request);
    expect(denied.status).toBe(404);
    expect(attachmentConversations).toHaveBeenCalledWith(attachmentId);

    attachmentConversations.mockResolvedValueOnce(["conv-a", "conv-b"]);
    const allowed = await serve({
      url: `inertia://bundle/attachment-preview/${attachmentId}`,
      signal: new AbortController().signal,
    } as Request);
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).toBe("conversation-b-secret-attachment");

    const noSupervisorRegister = createAppProtocolRegistrar({
      scheme: "inertia",
      attachmentRegistry: () => null,
      conversationAttachments: () => retained,
      runtimeSupervisor: () => null,
    });
    const { target: target2, handle: handle2 } = protocolTarget();
    noSupervisorRegister(target2, "conv-a");
    const serve2 = handle2.mock.calls[0]![1] as (request: Request) => Promise<Response>;
    const noSupervisorResponse = await serve2({
      url: `inertia://bundle/attachment-preview/${attachmentId}`,
      signal: new AbortController().signal,
    } as Request);
    expect(noSupervisorResponse.status).toBe(404);
  });

  it("blocks temporary staged previews owned by main or another detached chat while allowing own staged previews", async () => {
    const registry = makeRegistry();
    const tracker = attachmentWindowScopeForRegistry(registry);
    tracker.recordAttachment(tempAttachmentId, { kind: "main" });

    const register = createAppProtocolRegistrar({
      scheme: "inertia",
      attachmentRegistry: () => registry,
      conversationAttachments: () => null,
      runtimeSupervisor: () => ({
        attachmentConversations: vi.fn(async () => []),
      }) as unknown as RuntimeSupervisor,
    });
    const { target, handle } = protocolTarget();
    register(target, "conv-a");
    const serve = handle.mock.calls[0]![1] as (request: Request) => Promise<Response>;

    const deniedMain = await serve({
      url: `inertia://bundle/attachment-preview/${tempAttachmentId}`,
      signal: new AbortController().signal,
    } as Request);
    expect(deniedMain.status).toBe(404);
    expect(registry.preview).not.toHaveBeenCalled();

    tracker.recordAttachment(tempAttachmentId, { kind: "detached-chat", conversationId: "conv-b" });
    const deniedOtherChat = await serve({
      url: `inertia://bundle/attachment-preview/${tempAttachmentId}`,
      signal: new AbortController().signal,
    } as Request);
    expect(deniedOtherChat.status).toBe(404);

    tracker.recordAttachment(tempAttachmentId, { kind: "detached-chat", conversationId: "conv-a" });
    const allowedOwn = await serve({
      url: `inertia://bundle/attachment-preview/${tempAttachmentId}`,
      signal: new AbortController().signal,
    } as Request);
    expect(allowedOwn.status).toBe(200);
    expect(await allowedOwn.text()).toBe("staged-draft-bytes");
  });
});

describe("workspace media protocol route", () => {
  const projectId = "11111111-1111-4111-8111-111111111111";
  const conversationId = "22222222-2222-4222-8222-222222222222";
  const otherConversationId = "33333333-3333-4333-8333-333333333333";
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("serves workspace media with range support, conversation scoping, and dev-only CORS", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "inertia-app-protocol-media-")));
    tempDirs.push(dir);
    const pdfPath = join(dir, "doc.pdf");
    const pdfBytes = Buffer.from("%PDF-1.7\nhello world\n%%EOF\n", "ascii");
    await writeFile(pdfPath, pdfBytes);

    const resolveProjectPath = vi.fn(async () => pdfPath);
    const registerPackaged = createAppProtocolRegistrar({
      scheme: "inertia",
      attachmentRegistry: () => null,
      conversationAttachments: () => null,
      runtimeSupervisor: () => ({ resolveProjectPath }) as unknown as RuntimeSupervisor,
    });
    const packagedTarget = protocolTarget();
    registerPackaged(packagedTarget.target, conversationId);
    const servePackaged = packagedTarget.handle.mock.calls[0]![1] as (
      request: Request,
    ) => Promise<Response>;

    const ownUrl = workspaceMediaPreviewUrl({
      projectId,
      conversationId,
      relativePath: "doc.pdf",
    });
    const rangeRes = await servePackaged(
      new Request(ownUrl, {
        headers: {
          Range: "bytes=0-7",
          Origin: "http://localhost:5173",
        },
      }),
    );
    expect(rangeRes.status).toBe(206);
    expect(rangeRes.headers.get("Content-Type")).toBe("application/pdf");
    expect(rangeRes.headers.get("Content-Range")).toBe(`bytes 0-7/${pdfBytes.length}`);
    expect(rangeRes.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(await rangeRes.text()).toBe("%PDF-1.7");

    // Foreign conversation blocked in detached conversationScope
    const foreignUrl = workspaceMediaPreviewUrl({
      projectId,
      conversationId: otherConversationId,
      relativePath: "doc.pdf",
    });
    expect((await servePackaged(new Request(foreignUrl))).status).toBe(404);

    // Dev loopback CORS enabled explicitly
    const registerDev = createAppProtocolRegistrar({
      scheme: "inertia",
      attachmentRegistry: () => null,
      conversationAttachments: () => null,
      runtimeSupervisor: () => ({ resolveProjectPath }) as unknown as RuntimeSupervisor,
      allowDevLoopbackCors: true,
    });
    const devTarget = protocolTarget();
    registerDev(devTarget.target);
    const serveDev = devTarget.handle.mock.calls[0]![1] as (
      request: Request,
    ) => Promise<Response>;

    const devRes = await serveDev(
      new Request(ownUrl, { headers: { Origin: "http://localhost:5173" } }),
    );
    expect(devRes.status).toBe(200);
    expect(devRes.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
    expect(devRes.headers.get("Vary")).toBe("Origin");
    await devRes.body!.cancel();

    // Thrown workspace-media validation/open errors still preserve dev loopback CORS on 404
    const missingUrl = workspaceMediaPreviewUrl({
      projectId,
      conversationId,
      relativePath: "missing.pdf",
    });
    resolveProjectPath.mockRejectedValueOnce(new Error("ENOENT"));
    const devErrRes = await serveDev(
      new Request(missingUrl, { headers: { Origin: "http://localhost:5173" } }),
    );
    expect(devErrRes.status).toBe(404);
    expect(devErrRes.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
    expect(devErrRes.headers.get("Vary")).toBe("Origin");
  });
});
