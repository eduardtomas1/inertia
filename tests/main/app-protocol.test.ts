import type { Protocol } from "electron";

import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  net: { fetch: vi.fn() },
  protocol: { handle: vi.fn() },
}));

import { net } from "electron";
import { createAppProtocolRegistrar } from "../../src/main/app-protocol";

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

