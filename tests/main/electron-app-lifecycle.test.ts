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

  it.runIf(process.platform === "darwin")(
    "lets Electron finish the complete macOS runtime shutdown envelope",
    async () => {
      vi.useFakeTimers();
      try {
        const process = Object.assign(new EventEmitter(), {
          exitCode: null as number | null,
          signalCode: null as NodeJS.Signals | null,
          kill: vi.fn(() => true),
        });
        let resolveClose!: () => void;
        const gracefulClose = new Promise<void>((resolve) => {
          resolveClose = resolve;
        });
        const close = closeElectronAppBounded({
          process: () => process,
          close: () => gracefulClose,
        } as unknown as ElectronApplication);

        await vi.advanceTimersByTimeAsync(12_750);
        expect(process.kill).not.toHaveBeenCalled();
        resolveClose();
        await expect(close).resolves.toBeUndefined();
        expect(process.kill).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("lets an OS child exit naturally after Playwright rejects close early", async () => {
    vi.useFakeTimers();
    try {
      const process = Object.assign(new EventEmitter(), {
        exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null,
        kill: vi.fn(() => true),
      });
      const close = closeElectronAppBounded({
        process: () => process,
        close: async () => { throw new Error("Playwright disconnected"); },
      } as unknown as ElectronApplication, { gracefulTimeoutMs: 13_000 });

      await vi.advanceTimersByTimeAsync(12_750);
      expect(process.kill).not.toHaveBeenCalled();
      process.exitCode = 0;
      process.emit("exit", 0, null);
      await expect(close).resolves.toBeUndefined();
      expect(process.kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("kills an OS child still live after an early close rejection deadline", async () => {
    vi.useFakeTimers();
    try {
      const process = Object.assign(new EventEmitter(), {
        exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null,
        kill: vi.fn((signal: NodeJS.Signals) => {
          process.signalCode = signal;
          process.emit("exit", null, signal);
          return true;
        }),
      });
      const close = closeElectronAppBounded({
        process: () => process,
        close: async () => { throw new Error("Playwright disconnected"); },
      } as unknown as ElectronApplication, {
        gracefulTimeoutMs: 13_000,
        forcedExitTimeoutMs: 100,
      });

      await vi.advanceTimersByTimeAsync(12_999);
      expect(process.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await expect(close).resolves.toBeUndefined();
      expect(process.kill).toHaveBeenCalledWith("SIGKILL");
    } finally {
      vi.useRealTimers();
    }
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

  it("retains the child handle before runtime quit disconnects Playwright", async () => {
    const process = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill: vi.fn(() => true),
    });
    let disconnected = false;
    const processHandle = vi.fn(() => {
      if (disconnected) {
        throw new TypeError("Cannot read properties of undefined (reading '_object')");
      }
      return process;
    });
    const close = vi.fn(async () => {
      if (disconnected) throw new Error("Electron application closed");
    });
    const closeServer = vi.fn(async () => undefined);
    const removeDirectory = vi.fn(async () => undefined);
    await expect(closeElectronFixtureBounded({
      current: {
        process: processHandle,
        close,
      } as unknown as ElectronApplication,
      requestRuntimeQuit: async () => {
        disconnected = true;
        process.exitCode = 0;
        process.emit("exit", 0, null);
        return null;
      },
      waitForRuntimeExit: vi.fn(async () => undefined),
      closeServer,
      removeDirectory,
      rpcTimeoutMs: 50,
      serverTimeoutMs: 50,
      removeTimeoutMs: 50,
    })).resolves.toBeUndefined();
    expect(processHandle).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(closeServer).toHaveBeenCalledOnce();
    expect(removeDirectory).toHaveBeenCalledOnce();
  });
});
