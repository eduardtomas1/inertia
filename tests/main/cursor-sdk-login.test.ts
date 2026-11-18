import { describe, expect, it, vi } from "vitest";
import { loginCursorSdk } from "../../src/node/cursor-sdk-login";
import type { SdkLoginOptions } from "@cursor/sdk";

describe("Cursor SDK privileged login", () => {
  function fixture() {
    return { login: vi.fn(async (_options: SdkLoginOptions) => ({ apiKey: "synthetic-test-token", apiKeyExpiresAtMs: Date.now() + 60_000 })),
      save: vi.fn(async () => ({ hasSecret: true, credentialGeneration: "generation" })), showUrl: vi.fn() };
  }
  it("disables ambient credential persistence and returns no secret", async () => {
    const dependencies = fixture();
    const result = await loginCursorSdk(dependencies, new AbortController().signal);
    expect(dependencies.login).toHaveBeenCalledWith(expect.objectContaining({ store: null, openBrowser: false }));
    expect(dependencies.save).toHaveBeenCalledWith("synthetic-test-token", expect.any(AbortSignal));
    expect(Object.keys(result)).toEqual(["expiresAt"]);
  });
  it("does not save a late login result after cancellation", async () => {
    const dependencies = fixture(); const controller = new AbortController();
    dependencies.login.mockImplementation(async () => { controller.abort(); return { apiKey: "synthetic-test-token", apiKeyExpiresAtMs: Date.now() + 60_000 }; });
    await expect(loginCursorSdk(dependencies, controller.signal)).rejects.toThrow("cancelled");
    expect(dependencies.save).not.toHaveBeenCalled();
  });
  it("rejects expired credentials", async () => {
    const dependencies = fixture(); dependencies.login.mockResolvedValue({ apiKey: "synthetic-test-token", apiKeyExpiresAtMs: 1 });
    await expect(loginCursorSdk(dependencies, new AbortController().signal)).rejects.toThrow("failed");
    expect(dependencies.save).not.toHaveBeenCalled();
  });
  it("never surfaces SDK errors containing secrets", async () => {
    const dependencies = fixture(); dependencies.login.mockRejectedValue(new Error("synthetic-test-token"));
    await expect(loginCursorSdk(dependencies, new AbortController().signal)).rejects.toThrow(/^Cursor SDK login failed\.$/u);
  });
  it("rejects untrusted login origins before showing them", async () => {
    const dependencies = fixture(); dependencies.login.mockImplementation(async (options) => {
      options.onLoginUrl!("https://untrusted.invalid/login");
      return { apiKey: "synthetic-test-token", apiKeyExpiresAtMs: Date.now() + 60_000 };
    });
    await expect(loginCursorSdk(dependencies, new AbortController().signal)).rejects.toThrow("failed");
    expect(dependencies.showUrl).not.toHaveBeenCalled(); expect(dependencies.save).not.toHaveBeenCalled();
  });
});
