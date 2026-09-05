// @inertia-test-suite portable

import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  app: { whenReady: vi.fn(async () => undefined) },
  utilityProcess: { fork: vi.fn() },
}));
vi.mock("electron", () => electron);

import {
  appUpdateCandidateViabilityResult,
  parseAppUpdateCandidateViabilityRequest,
  parseAppUpdateCandidateViabilityResultAck,
} from "../../src/node/app-update-candidate-viability-protocol";
import {
  validateDesktopAppUpdateCandidate,
  type CandidateViabilityDependencies,
} from "../../src/main/app-update-candidate-viability";

const operationId = "11111111-1111-4111-8111-111111111111";
const expectedActiveRuntimeOwner = {
  runtimeGenerationId: "22222222-2222-4222-8222-222222222222:7",
  systemBootId: "linux:33333333-3333-4333-8333-333333333333",
} as const;

class FakeUtilityProcess extends EventEmitter {
  pid: number | undefined = 123;
  stderr = null;
  stdout = null;
  readonly messages: unknown[] = [];
  kill = vi.fn(() => {
    queueMicrotask(() => this.emit("exit", 1));
    return true;
  });
  postMessage(value: unknown): void {
    this.messages.push(value);
  }
}

function dependencies(
  child: FakeUtilityProcess,
): CandidateViabilityDependencies {
  return {
    whenReady: vi.fn(async () => undefined),
    resolveRuntimeAssets: vi.fn(() => ({
      runtimeProcessGuardianPath: null,
      windowsRuntimeJobAssembly: null,
    })),
    verifyLinuxGuardian: vi.fn() as unknown as
      CandidateViabilityDependencies["verifyLinuxGuardian"],
    spawn: () => child as unknown as ReturnType<
      CandidateViabilityDependencies["spawn"]
    >,
    validationTimeoutMs: 50,
    exitProofMs: 25,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("desktop app update candidate viability", () => {
  it("requires an exact result acknowledgement and clean utility exit", async () => {
    const child = new FakeUtilityProcess();
    child.postMessage = (value: unknown): void => {
      child.messages.push(value);
      const request = parseAppUpdateCandidateViabilityRequest(value);
      if (request) {
        child.emit("message", appUpdateCandidateViabilityResult({
          operationId: request.operationId,
          status: "validated",
        }));
        return;
      }
      const acknowledgement = parseAppUpdateCandidateViabilityResultAck(value);
      if (acknowledgement) child.emit("exit", 0);
    };

    const result = validateDesktopAppUpdateCandidate({
      operationId,
      dataDirectory: "/safe/data",
      expectedActiveRuntimeOwner,
      platform: "darwin",
      dependencies: dependencies(child),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    child.emit("spawn");

    await expect(result).resolves.toBeUndefined();
    expect(child.messages).toHaveLength(2);
    expect(parseAppUpdateCandidateViabilityRequest(child.messages[0]))
      .toMatchObject({ expectedActiveRuntimeOwner });
    expect(parseAppUpdateCandidateViabilityResultAck(
      child.messages[1],
    )?.operationId).toBe(operationId);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("propagates a bounded rejection code after the worker exits", async () => {
    const child = new FakeUtilityProcess();
    child.postMessage = (value: unknown): void => {
      child.messages.push(value);
      const request = parseAppUpdateCandidateViabilityRequest(value);
      if (request) {
        child.emit("message", appUpdateCandidateViabilityResult({
          operationId: request.operationId,
          status: "rejected",
          code: "database-incompatible",
        }));
      } else if (parseAppUpdateCandidateViabilityResultAck(value)) {
        child.emit("exit", 1);
      }
    };

    const result = validateDesktopAppUpdateCandidate({
      operationId,
      dataDirectory: "/safe/data",
      expectedActiveRuntimeOwner: null,
      platform: "darwin",
      dependencies: dependencies(child),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    child.emit("spawn");

    await expect(result).rejects.toThrow("database-incompatible");
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("kills an invalid responder and requires an observed exit", async () => {
    const child = new FakeUtilityProcess();
    child.postMessage = (value: unknown): void => {
      child.messages.push(value);
      if (parseAppUpdateCandidateViabilityRequest(value)) {
        child.emit("message", { status: "validated" });
      }
    };

    const result = validateDesktopAppUpdateCandidate({
      operationId,
      dataDirectory: "/safe/data",
      expectedActiveRuntimeOwner: null,
      platform: "darwin",
      dependencies: dependencies(child),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    child.emit("spawn");

    await expect(result).rejects.toThrow("result is invalid");
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("retains cleanup authority and retries a rejected pre-spawn kill", async () => {
    vi.useFakeTimers();
    const child = new FakeUtilityProcess();
    child.kill.mockReset();
    child.kill.mockReturnValue(false);
    const injected = {
      ...dependencies(child),
      resolveRuntimeAssets: vi.fn(() => ({
        runtimeProcessGuardianPath: "/runtime/guardian",
        windowsRuntimeJobAssembly: null,
      })),
      verifyLinuxGuardian: vi.fn(() => true) as unknown as
        CandidateViabilityDependencies["verifyLinuxGuardian"],
      validationTimeoutMs: 10,
      exitProofMs: 5,
    };
    const validation = validateDesktopAppUpdateCandidate({
      operationId,
      dataDirectory: "/safe/data",
      expectedActiveRuntimeOwner: null,
      platform: "linux",
      dependencies: injected,
    });
    const rejected = expect(validation).rejects.toThrow("exit is unconfirmed");

    await vi.advanceTimersByTimeAsync(15);
    await rejected;
    expect(child.kill).toHaveBeenCalledOnce();
    expect(() => child.emit("error", new Error("late fork failure"))).not.toThrow();
    child.emit("spawn");
    expect(child.kill).toHaveBeenCalledTimes(2);
    expect(child.messages).toEqual([]);
    expect(() => child.emit("error", new Error("late process failure"))).not.toThrow();
    child.emit("exit", 1);
    expect(child.listenerCount("error")).toBe(0);
  });

  it("does not enable late utility recovery outside Linux", async () => {
    vi.useFakeTimers();
    const child = new FakeUtilityProcess();
    child.kill.mockReset();
    child.kill.mockReturnValue(false);
    const validation = validateDesktopAppUpdateCandidate({
      operationId,
      dataDirectory: "/safe/data",
      expectedActiveRuntimeOwner: null,
      platform: "darwin",
      dependencies: {
        ...dependencies(child),
        validationTimeoutMs: 10,
        exitProofMs: 5,
      },
    });
    const rejected = expect(validation).rejects.toThrow("exit is unconfirmed");

    await vi.advanceTimersByTimeAsync(15);
    await rejected;
    expect(child.listenerCount("spawn")).toBe(0);
    expect(child.listenerCount("error")).toBe(0);
    expect(child.listenerCount("exit")).toBe(0);
    child.emit("spawn");
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("fails before spawning when the Linux guardian is not viable", async () => {
    const child = new FakeUtilityProcess();
    const injected: CandidateViabilityDependencies = {
      ...dependencies(child),
      resolveRuntimeAssets: vi.fn(() => ({
        runtimeProcessGuardianPath: "/runtime/guardian",
        windowsRuntimeJobAssembly: null,
      })),
    };

    await expect(validateDesktopAppUpdateCandidate({
      operationId,
      dataDirectory: "/safe/data",
      expectedActiveRuntimeOwner: null,
      platform: "linux",
      dependencies: injected,
    })).rejects.toThrow("runtime guardian is invalid");
    expect(child.messages).toEqual([]);
  });
});
