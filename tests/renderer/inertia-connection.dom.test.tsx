import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clientCommandSchema,
  MAX_WORKSPACE_FILE_EDIT_BYTES,
} from "../../src/shared/contracts";
import { useInertiaConnection } from "../../src/renderer/src/hooks/useInertiaConnection";

class FakeWebSocket extends EventTarget {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readonly readyState = FakeWebSocket.OPEN;
  readonly send = vi.fn();
  readonly close = vi.fn();

  constructor(readonly url: string) {
    super();
    FakeWebSocket.instances.push(this);
  }
}

afterEach(() => {
  FakeWebSocket.instances = [];
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, "inertia");
});

describe("useInertiaConnection", () => {
  it("rejects an escaped oversized command without sending or closing", async () => {
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: {
        getRuntimeConnection: vi.fn(async () => ({
          websocketUrl: "ws://127.0.0.1:12345/runtime/test",
        })),
      },
    });
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const hook = renderHook(() => useInertiaConnection());
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

    const command = clientCommandSchema.parse({
      type: "workspace.file.write",
      requestId: "11111111-1111-4111-8111-111111111111",
      payload: {
        projectId: "22222222-2222-4222-8222-222222222222",
        conversationId: "33333333-3333-4333-8333-333333333333",
        path: "src/example.ts",
        authorityRef: "44444444-4444-4444-8444-444444444444",
        expectedDigest: "a".repeat(64),
        content: "\0".repeat(
          Math.min(MAX_WORKSPACE_FILE_EDIT_BYTES, 50_000),
        ),
      },
    });

    await expect(hook.result.current.sendCommand(command))
      .rejects.toThrow("The request is too large to send.");
    expect(FakeWebSocket.instances[0]?.send).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances[0]?.close).not.toHaveBeenCalled();
  });
});
