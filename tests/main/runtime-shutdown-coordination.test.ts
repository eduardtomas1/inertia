import { describe, expect, it, vi } from "vitest";

import { stopRuntimeAndPrivateConnect } from "../../src/main/runtime-shutdown-coordination";

describe("runtime shutdown coordination", () => {
  it("starts runtime termination without waiting for Private Connect initialization", async () => {
    let releasePrivateConnect!: () => void;
    const privateConnectStopped = new Promise<void>((resolve) => {
      releasePrivateConnect = resolve;
    });
    const stopRuntime = vi.fn(async () => true);
    const stopPrivateConnect = vi.fn(async () => {
      await privateConnectStopped;
    });

    let settled = false;
    const stopping = stopRuntimeAndPrivateConnect(
      stopRuntime,
      stopPrivateConnect,
    ).finally(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(stopRuntime).toHaveBeenCalledTimes(1);
    expect(stopPrivateConnect).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    releasePrivateConnect();
    await expect(stopping).resolves.toBe(true);
  });
});
