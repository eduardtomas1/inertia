import {
  mkdtemp,
  mkdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeWorkerEvent } from "../../src/node/runtime-process-protocol";
import { RuntimeSecureFileBrokerClient } from "../../src/server/runtime/secure-file-broker-client";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

describe("runtime secure file broker client", () => {
  it("does not remint root authority after the authorized path is replaced", async () => {
    const container = await mkdtemp(
      join(tmpdir(), "inertia-secure-client-"),
    );
    roots.push(container);
    const root = join(container, "workspace");
    const movedRoot = join(container, "workspace-moved");
    const outside = join(container, "outside");
    await mkdir(root);
    await mkdir(outside);
    await writeFile(join(root, "example.ts"), "inside\n");
    await writeFile(join(outside, "example.ts"), "outside\n");
    const post = vi.fn<(event: RuntimeWorkerEvent) => void>();
    const client = new RuntimeSecureFileBrokerClient(post);
    const authority = await client.authorizeRoot(root);

    await rename(root, movedRoot);
    await symlink(
      outside,
      root,
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(client.read(authority, "example.ts", 1_024))
      .rejects.toMatchObject({ code: "unsafe" });
    expect(post).not.toHaveBeenCalled();
    client.close();
  });
});
