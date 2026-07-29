import { createHash } from "node:crypto";
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
  it("requests recovery before reminting authority for a missing target", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "inertia-secure-client-recovery-"),
    );
    roots.push(root);
    const content = Buffer.from("restored\n");
    const post = vi.fn<(event: RuntimeWorkerEvent) => void>();
    const client = new RuntimeSecureFileBrokerClient(post);
    const authority = await client.authorizeRoot(root);

    const pending = client.read(authority, "example.ts", 1_024);
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const recovery = post.mock.calls[0]![0];
    expect(recovery).toMatchObject({
      type: "runtime.secure-file-request",
      operation: "recover",
      path: "example.ts",
      parentIdentities: [],
    });
    if (recovery.type !== "runtime.secure-file-request") {
      throw new Error("Expected a secure-file recovery request.");
    }
    await writeFile(join(root, "example.ts"), content);
    client.handle({
      type: "runtime.secure-file-result",
      requestId: recovery.requestId,
      result: { ok: true, operation: "recover" },
    });

    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    const read = post.mock.calls[1]![0];
    expect(read).toMatchObject({
      type: "runtime.secure-file-request",
      operation: "read",
      path: "example.ts",
    });
    if (read.type !== "runtime.secure-file-request") {
      throw new Error("Expected a secure-file read request.");
    }
    client.handle({
      type: "runtime.secure-file-result",
      requestId: read.requestId,
      result: {
        ok: true,
        operation: "read",
        contentBase64: content.toString("base64"),
        metadata: {
          digest: createHash("sha256").update(content).digest("hex"),
          size: content.byteLength,
          modifiedAt: new Date(0).toISOString(),
          mode: 0o644,
        },
      },
    });

    await expect(pending).resolves.toMatchObject({ content });
    client.close();
  });

  it.skipIf(process.platform === "win32")(
    "keeps a POSIX literal backslash inside one authorized filename segment",
    async () => {
      const root = await mkdtemp(
        join(tmpdir(), "inertia-secure-client-posix-"),
      );
      roots.push(root);
      const filename = "notes\\draft.md";
      const content = Buffer.from("draft\n");
      await writeFile(join(root, filename), content);
      const post = vi.fn<(event: RuntimeWorkerEvent) => void>();
      const client = new RuntimeSecureFileBrokerClient(post);
      const authority = await client.authorizeRoot(root);

      const pending = client.read(authority, filename, 1_024);
      await vi.waitFor(() => {
        expect(post).toHaveBeenCalledTimes(1);
      });
      const request = post.mock.calls[0]![0];
      expect(request).toMatchObject({
        type: "runtime.secure-file-request",
        operation: "read",
        path: filename,
        parentIdentities: [],
      });
      if (request.type !== "runtime.secure-file-request") {
        throw new Error("Expected a secure-file request.");
      }
      client.handle({
        type: "runtime.secure-file-result",
        requestId: request.requestId,
        result: {
          ok: true,
          operation: "read",
          contentBase64: content.toString("base64"),
          metadata: {
            digest: createHash("sha256").update(content).digest("hex"),
            size: content.byteLength,
            modifiedAt: new Date(0).toISOString(),
            mode: 0o644,
          },
        },
      });
      await expect(pending).resolves.toMatchObject({ content });
      client.close();
    },
  );

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
