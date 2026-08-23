import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AttachmentRegistry,
  cleanupOrphanedAttachments,
  createAttachmentStorageSession,
  removeAttachmentStorageSession,
  type AttachmentRegistryLimits,
} from "../../src/main/attachment-registry";
import {
  validateAttachmentImportFile,
  type AttachmentImportValidationRunner,
} from "../../src/main/attachment-import-file";

const directories: string[] = [];
const handoffId = "22222222-2222-4222-8222-222222222222";
const retryHandoffId = "33333333-3333-4333-8333-333333333333";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAABHNCSVQICAgIfAhkiAAAAAFzUkdCAK7OHOkAAAANSURBVAiZY2BgYPgPAAEEAQB9ssjfAAAAAElFTkSuQmCC",
  "base64",
);
const alternatePng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAABHNCSVQICAgIfAhkiAAAAAFzUkdCAK7OHOkAAAANSURBVAiZY/j///9/AAn7A/0I0egeAAAAAElFTkSuQmCC",
  "base64",
);
const sameSizeReplacementPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAABHNCSVQICAgIfAhkiAAAAAFzUkdCAK7OHOkAAAANSURBVAiZY/jPwPAfAAUAAf+rzjaJAAAAAElFTkSuQmCC",
  "base64",
);

async function registry(
  limits?: AttachmentRegistryLimits,
  unlinkFile?: (path: string) => Promise<void>,
  waitForRetry?: (delayMs: number) => Promise<void>,
): Promise<{
  directory: string;
  registry: AttachmentRegistry;
}> {
  const directory = await mkdtemp(join(tmpdir(), "inertia-attachment-registry-"));
  directories.push(directory);
  return {
    directory,
    registry: new AttachmentRegistry(
      directory,
      limits,
      unlinkFile,
      waitForRetry,
    ),
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("main-owned attachment registry", () => {
  it("uses an unpredictable private session directory and removes it cleanly", async () => {
    const parent = await mkdtemp(join(tmpdir(), "inertia-attachment-storage-"));
    directories.push(parent);
    const root = join(parent, "attachments");
    const storage = await createAttachmentStorageSession(root);

    expect(dirname(storage.directory)).toBe(await realpath(root));
    expect(basename(storage.directory)).toMatch(/^session-[A-Za-z0-9_-]{6}$/u);
    expect(storage.reservation).toEqual({ records: 0, bytes: 0 });
    if (process.platform !== "win32") {
      expect((await lstat(root)).mode & 0o777).toBe(0o700);
      expect((await lstat(storage.directory)).mode & 0o777).toBe(0o700);
    }
    if (typeof process.getuid === "function") {
      expect((await lstat(storage.directory)).uid).toBe(process.getuid());
    }

    const attachments = new AttachmentRegistry(storage.directory);
    await attachments.import([{
      name: "private.png",
      mimeType: "image/png",
      data: png,
    }]);
    await attachments.dispose();
    await removeAttachmentStorageSession(storage.directory);
    await expect(removeAttachmentStorageSession(storage.directory))
      .resolves.toBeUndefined();
    await expect(readdir(root)).resolves.toEqual([]);
  });

  it("rejects a pre-created symbolic-link storage root", async () => {
    const parent = await mkdtemp(join(tmpdir(), "inertia-attachment-storage-"));
    directories.push(parent);
    const outside = join(parent, "outside");
    const root = join(parent, "attachments");
    await mkdir(outside);
    await symlink(
      outside,
      root,
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(createAttachmentStorageSession(root)).rejects.toThrow(
      /safe directory/u,
    );
    await expect(readdir(outside)).resolves.toEqual([]);
  });

  it.skipIf(process.platform === "win32")(
    "repairs an owned storage root to private permissions before use",
    async () => {
      const parent = await mkdtemp(
        join(tmpdir(), "inertia-attachment-storage-"),
      );
      directories.push(parent);
      const root = join(parent, "attachments");
      await mkdir(root);
      await chmod(root, 0o777);

      const storage = await createAttachmentStorageSession(root);

      expect((await lstat(root)).mode & 0o777).toBe(0o700);
      expect((await lstat(storage.directory)).mode & 0o777).toBe(0o700);
      await removeAttachmentStorageSession(storage.directory);
    },
  );

  it.skipIf(process.platform === "win32")(
    "pins the inspected directory before repairing its permissions",
    async () => {
      const parent = await mkdtemp(
        join(tmpdir(), "inertia-attachment-storage-"),
      );
      directories.push(parent);
      const root = join(parent, "attachments");
      const displaced = join(parent, "displaced-attachments");
      const outside = join(parent, "outside");
      await Promise.all([
        mkdir(root),
        mkdir(outside),
      ]);
      await Promise.all([
        chmod(root, 0o777),
        chmod(outside, 0o777),
      ]);
      let swapped = false;

      await expect(createAttachmentStorageSession(root, {
        chmodDirectory: async (directory, mode) => {
          if (!swapped) {
            swapped = true;
            await rename(root, displaced);
            await symlink(outside, root, "dir");
          }
          await directory.chmod(mode);
        },
      })).rejects.toThrow(/could not be secured/u);

      expect(swapped).toBe(true);
      expect((await lstat(displaced)).mode & 0o777).toBe(0o700);
      expect((await lstat(outside)).mode & 0o777).toBe(0o777);
    },
  );

  it("cleans a prior private session before creating the next one", async () => {
    const parent = await mkdtemp(join(tmpdir(), "inertia-attachment-storage-"));
    directories.push(parent);
    const root = join(parent, "attachments");
    const previous = await createAttachmentStorageSession(root);
    const attachments = new AttachmentRegistry(previous.directory);
    const [attachment] = await attachments.import([{
      name: "orphan.png",
      mimeType: "image/png",
      data: png,
    }]);
    const attachmentPath = (await attachments.resolve(attachment!.id))!.path;

    const current = await createAttachmentStorageSession(root);

    await expect(lstat(attachmentPath)).rejects.toThrow();
    await expect(lstat(previous.directory)).rejects.toThrow();
    expect(current.reservation).toEqual({ records: 0, bytes: 0 });
    await removeAttachmentStorageSession(current.directory);
  });

  it("materializes an opaque capability and revalidates its exact bytes", async () => {
    const { directory, registry: attachments } = await registry();
    const [imported] = await attachments.import([{
      name: "preview.png",
      mimeType: "image/png",
      data: png,
    }]);

    expect(imported).toMatchObject({
      name: "preview.png",
      mimeType: "image/png",
      size: png.length,
    });
    expect(imported?.id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(imported?.path).toBe(imported?.id);
    expect(imported?.path).not.toContain(directory);
    const resolved = await attachments.resolve(imported!.id);
    expect(resolved).toMatchObject({
      id: imported!.id,
      name: imported!.name,
      mimeType: imported!.mimeType,
      size: imported!.size,
    });
    expect(resolved?.digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(await readFile(resolved!.path)).toEqual(png);
    await expect(attachments.preview(imported!.id)).resolves.toMatchObject({
      bytes: png,
      mimeType: "image/png",
      size: png.length,
    });
  });

  it("rejects content or metadata that changed after privileged import", async () => {
    const { registry: attachments } = await registry();
    const [imported] = await attachments.import([{
      name: "preview.png",
      mimeType: "image/png",
      data: png,
    }]);
    const importedPath = (await attachments.resolve(imported!.id))!.path;
    await writeFile(importedPath, Buffer.from("tampered", "utf8"));

    await expect(attachments.resolve(imported!.id)).rejects.toThrow(
      /changed|metadata|content/u,
    );
  });

  it("rejects same-size image replacement when obtaining preview bytes", async () => {
    const { registry: attachments } = await registry();
    const [imported] = await attachments.import([{
      name: "preview.png",
      mimeType: "image/png",
      data: alternatePng,
    }]);
    const importedPath = (await attachments.resolve(imported!.id))!.path;

    await writeFile(importedPath, sameSizeReplacementPng);

    await expect(attachments.preview(imported!.id)).rejects.toThrow(
      /metadata|content/u,
    );
  });

  it("releases unsent capabilities and their private copies", async () => {
    const { registry: attachments } = await registry();
    const [imported] = await attachments.import([{
      name: "preview.png",
      mimeType: "image/png",
      data: png,
    }]);
    const importedPath = (await attachments.resolve(imported!.id))!.path;

    await expect(attachments.release(imported!.id)).resolves.toBe(true);
    await expect(attachments.release(imported!.id)).resolves.toBe(false);
    await expect(attachments.resolve(imported!.id)).resolves.toBeNull();
    await expect(readFile(importedPath)).rejects.toThrow();
  });

  it("lets a submitted attachment resolve across a racing renderer release", async () => {
    const { registry: attachments } = await registry();
    const [imported] = await attachments.import([{
      name: "submitted.png",
      mimeType: "image/png",
      data: png,
    }]);

    await attachments.prepareHandoff(handoffId, [imported!.id], () => false);
    const rendererRelease = attachments.releaseFromRenderer(imported!.id);
    await expect(attachments.resolveForRuntime(
      imported!.id,
      handoffId,
    )).resolves.toMatchObject({
      id: imported!.id,
      name: "submitted.png",
    });
    await expect(rendererRelease).resolves.toBe(false);
    await expect(attachments.preview(imported!.id)).resolves.toMatchObject({
      bytes: png,
      mimeType: "image/png",
    });
    await expect(attachments.release(imported!.id)).resolves.toBe(true);
  });

  it("does not expire a prepared send at the former renderer grace boundary", async () => {
    vi.useFakeTimers();
    try {
      const { registry: attachments } = await registry();
      const [imported] = await attachments.import([{
        name: "delayed-send.png",
        mimeType: "image/png",
        data: png,
      }]);
      const importedPath = (await attachments.resolve(imported!.id))!.path;

      await attachments.prepareHandoff(handoffId, [imported!.id], () => false);
      const rendererRelease = attachments.releaseFromRenderer(imported!.id);
      await vi.advanceTimersByTimeAsync(250);
      await expect(readFile(importedPath)).resolves.toEqual(png);
      await vi.advanceTimersByTimeAsync(9_750);

      await expect(attachments.resolveForRuntime(
        imported!.id,
        handoffId,
      )).resolves.toMatchObject({ id: imported!.id });
      await expect(rendererRelease).resolves.toBe(false);
      await expect(attachments.release(imported!.id)).resolves.toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds an abandoned handoff only after the full send timeout window", async () => {
    vi.useFakeTimers();
    try {
      const { registry: attachments } = await registry();
      const [imported] = await attachments.import([{
        name: "abandoned-send.png",
        mimeType: "image/png",
        data: png,
      }]);
      const importedPath = (await attachments.resolve(imported!.id))!.path;

      await attachments.prepareHandoff(handoffId, [imported!.id], () => false);
      const rendererRelease = attachments.releaseFromRenderer(imported!.id);
      await vi.advanceTimersByTimeAsync(209_999);
      await expect(readFile(importedPath)).resolves.toEqual(png);
      await vi.advanceTimersByTimeAsync(1);

      await expect(rendererRelease).resolves.toBe(true);
      await expect(readFile(importedPath)).rejects.toThrow();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("supersedes an unconsumed ambiguous handoff for an explicit retry", async () => {
    vi.useFakeTimers();
    try {
      const { registry: attachments } = await registry();
      const [imported] = await attachments.import([{
        name: "retry.png",
        mimeType: "image/png",
        data: png,
      }]);

      await attachments.prepareHandoff(handoffId, [imported!.id], () => false);
      expect(vi.getTimerCount()).toBe(1);
      await attachments.prepareHandoff(
        retryHandoffId,
        [imported!.id],
        () => false,
      );
      expect(vi.getTimerCount()).toBe(1);

      await expect(attachments.resolveForRuntime(
        imported!.id,
        handoffId,
      )).resolves.toBeNull();
      await expect(attachments.resolveForRuntime(
        imported!.id,
        retryHandoffId,
      )).resolves.toMatchObject({ id: imported!.id });
      expect(vi.getTimerCount()).toBe(0);
      await expect(attachments.release(imported!.id)).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retires an entire old handoff when a subset is released and retried", async () => {
    const { registry: attachments } = await registry();
    const [first, second] = await attachments.import([{
      name: "retry.png",
      mimeType: "image/png",
      data: png,
    }, {
      name: "discarded.png",
      mimeType: "image/png",
      data: alternatePng,
    }]);

    await attachments.prepareHandoff(
      handoffId,
      [first!.id, second!.id],
      () => false,
    );
    const secondRelease = attachments.releaseFromRenderer(second!.id);
    await attachments.prepareHandoff(retryHandoffId, [first!.id], () => false);
    await expect(secondRelease).resolves.toBe(true);

    await expect(attachments.resolveForRuntime(
      first!.id,
      handoffId,
    )).resolves.toBeNull();
    await expect(attachments.resolveForRuntime(
      second!.id,
      handoffId,
    )).resolves.toBeNull();
    await expect(attachments.resolveForRuntime(
      first!.id,
      retryHandoffId,
    )).resolves.toMatchObject({ id: first!.id });
    await expect(attachments.resolve(second!.id)).resolves.toBeNull();
    await expect(attachments.release(first!.id)).resolves.toBe(true);
  });

  it("rejects a retry while the runtime owns the earlier send", async () => {
    const { registry: attachments } = await registry();
    const [imported] = await attachments.import([{
      name: "already-claimed.png",
      mimeType: "image/png",
      data: png,
    }]);

    await attachments.prepareHandoff(handoffId, [imported!.id], () => false);
    await expect(attachments.resolveForRuntime(
      imported!.id,
      handoffId,
    )).resolves.toMatchObject({ id: imported!.id });

    await expect(attachments.prepareHandoff(
      retryHandoffId,
      [imported!.id],
      (id) => id === imported!.id,
    )).rejects.toThrow("Attachment handoff is unavailable.");
    await expect(attachments.resolve(imported!.id)).resolves.toMatchObject({
      id: imported!.id,
    });
    await expect(attachments.release(imported!.id)).resolves.toBe(true);
  });

  it("does not supersede another claimed member of the old handoff", async () => {
    const { registry: attachments } = await registry();
    const [first, second] = await attachments.import([{
      name: "retry.png",
      mimeType: "image/png",
      data: png,
    }, {
      name: "claimed.png",
      mimeType: "image/png",
      data: alternatePng,
    }]);

    await attachments.prepareHandoff(
      handoffId,
      [first!.id, second!.id],
      () => false,
    );
    await expect(attachments.prepareHandoff(
      retryHandoffId,
      [first!.id],
      (id) => id === second!.id,
    )).rejects.toThrow("Attachment handoff is unavailable.");

    await expect(attachments.resolveForRuntime(
      first!.id,
      handoffId,
    )).resolves.toMatchObject({ id: first!.id });
    await expect(attachments.resolveForRuntime(
      second!.id,
      handoffId,
    )).resolves.toMatchObject({ id: second!.id });
    await Promise.all([
      attachments.release(first!.id),
      attachments.release(second!.id),
    ]);
  });

  it("finishes an unused handoff into its pending renderer deletion", async () => {
    const { registry: attachments } = await registry();
    const [imported] = await attachments.import([{
      name: "abandoned-send.png",
      mimeType: "image/png",
      data: png,
    }]);

    await attachments.prepareHandoff(handoffId, [imported!.id], () => false);
    const rendererRelease = attachments.releaseFromRenderer(imported!.id);
    attachments.finishHandoff(handoffId);

    await expect(rendererRelease).resolves.toBe(true);
    await expect(attachments.resolve(imported!.id)).resolves.toBeNull();
  });

  it("cannot revive a renderer deletion after unlink has started", async () => {
    let finishUnlink!: () => void;
    const unlinkFile = vi.fn<(path: string) => Promise<void>>(
      () => new Promise<void>((resolveUnlink) => {
        finishUnlink = resolveUnlink;
      }),
    );
    const { registry: attachments } = await registry(undefined, unlinkFile);
    const [imported] = await attachments.import([{
      name: "deleting.png",
      mimeType: "image/png",
      data: png,
    }]);

    await attachments.prepareHandoff(handoffId, [imported!.id], () => false);
    const rendererRelease = attachments.releaseFromRenderer(imported!.id);
    attachments.finishHandoff(handoffId);
    await expect(attachments.prepareHandoff(
      retryHandoffId,
      [imported!.id],
      () => false,
    )).rejects.toThrow("Attachment handoff is unavailable.");
    await expect(attachments.resolveForRuntime(
      imported!.id,
      handoffId,
    )).resolves.toBeNull();
    finishUnlink();

    await expect(rendererRelease).resolves.toBe(true);
  });

  it("disposes every live capability and its private file", async () => {
    const { directory, registry: attachments } = await registry();
    await attachments.import([
      {
        name: "first.png",
        mimeType: "image/png",
        data: png,
      },
      {
        name: "second.png",
        mimeType: "image/png",
        data: alternatePng,
      },
    ]);

    const firstDisposal = attachments.dispose();
    const secondDisposal = attachments.dispose();
    expect(secondDisposal).toBe(firstDisposal);
    await Promise.all([firstDisposal, secondDisposal]);

    await expect(readdir(directory)).resolves.toEqual([]);
    await expect(attachments.import([{
      name: "later.png",
      mimeType: "image/png",
      data: png,
    }])).rejects.toThrow(/no longer available/u);
  });

  it("removes the current staged file after a partial writer failure", async () => {
    const { directory, registry: attachments } = await registry();

    await expect(attachments.importFromWriter({
      name: "partial.png",
      mimeType: "image/png",
      size: png.length,
      write: async (destination) => {
        await destination.write(png.subarray(0, 12));
        throw new Error("synthetic staged write failure");
      },
    })).rejects.toThrow("synthetic staged write failure");

    await expect(readdir(directory)).resolves.toEqual([]);
    expect(attachments.usage()).toEqual({ records: 0, bytes: 0 });
  });

  it("accounts for a staged file when partial-failure cleanup is blocked", async () => {
    const persistentError = Object.assign(
      new Error("file remains locked"),
      { code: "EPERM" },
    );
    const unlinkFile = vi.fn<(path: string) => Promise<void>>()
      .mockRejectedValue(persistentError);
    const { directory, registry: attachments } = await registry({
      maxRecords: 1,
      maxBytes: png.length,
    }, unlinkFile, async () => undefined);

    await expect(attachments.importFromWriter({
      name: "stranded.png",
      mimeType: "image/png",
      size: png.length,
      write: async (destination) => {
        await destination.write(png.subarray(0, 12));
        throw new Error("synthetic staged write failure");
      },
    })).rejects.toThrow("synthetic staged write failure");

    expect(unlinkFile).toHaveBeenCalledTimes(3);
    await expect(readdir(directory)).resolves.toHaveLength(1);
    expect(attachments.usage()).toEqual({
      records: 1,
      bytes: png.length,
    });
    await expect(attachments.import([{
      name: "blocked-by-stranded-file.png",
      mimeType: "image/png",
      data: png,
    }])).rejects.toThrow(/storage is full/u);
    await attachments.dispose();
    await expect(readdir(directory)).resolves.toEqual([]);
  });

  it("cancels validation and removes its unpublished staged file", async () => {
    const { directory, registry: attachments } = await registry({
      validationDelayMs: 5_000,
    });
    const controller = new AbortController();
    const importing = attachments.importFromWriter({
      name: "cancelled.png",
      mimeType: "image/png",
      size: png.length,
      write: async (destination) => {
        await destination.writeFile(png);
      },
    }, controller.signal);
    await vi.waitFor(async () => {
      expect(await readdir(directory)).toHaveLength(1);
    });
    controller.abort();

    await expect(importing).rejects.toThrow(/abort/u);
    await expect(readdir(directory)).resolves.toEqual([]);
    expect(attachments.usage()).toEqual({ records: 0, bytes: 0 });
  });

  it("rejects a staged inode changed before the worker's exact exit", async () => {
    expect(sameSizeReplacementPng).toHaveLength(png.length);
    const validationRunner: AttachmentImportValidationRunner = (
      operation,
      signal,
    ) => {
      const result = validateAttachmentImportFile(operation, { signal });
      return {
        result,
        stopped: result.then(async () => {
          await writeFile(
            join(operation.root, operation.fileName),
            sameSizeReplacementPng,
            { mode: 0o600 },
          );
        }),
      };
    };
    const { directory, registry: attachments } = await registry({
      validationRunner,
    });

    await expect(attachments.import([{
      name: "changed-before-exit.png",
      mimeType: "image/png",
      data: png,
    }])).rejects.toThrow(/could not be verified safely/u);

    await expect(readdir(directory)).resolves.toEqual([]);
    expect(attachments.usage()).toEqual({ records: 0, bytes: 0 });
  });

  it("removes prior-process orphans before a new registry starts", async () => {
    const { directory, registry: previousProcess } = await registry({
      maxRecords: 1,
      maxBytes: png.length,
    });
    const [orphan] = await previousProcess.import([{
      name: "orphan.png",
      mimeType: "image/png",
      data: png,
    }]);
    const orphanPath = (await previousProcess.resolve(orphan!.id))!.path;
    await writeFile(join(directory, "keep-me.txt"), "unrelated");

    await cleanupOrphanedAttachments(directory);

    await expect(readFile(orphanPath)).rejects.toThrow();
    await expect(readFile(join(directory, "keep-me.txt"), "utf8"))
      .resolves.toBe("unrelated");
    const restarted = new AttachmentRegistry(directory, {
      maxRecords: 1,
      maxBytes: png.length,
    });
    await expect(restarted.import([{
      name: "new.png",
      mimeType: "image/png",
      data: png,
    }])).resolves.toHaveLength(1);
  });

  it.skipIf(process.platform === "win32")(
    "removes an orphan symlink session without touching its target",
    async () => {
      const parent = await mkdtemp(join(tmpdir(), "inertia-attachment-storage-"));
      directories.push(parent);
      const root = join(parent, "attachments");
      const previous = join(root, "session-Abc123");
      const outside = join(parent, "outside-attachment.txt");
      const link = join(
        previous,
        "00000000-0000-4000-8000-000000000000.txt",
      );
      await mkdir(previous, { recursive: true });
      await writeFile(outside, "outside");
      await symlink(outside, link);

      const storage = await createAttachmentStorageSession(root);

      expect(storage.reservation).toEqual({ records: 0, bytes: 0 });
      await expect(lstat(link)).rejects.toThrow();
      await expect(lstat(previous)).rejects.toThrow();
      await expect(readFile(outside, "utf8")).resolves.toBe("outside");
      await removeAttachmentStorageSession(storage.directory);
    },
  );

  it.skipIf(process.platform === "win32")(
    "preserves an orphan symlink session and reserves full capacity",
    async () => {
      const parent = await mkdtemp(join(tmpdir(), "inertia-attachment-storage-"));
      directories.push(parent);
      const root = join(parent, "attachments");
      const previous = join(root, "session-Abc123");
      const outside = join(parent, "retained-attachment.txt");
      const link = join(
        previous,
        "00000000-0000-4000-8000-000000000000.txt",
      );
      await mkdir(previous, { recursive: true });
      await writeFile(outside, "retained");
      await symlink(outside, link);

      const storage = await createAttachmentStorageSession(root, {
        preserveExisting: true,
      });

      expect(storage.reservation).toEqual({
        records: 256,
        bytes: 512 * 1024 * 1024,
      });
      expect((await lstat(link)).isSymbolicLink()).toBe(true);
      expect((await lstat(previous)).isDirectory()).toBe(true);
      await expect(readFile(outside, "utf8")).resolves.toBe("retained");
      await removeAttachmentStorageSession(storage.directory);
    },
  );

  it("reserves full capacity while an unconfirmed prior session can still grow", async () => {
    const parent = await mkdtemp(join(tmpdir(), "inertia-attachment-storage-"));
    directories.push(parent);
    const root = join(parent, "attachments");
    const previous = join(root, "session-Abc123");
    const owned = join(
      previous,
      "00000000-0000-4000-8000-000000000000.png",
    );
    const foreign = join(previous, "foreign-entry.bin");
    await mkdir(previous, { recursive: true });
    await writeFile(owned, png);
    await writeFile(foreign, "prior-runtime-owned");

    const storage = await createAttachmentStorageSession(root, {
      preserveExisting: true,
    });
    await writeFile(owned, Buffer.alloc(1_024 * 1_024));

    expect(storage.reservation).toEqual({
      records: 256,
      bytes: 512 * 1024 * 1024,
    });
    const registry = new AttachmentRegistry(storage.directory, {
      reservedRecords: storage.reservation.records,
      reservedBytes: storage.reservation.bytes,
    });
    await expect(registry.import([{
      name: "must-wait-for-confirmed-cleanup.png",
      mimeType: "image/png",
      data: png,
    }])).rejects.toThrow(/storage is full/u);
    await expect(readFile(foreign, "utf8")).resolves.toBe("prior-runtime-owned");
  });

  it("retries transient startup orphan deletion before reserving capacity", async () => {
    const { directory, registry: previousProcess } = await registry();
    const [orphan] = await previousProcess.import([{
      name: "transient-orphan.png",
      mimeType: "image/png",
      data: png,
    }]);
    const orphanPath = (await previousProcess.resolve(orphan!.id))!.path;
    const waits: number[] = [];
    const unlinkFile = vi.fn<(path: string) => Promise<void>>()
      .mockRejectedValueOnce(Object.assign(new Error("locked"), {
        code: "EPERM",
      }))
      .mockRejectedValueOnce(Object.assign(new Error("busy"), {
        code: "EBUSY",
      }))
      .mockImplementation(async (path) => {
        await rm(path, { force: true });
      });

    await expect(cleanupOrphanedAttachments(directory, {
      unlinkFile,
      waitForRetry: async (delayMs) => {
        waits.push(delayMs);
      },
    })).resolves.toEqual({ records: 0, bytes: 0 });
    expect(unlinkFile).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([25, 50]);
    await expect(readFile(orphanPath)).rejects.toThrow();
  });

  it("reserves capacity for persistently locked startup orphans", async () => {
    const { directory, registry: previousProcess } = await registry();
    const [orphan] = await previousProcess.import([{
      name: "locked-orphan.png",
      mimeType: "image/png",
      data: png,
    }]);
    const reservation = await cleanupOrphanedAttachments(directory, {
      unlinkFile: vi.fn(async () => {
        throw Object.assign(new Error("still locked"), { code: "EPERM" });
      }),
      waitForRetry: async () => undefined,
    });
    expect(reservation).toEqual({ records: 1, bytes: png.length });

    const restarted = new AttachmentRegistry(directory, {
      maxRecords: 1,
      maxBytes: png.length,
      reservedRecords: reservation.records,
      reservedBytes: reservation.bytes,
    });
    await expect(restarted.resolve(orphan!.id)).resolves.toBeNull();
    await expect(restarted.import([{
      name: "must-not-bypass-orphan.png",
      mimeType: "image/png",
      data: png,
    }])).rejects.toThrow(/storage is full/u);
  });

  it("reserves the full ceiling when startup inventory cannot be inspected", async () => {
    const { directory } = await registry();
    const reservation = await cleanupOrphanedAttachments(directory, {
      readDirectory: vi.fn(async () => {
        throw Object.assign(new Error("inventory unavailable"), {
          code: "EACCES",
        });
      }),
    });
    const restarted = new AttachmentRegistry(directory, {
      reservedRecords: reservation.records,
      reservedBytes: reservation.bytes,
    });

    await expect(restarted.import([{
      name: "unaccounted-bypass.png",
      mimeType: "image/png",
      data: png,
    }])).rejects.toThrow(/storage is full/u);
  });

  it("serializes concurrent imports so they cannot race past the session cap", async () => {
    const { directory, registry: attachments } = await registry({
      maxRecords: 1,
      maxBytes: png.length + alternatePng.length,
    });
    const results = await Promise.allSettled([
      attachments.import([{
        name: "first.png",
        mimeType: "image/png",
        data: png,
      }]),
      attachments.import([{
        name: "second.png",
        mimeType: "image/png",
        data: alternatePng,
      }]),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(await readdir(directory)).toHaveLength(1);
  });

  it("reuses record and byte capacity after an attachment is released", async () => {
    const { registry: attachments } = await registry({
      maxRecords: 1,
      maxBytes: alternatePng.length,
    });
    const [first] = await attachments.import([{
      name: "first.png",
      mimeType: "image/png",
      data: alternatePng,
    }]);

    await attachments.release(first!.id);
    await expect(attachments.import([{
      name: "second.png",
      mimeType: "image/png",
      data: alternatePng,
    }])).resolves.toHaveLength(1);
  });

  it("retries transient unlink failures with bounded backoff", async () => {
    const waits: number[] = [];
    const unlinkFile = vi.fn<(path: string) => Promise<void>>()
      .mockRejectedValueOnce(Object.assign(
        new Error("file is still in use"),
        { code: "EPERM" },
      ))
      .mockRejectedValueOnce(Object.assign(
        new Error("file is still busy"),
        { code: "EBUSY" },
      ))
      .mockImplementation(async (path) => {
        await rm(path, { force: true });
      });
    const { registry: attachments } = await registry({
      maxRecords: 1,
      maxBytes: png.length,
    }, unlinkFile, async (delayMs) => {
      waits.push(delayMs);
    });
    const [first] = await attachments.import([{
      name: "locked.png",
      mimeType: "image/png",
      data: png,
    }]);

    await expect(attachments.release(first!.id)).resolves.toBe(true);
    await expect(attachments.import([{
      name: "after-retry.png",
      mimeType: "image/png",
      data: png,
    }])).resolves.toHaveLength(1);
    expect(unlinkFile).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([25, 50]);
  });

  it("retains records and accounting after transient unlink retries exhaust", async () => {
    const waits: number[] = [];
    const persistentError = Object.assign(
      new Error("file remains locked"),
      { code: "EPERM" },
    );
    const unlinkFile = vi.fn<(path: string) => Promise<void>>()
      .mockRejectedValue(persistentError);
    const { registry: attachments } = await registry({
      maxRecords: 1,
      maxBytes: png.length,
    }, unlinkFile, async (delayMs) => {
      waits.push(delayMs);
    });
    const [first] = await attachments.import([{
      name: "persistently-locked.png",
      mimeType: "image/png",
      data: png,
    }]);

    await expect(attachments.release(first!.id)).rejects.toThrow(
      "file remains locked",
    );
    expect(unlinkFile).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([25, 50]);
    await expect(attachments.preview(first!.id)).resolves.toBeNull();
    await expect(attachments.resolve(first!.id)).resolves.toBeNull();
    await expect(attachments.import([{
      name: "blocked-by-accounting.png",
      mimeType: "image/png",
      data: png,
    }])).rejects.toThrow(/storage is full/u);

    unlinkFile.mockImplementation(async (path) => {
      await rm(path, { force: true });
    });
    await expect(attachments.release(first!.id)).resolves.toBe(true);
    await expect(attachments.import([{
      name: "after-explicit-retry.png",
      mimeType: "image/png",
      data: png,
    }])).resolves.toHaveLength(1);
  });

  it("coalesces concurrent release attempts without double-unlinking", async () => {
    let finishUnlink!: () => void;
    const unlinkFile = vi.fn<(path: string) => Promise<void>>(
      () => new Promise<void>((resolve) => {
        finishUnlink = resolve;
      }),
    );
    const { registry: attachments } = await registry(undefined, unlinkFile);
    const [attachment] = await attachments.import([{
      name: "concurrent.png",
      mimeType: "image/png",
      data: png,
    }]);

    const first = attachments.release(attachment!.id);
    const second = attachments.release(attachment!.id);
    expect(unlinkFile).toHaveBeenCalledTimes(1);
    finishUnlink();

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    await expect(attachments.resolve(attachment!.id)).resolves.toBeNull();
  });

  it("fails closed when a new generation resolves during a slow release", async () => {
    let finishUnlink!: () => void;
    const unlinkFile = vi.fn<(path: string) => Promise<void>>(
      () => new Promise<void>((resolveUnlink) => {
        finishUnlink = resolveUnlink;
      }),
    );
    const { registry: attachments } = await registry(undefined, unlinkFile);
    const [attachment] = await attachments.import([{
      name: "cross-generation.png",
      mimeType: "image/png",
      data: png,
    }]);

    const release = attachments.release(attachment!.id);
    await expect(attachments.resolve(attachment!.id)).resolves.toBeNull();
    finishUnlink();
    await expect(release).resolves.toBe(true);
  });

  it("rejects an over-cap batch before creating records or files", async () => {
    const { directory, registry: attachments } = await registry({
      maxRecords: 8,
      maxBytes: png.length,
    });

    await expect(attachments.import([
      {
        name: "first.png",
        mimeType: "image/png",
        data: png,
      },
      {
        name: "second.png",
        mimeType: "image/png",
        data: alternatePng,
      },
    ])).rejects.toThrow(/storage is full/u);
    await expect(readdir(directory)).resolves.toEqual([]);

    await expect(attachments.import([{
      name: "fits.png",
      mimeType: "image/png",
      data: png,
    }])).resolves.toHaveLength(1);
  });
});
