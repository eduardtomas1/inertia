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
      platform: "darwin",
      dependencies: dependencies(child),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    child.emit("spawn");

    await expect(result).resolves.toBeUndefined();
    expect(child.messages).toHaveLength(2);
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
      platform: "darwin",
      dependencies: dependencies(child),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    child.emit("spawn");

    await expect(result).rejects.toThrow("result is invalid");
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
      platform: "linux",
      dependencies: injected,
    })).rejects.toThrow("runtime guardian is invalid");
    expect(child.messages).toEqual([]);
  });
});
