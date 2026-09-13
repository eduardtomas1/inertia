import { describe, expect, it, vi } from "vitest";
import { DuoLaunchCoordinator } from "../../src/server/runtime/duo/duo-launch-coordinator";

describe("Duo cancellation retention", () => {
  it("does not retain requests for missing launches", async () => {
    const launches = new DuoLaunchCoordinator(
      {
        findPairedLaunch: vi.fn(() => null),
        pairedLaunch: vi.fn(() => { throw new Error("Launch not found"); }),
      } as never,
      {} as never, {} as never, {} as never,
      "/unused", () => [],
    );
    for (let index = 0; index < 8; index += 1) {
      await expect(launches.cancel(`missing-${index}`)).rejects.toThrow("Launch not found");
    }
    expect((launches as unknown as { cancellationRequests: Set<string> }).cancellationRequests.size).toBe(0);
  });
});
