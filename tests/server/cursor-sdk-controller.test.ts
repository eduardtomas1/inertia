import { beforeEach, describe, expect, it, vi } from "vitest";
import { CursorSdkController } from "../../src/server/provider/cursor-sdk-controller";

const service = vi.hoisted(() => ({ status: vi.fn(), models: vi.fn(), login: vi.fn(), installation: vi.fn() }));
vi.mock("../../src/server/provider/cursor-sdk-service", () => ({
  cursorSdkStatus: service.status, cursorSdkModels: service.models, cursorSdkLogin: service.login,
}));
vi.mock("../../src/server/provider/cursor-sdk-installation", () => ({ inspectCursorSdkInstallation: service.installation }));

beforeEach(() => {
  vi.resetAllMocks();
  service.status.mockResolvedValue({ available: true, hasCredential: true, sdkVersion: "1.0.38" });
  service.models.mockResolvedValue([{ id: "fixture-model", displayName: "Fixture model" }]);
  service.login.mockResolvedValue({ expiresAt: Date.now() + 60_000 });
  service.installation.mockReturnValue({ fingerprint: "fixture-installation" });
});

function fixture() {
  const controller = new CursorSdkController({ stateRoot: "/fixture", credentials: {
    resolve: async () => "fixture-token", status: async () => ({ hasSecret: true, credentialGeneration: "fixture-generation" }),
  } }, () => ({}));
  const signal = new AbortController().signal;
  return { controller, invoke: {
    status: () => controller.status(signal), models: () => controller.discoverModels(signal),
    login: () => controller.login(() => undefined, signal),
  } };
}

describe("Cursor SDK account cleanup quarantine", () => {
  it.each(["status", "models", "login"] as const)("invalidates launch evidence and all account admission after %s cleanup uncertainty", async (kind) => {
    const { controller, invoke } = fixture();
    await invoke.status();
    await invoke.models();
    expect(() => controller.requireModel("fixture-model")).not.toThrow();
    const error = Object.assign(new Error("fixture-private-cleanup"), { code: "process-tree-termination-unconfirmed" });
    service[kind].mockRejectedValueOnce(error);
    await expect(invoke[kind]()).rejects.toBe(error);
    const counts = [service.status, service.models, service.login].map((mock) => mock.mock.calls.length);
    expect(controller.currentInstallation()).toBeUndefined();
    controller.invalidate();
    await expect(invoke.status()).rejects.toMatchObject({ code: "process-tree-termination-unconfirmed" });
    await expect(invoke.models()).rejects.toMatchObject({ code: "process-tree-termination-unconfirmed" });
    await expect(invoke.login()).rejects.toMatchObject({ code: "process-tree-termination-unconfirmed" });
    expect([service.status, service.models, service.login].map((mock) => mock.mock.calls.length)).toEqual(counts);
    expect(() => controller.requireModel("fixture-model")).toThrow("Refresh Cursor SDK discovery");
  });

  it("allows recovery from ordinary account failures without clearing a cleanup quarantine", async () => {
    const { controller, invoke } = fixture();
    service.status.mockRejectedValueOnce(new Error("ordinary unavailable"));
    await expect(invoke.status()).rejects.toThrow("ordinary unavailable");
    await invoke.status();
    await invoke.models();
    expect(() => controller.requireModel("fixture-model")).not.toThrow();
  });
});
