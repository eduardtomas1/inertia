import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cursorSdkStateRoot, cursorSdkStatus, type CursorSdkConfiguration } from "../../src/server/provider/cursor-sdk-service";

const operations = vi.hoisted(() => ({ mkdir: vi.fn(), realpath: vi.fn(), open: vi.fn(), inspect: vi.fn(), close: vi.fn() }));
vi.mock("node:fs/promises", async (original) => ({
  ...await original<typeof import("node:fs/promises")>(), mkdir: operations.mkdir, realpath: operations.realpath,
}));
vi.mock("../../src/server/provider/cursor-sdk-process", () => ({ openCursorSdkWorker: operations.open }));

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const configuration: CursorSdkConfiguration = { stateRoot: "/fixture", credentials: {
  resolve: async () => "fixture-token", status: async () => ({ hasSecret: true, credentialGeneration: "fixture-generation" }),
} };

beforeEach(() => {
  vi.resetAllMocks();
  Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  operations.mkdir.mockResolvedValue(undefined);
  operations.realpath.mockImplementation(async (path: string) => path);
  operations.close.mockResolvedValue(undefined);
  operations.inspect.mockResolvedValue({ sdkVersion: "1.0.38", nativeStore: true, storeKind: "inertia-journal-v1" });
  operations.open.mockResolvedValue({ channel: { request: operations.inspect }, close: operations.close });
});
afterEach(() => Object.defineProperty(process, "platform", platform));

describe("Cursor SDK owned store availability", () => {
  it("requires the exact journal implementation and confirmed worker cleanup", async () => {
    expect(await cursorSdkStatus(configuration, {}, new AbortController().signal)).toEqual({
      available: true, hasCredential: true, sdkVersion: "1.0.38",
    });
    expect(operations.inspect).toHaveBeenCalledWith("inspect", null, 30_000);
    expect(operations.close).toHaveBeenCalledOnce();
  });

  it.each([undefined, "sqlite", "inertia-journal-v2"])("rejects an absent or different store identity: %s", async (storeKind) => {
    operations.inspect.mockResolvedValue({ sdkVersion: "1.0.38", nativeStore: true, storeKind });
    expect(await cursorSdkStatus(configuration, {}, new AbortController().signal)).toMatchObject({ available: false });
    expect(operations.close).toHaveBeenCalledOnce();
  });

  it.each([false, true])("preserves cleanup uncertainty for account quarantine, wrapped=%s", async (wrapped) => {
    const cause = Object.assign(new Error("fixture-private-cleanup"), { code: "process-tree-termination-unconfirmed" });
    const error = wrapped ? new Error("wrapper", { cause }) : cause;
    operations.close.mockRejectedValue(error);
    await expect(cursorSdkStatus(configuration, {}, new AbortController().signal)).rejects.toBe(error);
  });

  it.each(["darwin", "win32"])("reports unsupported storage without directory writes or worker admission on %s", async (value) => {
    Object.defineProperty(process, "platform", { ...platform, value });
    await expect(cursorSdkStateRoot(configuration)).rejects.toThrow("unavailable on this platform");
    expect(await cursorSdkStatus(configuration, {}, new AbortController().signal)).toMatchObject({
      available: false, message: "Cursor SDK requires Linux, the owned worker and external Node 22.13+.",
    });
    expect(operations.mkdir).not.toHaveBeenCalled();
    expect(operations.open).not.toHaveBeenCalled();
  });
});
