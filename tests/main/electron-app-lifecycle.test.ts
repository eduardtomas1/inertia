import { EventEmitter } from "node:events";

import type { ElectronApplication } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";

import { runtimeSupervisorShutdownEnvelopeMs } from "../../src/node/runtime-shutdown-deadline";
import { privilegedShutdownEnvelopeMs } from
  "../../src/main/privileged-shutdown-deadline";
import {
  closeElectronAppBounded,
  closeElectronFixtureBounded,
  fixtureElectronGracefulTimeoutMs,
  fixtureRuntimeExitTimeoutMs,
  quitElectronAppBounded,
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
  it("covers the complete Windows runtime and Job-broker shutdown envelopes", () => {
    expect(fixtureRuntimeExitTimeoutMs("win32")).toBe(
      runtimeSupervisorShutdownEnvelopeMs("win32") + 500,
    );
    expect(fixtureElectronGracefulTimeoutMs("win32")).toBe(
      privilegedShutdownEnvelopeMs("win32") + 2_000,
    );
    expect(fixtureElectronGracefulTimeoutMs("win32")).toBeGreaterThan(
      fixtureRuntimeExitTimeoutMs("win32"),
    );
  });

  it("covers the complete Linux runtime shutdown envelope", () => {
    expect(fixtureRuntimeExitTimeoutMs("linux")).toBe(
      runtimeSupervisorShutdownEnvelopeMs("linux") + 500,
    );
    expect(fixtureElectronGracefulTimeoutMs("linux")).toBe(
      privilegedShutdownEnvelopeMs("linux") + 500,
    );
  });

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

  it("waits for native app exit before settling restart transport", async () => {
    const process = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill: vi.fn(() => true),
    });
    const close = vi.fn(async () => {
      throw new Error("Playwright disconnected after app.quit");
    });
    const requestQuit = vi.fn(async () => "quit-requested");
    const quitting = quitElectronAppBounded({
      process: () => process,
      close,
    } as unknown as ElectronApplication, requestQuit, {
      gracefulTimeoutMs: 1_000,
      protocolSettleTimeoutMs: 50,
    });

    await vi.waitFor(() => expect(requestQuit).toHaveBeenCalledOnce());
    expect(close).not.toHaveBeenCalled();
    process.exitCode = 0;
    process.emit("exit", 0, null);

    await expect(quitting).resolves.toEqual({
      outcome: "graceful",
      requestResult: { status: "fulfilled", value: "quit-requested" },
      transportSettled: true,
    });
    expect(close).toHaveBeenCalledOnce();
    expect(process.kill).not.toHaveBeenCalled();
  });

  it("reports an abnormal native exit instead of permitting restart", async () => {
    const process = Object.assign(new EventEmitter(), {
      exitCode: 1,
      signalCode: null as NodeJS.Signals | null,
      kill: vi.fn(() => true),
    });
    const close = vi.fn(async () => undefined);
    await expect(quitElectronAppBounded({
      process: () => process,
      close,
    } as unknown as ElectronApplication, async () => undefined, {
      gracefulTimeoutMs: 50,
      protocolSettleTimeoutMs: 50,
    })).resolves.toMatchObject({ outcome: "abnormal" });
    expect(close).toHaveBeenCalledOnce();
    expect(process.kill).not.toHaveBeenCalled();
  });

  it("forces a hung native quit only after its graceful deadline", async () => {
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
      const close = vi.fn(async () => undefined);
      const quitting = quitElectronAppBounded({
        process: () => process,
        close,
      } as unknown as ElectronApplication, async () => undefined, {
        gracefulTimeoutMs: 5,
        forcedExitTimeoutMs: 50,
        protocolSettleTimeoutMs: 50,
      });

      await vi.advanceTimersByTimeAsync(4);
      expect(process.kill).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      await expect(quitting).resolves.toMatchObject({ outcome: "forced" });
      expect(process.kill).toHaveBeenCalledWith("SIGKILL");
      expect(close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
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
        process.exitCode = 0;
        process.emit("exit", 0, null);
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

  it.runIf(process.platform === "darwin")(
    "accepts authoritative child exit when the advisory runtime quit RPC hangs",
    async () => {
      vi.useFakeTimers();
      try {
        const process = Object.assign(new EventEmitter(), {
          exitCode: null as number | null,
          signalCode: null as NodeJS.Signals | null,
          kill: vi.fn(() => true),
        });
        const close = vi.fn(async () => {
          throw new Error("Playwright disconnected during app.quit");
        });
        const closeServer = vi.fn(async () => undefined);
        const removeDirectory = vi.fn(async () => undefined);
        const closing = closeElectronFixtureBounded({
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

        await vi.advanceTimersByTimeAsync(5 + 12_750);
        expect(process.kill).not.toHaveBeenCalled();
        process.exitCode = 0;
        process.emit("exit", 0, null);
        await expect(closing).resolves.toBeUndefined();
        expect(process.kill).not.toHaveBeenCalled();
        expect(close).toHaveBeenCalledOnce();
        expect(closeServer).toHaveBeenCalledOnce();
        expect(removeDirectory).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("reports a hung runtime quit when no Electron child authority is available", async () => {
    const closeServer = vi.fn(async () => undefined);
    const removeDirectory = vi.fn(async () => undefined);
    const result = closeElectronFixtureBounded({
      current: {
        process: () => { throw new Error("child handle unavailable"); },
        close: vi.fn(async () => undefined),
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
      expect.objectContaining({ message: "child handle unavailable" }),
      expect.objectContaining({
        message: "The Electron fixture runtime quit request did not settle in time.",
      }),
    ]);
    expect(closeServer).toHaveBeenCalledOnce();
    expect(removeDirectory).toHaveBeenCalledOnce();
  });

  it("does not accept an abnormal child exit as privileged shutdown proof", async () => {
    const process = Object.assign(new EventEmitter(), {
      exitCode: 1,
      signalCode: null as NodeJS.Signals | null,
      kill: vi.fn(() => true),
    });
    const failure = await closeElectronFixtureBounded({
      current: {
        process: () => process,
        close: async () => { throw new Error("Playwright disconnected during crash"); },
      } as unknown as ElectronApplication,
      requestRuntimeQuit: async () => { throw new Error("runtime quit failed"); },
      waitForRuntimeExit: vi.fn(async () => undefined),
      closeServer: vi.fn(async () => undefined),
      removeDirectory: vi.fn(async () => undefined),
      serverTimeoutMs: 50,
      removeTimeoutMs: 50,
    }).then(() => null, (error: unknown) => error);

    expect(process.kill).not.toHaveBeenCalled();
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("exited abnormally during close"),
      }),
      expect.objectContaining({ message: "runtime quit failed" }),
    ]);
  });

  it("awaits a pre-captured runtime before deleting a failed fixture profile", async () => {
    const process = Object.assign(new EventEmitter(), {
      exitCode: 1,
      signalCode: null as NodeJS.Signals | null,
      kill: vi.fn(() => true),
    });
    const waitForRuntimeExit = vi.fn(async () => undefined);
    const removeDirectory = vi.fn(async () => undefined);
    const failure = await closeElectronFixtureBounded({
      current: {
        process: () => process,
        close: async () => undefined,
      } as unknown as ElectronApplication,
      priorRuntimePid: 777,
      requestRuntimeQuit: async () => {
        throw new Error("runtime quit disconnected");
      },
      waitForRuntimeExit,
      closeServer: vi.fn(async () => undefined),
      removeDirectory,
      serverTimeoutMs: 50,
      removeTimeoutMs: 50,
    }).then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect(waitForRuntimeExit).toHaveBeenCalledWith(777);
    expect(waitForRuntimeExit.mock.invocationCallOrder[0]).toBeLessThan(
      removeDirectory.mock.invocationCallOrder[0]!,
    );
  });

  it("does not accept a fulfilled close with an abnormal child exit", async () => {
    const process = Object.assign(new EventEmitter(), {
      exitCode: 1,
      signalCode: null as NodeJS.Signals | null,
      kill: vi.fn(() => true),
    });
    const failure = await closeElectronFixtureBounded({
      current: {
        process: () => process,
        close: async () => undefined,
      } as unknown as ElectronApplication,
      requestRuntimeQuit: () => new Promise<number | null>(() => undefined),
      waitForRuntimeExit: vi.fn(async () => undefined),
      closeServer: vi.fn(async () => undefined),
      removeDirectory: vi.fn(async () => undefined),
      rpcTimeoutMs: 5,
      serverTimeoutMs: 50,
      removeTimeoutMs: 50,
    }).then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("exited abnormally during close"),
      }),
      expect.objectContaining({
        message: "The Electron fixture runtime quit request did not settle in time.",
      }),
    ]);
  });

  it.runIf(process.platform === "darwin")(
    "does not treat a forced child exit as privileged shutdown proof",
    async () => {
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
        const closing = closeElectronFixtureBounded({
          current: {
            process: () => process,
            close: () => new Promise<void>(() => undefined),
          } as unknown as ElectronApplication,
          requestRuntimeQuit: async () => null,
          waitForRuntimeExit: vi.fn(async () => undefined),
          closeServer: vi.fn(async () => undefined),
          removeDirectory: vi.fn(async () => undefined),
          rpcTimeoutMs: 5,
          serverTimeoutMs: 50,
          removeTimeoutMs: 50,
        });
        const outcome = closing.then(() => null, (error: unknown) => error);

        await vi.advanceTimersByTimeAsync(
          5 + runtimeSupervisorShutdownEnvelopeMs("darwin") + 500 + 1_000,
        );
        const failure = await outcome;
        expect(process.kill).toHaveBeenCalledWith("SIGKILL");
        expect(failure).toBeInstanceOf(AggregateError);
        expect((failure as AggregateError).errors).toEqual([
          expect.objectContaining({
            message: "The Electron fixture process required forced termination during close.",
          }),
        ]);
      } finally {
        vi.useRealTimers();
      }
    },
  );

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
