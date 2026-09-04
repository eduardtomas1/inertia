import { describe, expect, it, vi } from "vitest";

import { handleStartupFailure } from "../../src/main/startup-failure.js";

function dependencies(nodeEnvironment: string | undefined) {
  return {
    environment: nodeEnvironment === undefined
      ? {}
      : { NODE_ENV: nodeEnvironment },
    recordDiagnostic: vi.fn(),
    logFailure: vi.fn(),
    showErrorBox: vi.fn(),
    quit: vi.fn(),
  };
}

describe("desktop startup failure", () => {
  it("suppresses only the native dialog in automated Electron runs", () => {
    const actions = dependencies("test");
    const failure = new Error("fixture runtime unavailable");

    handleStartupFailure(failure, actions);

    expect(actions.recordDiagnostic).toHaveBeenCalledWith(
      "fixture runtime unavailable",
    );
    expect(actions.logFailure).toHaveBeenCalledWith(failure);
    expect(actions.showErrorBox).not.toHaveBeenCalled();
    expect(actions.quit).toHaveBeenCalledOnce();
  });

  it.each([undefined, "development", "production"])(
    "keeps the production dialog and shutdown behavior for NODE_ENV=%s",
    (nodeEnvironment) => {
      const actions = dependencies(nodeEnvironment);
      const failure = { reason: "unknown startup failure" };

      handleStartupFailure(failure, actions);

      expect(actions.recordDiagnostic).toHaveBeenCalledWith(
        "Inertia could not start.",
      );
      expect(actions.logFailure).toHaveBeenCalledWith(failure);
      expect(actions.showErrorBox).toHaveBeenCalledWith(
        "Inertia could not start",
        "The local workspace runtime failed to start. Please reopen Inertia and try again.",
      );
      expect(actions.quit).toHaveBeenCalledOnce();
    },
  );

  it.each(["diagnostic", "log", "dialog"] as const)(
    "continues reporting and always quits when %s reporting throws",
    (failurePoint) => {
      const actions = dependencies("production");
      const failure = new Error("runtime unavailable");
      if (failurePoint === "diagnostic") {
        actions.recordDiagnostic.mockImplementation(() => {
          throw new Error("diagnostic unavailable");
        });
      } else if (failurePoint === "log") {
        actions.logFailure.mockImplementation(() => {
          throw new Error("console unavailable");
        });
      } else {
        actions.showErrorBox.mockImplementation(() => {
          throw new Error("dialog unavailable");
        });
      }

      expect(() => handleStartupFailure(failure, actions)).not.toThrow();

      expect(actions.recordDiagnostic).toHaveBeenCalledWith(
        "runtime unavailable",
      );
      expect(actions.logFailure).toHaveBeenCalledWith(failure);
      expect(actions.showErrorBox).toHaveBeenCalledWith(
        "Inertia could not start",
        "The local workspace runtime failed to start. Please reopen Inertia and try again.",
      );
      expect(actions.quit).toHaveBeenCalledOnce();
    },
  );

  it("still quits when every best-effort production action fails", () => {
    const actions = dependencies("production");
    actions.recordDiagnostic.mockImplementation(() => {
      throw new Error("diagnostic unavailable");
    });
    actions.logFailure.mockImplementation(() => {
      throw new Error("console unavailable");
    });
    actions.showErrorBox.mockImplementation(() => {
      throw new Error("dialog unavailable");
    });

    expect(() => handleStartupFailure(new Error("startup failed"), actions))
      .not.toThrow();

    expect(actions.recordDiagnostic).toHaveBeenCalledOnce();
    expect(actions.logFailure).toHaveBeenCalledOnce();
    expect(actions.showErrorBox).toHaveBeenCalledOnce();
    expect(actions.quit).toHaveBeenCalledOnce();
  });
});
