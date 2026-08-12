import { beforeEach, describe, expect, it, vi } from "vitest";

const filesystem = vi.hoisted(() => ({
  realpath: vi.fn(),
  stat: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
  realpath: filesystem.realpath,
  stat: filesystem.stat,
}));

import { resolveWorkspaceGitRepositoryIdentity } from "../../src/server/workspace-git";

describe("workspace Git repository cancellation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("settles cancellation while workspace realpath is stalled", async () => {
    const controller = new AbortController();
    filesystem.realpath.mockReturnValue(new Promise(() => undefined));

    const resolution = resolveWorkspaceGitRepositoryIdentity(
      "/stalled-workspace",
      ".",
      undefined,
      controller.signal,
    );
    await vi.waitFor(() => expect(filesystem.realpath).toHaveBeenCalledOnce());
    controller.abort();

    await expect(resolution).rejects.toMatchObject({
      code: "timeout",
      message: "Git inspection was cancelled.",
    });
    expect(filesystem.stat).not.toHaveBeenCalled();
  });

  it("settles cancellation while workspace stat is stalled", async () => {
    const controller = new AbortController();
    filesystem.realpath.mockResolvedValue("/stalled-workspace");
    filesystem.stat.mockReturnValue(new Promise(() => undefined));

    const resolution = resolveWorkspaceGitRepositoryIdentity(
      "/stalled-workspace",
      ".",
      undefined,
      controller.signal,
    );
    await vi.waitFor(() => expect(filesystem.stat).toHaveBeenCalledOnce());
    controller.abort();

    await expect(resolution).rejects.toMatchObject({
      code: "timeout",
      message: "Git inspection was cancelled.",
    });
  });
});
