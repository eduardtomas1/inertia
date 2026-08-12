import type { BigIntStats } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

const filesystem = vi.hoisted(() => ({
  lstat: vi.fn(),
  realpath: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
  lstat: filesystem.lstat,
  realpath: filesystem.realpath,
}));

import { RuntimeSecureFileBrokerClient } from "../../src/server/runtime/secure-file-broker-client";

const rootInfo = {
  dev: 1n,
  ino: 2n,
  birthtimeNs: 3n,
  isDirectory: () => true,
  isFile: () => false,
  isSymbolicLink: () => false,
} as unknown as BigIntStats;
const rootCapability = {
  root: "/stalled-workspace",
  identity: { dev: "1", ino: "2" },
  birthtimeNs: "3",
};

describe("secure file broker cancellation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("settles cancellation while root realpath is stalled", async () => {
    const controller = new AbortController();
    const inspectRoot = vi.fn<() => Promise<BigIntStats>>();
    filesystem.realpath.mockReturnValue(new Promise(() => undefined));
    const client = new RuntimeSecureFileBrokerClient(
      vi.fn(),
      20_000,
      inspectRoot,
    );

    const authorization = client.authorizeRoot(
      "/stalled-workspace",
      controller.signal,
    );
    await vi.waitFor(() => expect(filesystem.realpath).toHaveBeenCalledOnce());
    controller.abort();

    await expect(authorization).rejects.toMatchObject({
      code: "unavailable",
      message: "The secure file operation was cancelled.",
    });
    expect(inspectRoot).not.toHaveBeenCalled();
    client.close();
  });

  it("settles read cancellation while root identity verification is stalled", async () => {
    const controller = new AbortController();
    const post = vi.fn();
    const inspectRoot = vi.fn(
      () => new Promise<BigIntStats>(() => undefined),
    );
    const client = new RuntimeSecureFileBrokerClient(
      post,
      20_000,
      inspectRoot,
    );

    const read = client.read(
      rootCapability,
      "example.ts",
      1_024,
      controller.signal,
    );
    await vi.waitFor(() => expect(inspectRoot).toHaveBeenCalledOnce());
    controller.abort();

    await expect(read).rejects.toMatchObject({
      code: "unavailable",
      message: "The secure file operation was cancelled.",
    });
    expect(filesystem.lstat).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    client.close();
  });

  it("settles cancellation while an authorized parent identity is stalled", async () => {
    const controller = new AbortController();
    const post = vi.fn();
    const inspectRoot = vi.fn(async () => rootInfo);
    filesystem.lstat.mockReturnValue(new Promise(() => undefined));
    const client = new RuntimeSecureFileBrokerClient(
      post,
      20_000,
      inspectRoot,
    );

    const read = client.read(
      rootCapability,
      "nested/example.ts",
      1_024,
      controller.signal,
    );
    await vi.waitFor(() => expect(filesystem.lstat).toHaveBeenCalledOnce());
    controller.abort();

    await expect(read).rejects.toMatchObject({
      code: "unavailable",
      message: "The secure file operation was cancelled.",
    });
    expect(post).not.toHaveBeenCalled();
    client.close();
  });
});
