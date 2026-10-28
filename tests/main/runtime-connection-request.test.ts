// @inertia-test-suite portable
import { describe, expect, it, vi } from "vitest";

import { applyRuntimeConnectionRequest } from "../../src/main/runtime-connection-request";

describe("runtime connection restart request", () => {
  it("restarts the stopped runtime only for an exact request from the main window", () => {
    const restartFromUser = vi.fn(() => true);
    applyRuntimeConnectionRequest([], "main", { restartFromUser });
    expect(restartFromUser).not.toHaveBeenCalled();
    applyRuntimeConnectionRequest([{ restart: true }], "main", { restartFromUser });
    expect(restartFromUser).toHaveBeenCalledOnce();
    applyRuntimeConnectionRequest([{ restart: true }], "main", null);
  });

  it.each([
    [[{ restart: false }]],
    [[{ restart: true, force: true }]],
    [[{}]],
    [[null]],
    [["restart"]],
    [[[true]]],
  ])("rejects the malformed request %j", (args) => {
    const restartFromUser = vi.fn(() => true);
    expect(() => applyRuntimeConnectionRequest(args, "main", { restartFromUser }))
      .toThrow("Rejected invalid runtime connection request");
    expect(restartFromUser).not.toHaveBeenCalled();
  });

  it("rejects a restart request from a detached chat window", () => {
    const restartFromUser = vi.fn(() => true);
    expect(() => applyRuntimeConnectionRequest([{ restart: true }], "detached-chat", { restartFromUser }))
      .toThrow("Rejected invalid runtime connection request");
    expect(restartFromUser).not.toHaveBeenCalled();
  });
});
