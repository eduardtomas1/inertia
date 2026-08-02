import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RemoteAccessState } from "../../src/shared/remote-protocol";
import { useRemoteAccessState } from "../../src/renderer/src/hooks/useRemoteAccessState";

function state(activeSessions: number): RemoteAccessState {
  return {
    available: true,
    enabled: true,
    relayUrl: "wss://relay.example/remote",
    connection: "online",
    connectionMessage: null,
    activeSessions,
    devices: [],
    pendingPairings: [],
    invitation: null,
    audit: [],
  };
}

afterEach(() => {
  Reflect.deleteProperty(window, "inertia");
});

describe("useRemoteAccessState", () => {
  it("keeps live state when the initial snapshot resolves late", async () => {
    let publish: ((value: RemoteAccessState) => void) | null = null;
    let settleInitial: (() => void) | null = null;
    const initial = new Promise<RemoteAccessState>((resolve) => {
      settleInitial = () => resolve(state(0));
    });
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: {
        getRemoteAccessState: () => initial,
        onRemoteAccessState: (listener: (value: RemoteAccessState) => void) => {
          publish = listener;
          return () => {
            publish = null;
          };
        },
      },
    });

    const { result } = renderHook(() => useRemoteAccessState());
    await waitFor(() => expect(publish).not.toBeNull());
    await act(async () => {
      publish!(state(3));
      await Promise.resolve();
    });
    expect(result.current.status).toBe("ready");
    expect(result.current.state?.activeSessions).toBe(3);

    await act(async () => {
      settleInitial!();
      await initial;
      await Promise.resolve();
    });
    expect(result.current.state?.activeSessions).toBe(3);
  });

  it("surfaces an initial load error and recovers through Retry", async () => {
    const getRemoteAccessState = vi.fn()
      .mockRejectedValueOnce(new Error("Secure remote state is unavailable."))
      .mockResolvedValueOnce(state(1));
    Object.defineProperty(window, "inertia", {
      configurable: true,
      value: {
        getRemoteAccessState,
        onRemoteAccessState: vi.fn(() => vi.fn()),
      },
    });

    const { result } = renderHook(() => useRemoteAccessState());
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error).toBe("Secure remote state is unavailable.");

    act(() => result.current.retry());
    expect(result.current.status).toBe("loading");
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.state?.activeSessions).toBe(1);
    expect(getRemoteAccessState).toHaveBeenCalledTimes(2);
  });
});
