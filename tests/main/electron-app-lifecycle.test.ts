import { EventEmitter } from "node:events";

import type { ElectronApplication } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";

import {
  closeElectronAppBounded,
  closeElectronFixtureBounded,
  settleOperationBounded,
} from "../e2e/support/electron-app-lifecycle";

function controlledElectronApp(options: {
  readonly settleCloseAfterKill: boolean;
}): {
  readonly app: ElectronApplication;
  readonly killed: ReturnType<typeof vi.fn>;
  closeSettled: boolean;
} {
  const process = new EventEmitter() as EventEmitter & {
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: (signal?: NodeJS.Signals) => boolean;
  };
  process.exitCode = null;
  process.signalCode = null;
  let resolveClose!: () => void;
  const close = new Promise<void>((resolve) => {
    resolveClose = resolve;
  });
  const state = {
    closeSettled: false,
  };
  const killed = vi.fn((signal?: NodeJS.Signals) => {
    process.signalCode = signal ?? "SIGTERM";
    queueMicrotask(() => {
      process.emit("exit", null, process.signalCode);
      if (options.settleCloseAfterKill) {
        queueMicrotask(() => {
          state.closeSettled = true;
          resolveClose();
        });
      }
    });
    return true;
  });
  process.kill = killed;
  return {
    app: {
      process: () => process,
      close: () => close,
    } as unknown as ElectronApplication,
    killed,
    get closeSettled() {
      return state.closeSettled;
    },
  };
}

describe("Electron E2E application lifecycle", () => {
  it("bounds an operation while safely consuming a later rejection", async () => {
    let reject!: (reason: unknown) => void;
    const operation = new Promise<void>((_resolve, rejectOperation) => {
      reject = rejectOperation;
    });
    await expect(settleOperationBounded(operation, 5)).resolves.toEqual({
      status: "timed-out",
    });
    reject(new Error("late failure"));
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  it("forces a hung app closed and lets Playwright transport cleanup settle", async () => {
    const fixture = controlledElectronApp({ settleCloseAfterKill: true });
    await closeElectronAppBounded(fixture.app, {
      gracefulTimeoutMs: 5,
      forcedExitTimeoutMs: 50,
      protocolSettleTimeoutMs: 50,
    });
    expect(fixture.killed).toHaveBeenCalledWith("SIGKILL");
    expect(fixture.closeSettled).toBe(true);
  });

  it("does not inherit a permanently unresolved Playwright close", async () => {
    const fixture = controlledElectronApp({ settleCloseAfterKill: false });
    await expect(closeElectronAppBounded(fixture.app, {
      gracefulTimeoutMs: 5,
      forcedExitTimeoutMs: 50,
      protocolSettleTimeoutMs: 5,
    })).resolves.toBeUndefined();
    expect(fixture.killed).toHaveBeenCalledWith("SIGKILL");
  });

  it("closes Electron and removes fixture data despite hung teardown steps", async () => {
    const process = Object.assign(new EventEmitter(), {
      exitCode: 0,
      signalCode: null,
      kill: vi.fn(() => true),
    });
    const close = vi.fn(async () => undefined);
    const closeServer = vi.fn(() => new Promise<void>(() => undefined));
    const removeDirectory = vi.fn(async () => undefined);
    await expect(closeElectronFixtureBounded({
      current: {
        process: () => process,
        close,
      } as unknown as ElectronApplication,
      requestRuntimeQuit: () => new Promise<number | null>(() => undefined),
      waitForRuntimeExit: vi.fn(async () => undefined),
      closeServer,
      removeDirectory,
      rpcTimeoutMs: 5,
      serverTimeoutMs: 5,
      removeTimeoutMs: 50,
    })).rejects.toThrow("The Electron fixture did not close cleanly.");
    expect(close).toHaveBeenCalledOnce();
    expect(closeServer).toHaveBeenCalledOnce();
    expect(removeDirectory).toHaveBeenCalledOnce();
  });

  it("reports a hung runtime quit after completing later cleanup", async () => {
    const process = Object.assign(new EventEmitter(), {
      exitCode: 0,
      signalCode: null,
      kill: vi.fn(() => true),
    });
    const close = vi.fn(async () => undefined);
    const closeServer = vi.fn(async () => undefined);
    const removeDirectory = vi.fn(async () => undefined);
    const result = closeElectronFixtureBounded({
      current: {
        process: () => process,
        close,
      } as unknown as ElectronApplication,
      requestRuntimeQuit: () => new Promise<number | null>(() => undefined),
      waitForRuntimeExit: vi.fn(async () => undefined),
      closeServer,
      removeDirectory,
      rpcTimeoutMs: 5,
      serverTimeoutMs: 50,
      removeTimeoutMs: 50,
    });
    const failure = await result.then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      expect.objectContaining({
        message: "The Electron fixture runtime quit request did not settle in time.",
      }),
    ]);
    expect(close).toHaveBeenCalledOnce();
    expect(closeServer).toHaveBeenCalledOnce();
    expect(removeDirectory).toHaveBeenCalledOnce();
  });
});
