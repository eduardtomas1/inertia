import type { Protocol } from "electron";

import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  net: { fetch: vi.fn() },
  protocol: { handle: vi.fn() },
}));

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
});
