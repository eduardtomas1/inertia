import { describe, expect, it, vi } from "vitest";
import {
  activateAfterRuntimeWorkerStartupPreflight,
  RuntimeWorkerStartupPreflightError,
} from "../../src/server/runtime-worker-startup-preflight";

describe("runtime worker startup preflight", () => {
  it("verifies the Linux guardian exactly once before registry activation", () => {
    const order: string[] = [];
    const identity = {
      guardianExecutableDevice: "10",
      guardianExecutableInode: "20",
    };
    const verifyLinuxGuardian = vi.fn(() => {
      order.push("verify");
      return identity;
    });
    const activate = vi.fn((receivedIdentity) => {
      order.push("activate");
      expect(receivedIdentity).toEqual(identity);
      return "active";
    });

    expect(activateAfterRuntimeWorkerStartupPreflight({
      platform: "linux",
      guardianPath: "/trusted/guardian",
      verifyLinuxGuardian,
    }, activate)).toBe("active");
    expect(verifyLinuxGuardian).toHaveBeenCalledOnce();
    expect(activate).toHaveBeenCalledOnce();
    expect(order).toEqual(["verify", "activate"]);
  });

  it("fails closed before registry activation when the Linux preflight fails", () => {
    const activate = vi.fn();
    let failure: unknown;
    try {
      activateAfterRuntimeWorkerStartupPreflight({
        platform: "linux",
        guardianPath: "/trusted/guardian",
        verifyLinuxGuardian: () => null,
      }, activate);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(RuntimeWorkerStartupPreflightError);
    expect(failure).toMatchObject({
      code: "linux-guardian-sandbox-selftest-failed",
    });
    expect(activate).not.toHaveBeenCalled();
  });

  it("treats a missing Linux guardian as a pre-registry failure", () => {
    const activate = vi.fn();
    expect(() => activateAfterRuntimeWorkerStartupPreflight({
      platform: "linux",
    }, activate)).toThrow(RuntimeWorkerStartupPreflightError);
    expect(activate).not.toHaveBeenCalled();
  });

  it.each([
    { platform: "darwin" as const, guardianPath: "/trusted/guardian" },
    { platform: "win32" as const, guardianPath: "/trusted/guardian" },
  ])("does not run the Linux preflight outside a configured Linux generation", (options) => {
    const verifyLinuxGuardian = vi.fn(() => null);
    const activate = vi.fn(() => "active");

    expect(activateAfterRuntimeWorkerStartupPreflight({
      ...options,
      verifyLinuxGuardian,
    }, activate)).toBe("active");
    expect(verifyLinuxGuardian).not.toHaveBeenCalled();
    expect(activate).toHaveBeenCalledOnce();
  });
});
