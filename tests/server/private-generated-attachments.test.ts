import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PrivateGeneratedAttachmentStore } from "../../src/server/runtime/attachments/private-generated-attachments";

const temporaryDirectories: string[] = [];

async function temporaryDataDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "inertia-generated-store-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("private generated attachment storage", () => {
  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })));
  });

  it("creates exclusive private files and releases every owned path idempotently", async () => {
    const dataDirectory = await temporaryDataDirectory();
    const store = await PrivateGeneratedAttachmentStore.create(dataDirectory);

    const [first, second] = await Promise.all([
      store.writeJpeg(new Uint8Array([0xff, 0xd8, 1, 0xff, 0xd9])),
      store.writeJpeg(new Uint8Array([0xff, 0xd8, 2, 0xff, 0xd9])),
    ]);

    expect(first).not.toBe(second);
    expect(await readFile(first)).toEqual(Buffer.from([0xff, 0xd8, 1, 0xff, 0xd9]));
    expect(store.usage()).toEqual({ bytes: 10, records: 2 });
    if (process.platform !== "win32") {
      expect((await lstat(store.directory)).mode & 0o777).toBe(0o700);
      expect((await lstat(first)).mode & 0o777).toBe(0o600);
    }

    await store.release([first, second, first]);
    await store.release([first, second]);
    expect(store.usage()).toEqual({ bytes: 0, records: 0 });
    await expect(access(first)).rejects.toThrow();
    await expect(access(second)).rejects.toThrow();
  });

  it("enforces aggregate byte and record quotas and recovers capacity on release", async () => {
    const dataDirectory = await temporaryDataDirectory();
    const store = await PrivateGeneratedAttachmentStore.create(dataDirectory, {
      maxBytes: 4,
      maxRecords: 2,
    });
    const first = await store.writeJpeg(new Uint8Array([1, 2]));
    const second = await store.writeJpeg(new Uint8Array([3, 4]));

    await expect(store.writeJpeg(new Uint8Array([5])))
      .rejects.toThrow("storage is full");
    await store.release([first]);
    const replacement = await store.writeJpeg(new Uint8Array([5, 6]));
    expect(store.usage()).toEqual({ bytes: 4, records: 2 });
    await store.release([second, replacement]);
  });

  it("retries a partially failed multi-path release without losing the failed lease", async () => {
    const dataDirectory = await temporaryDataDirectory();
    const store = await PrivateGeneratedAttachmentStore.create(dataDirectory);
    const first = await store.writeJpeg(new Uint8Array([1]));
    const second = await store.writeJpeg(new Uint8Array([2]));
    await rm(second);
    await mkdir(second);

    await expect(store.release([first, second])).rejects.toThrow();
    await expect(access(first)).rejects.toThrow();
    expect(store.usage()).toEqual({ bytes: 1, records: 1 });

    await rm(second, { recursive: true });
    await writeFile(second, new Uint8Array([2]));
    await store.release([first, second]);
    expect(store.usage()).toEqual({ bytes: 0, records: 0 });
    await expect(access(second)).rejects.toThrow();
  });

  it("rejects out-of-root leases without touching either file", async () => {
    const dataDirectory = await temporaryDataDirectory();
    const store = await PrivateGeneratedAttachmentStore.create(dataDirectory);
    const owned = await store.writeJpeg(new Uint8Array([1]));
    const outside = join(
      dataDirectory,
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg",
    );
    await writeFile(outside, "outside");

    await expect(store.release([owned, outside]))
      .rejects.toThrow("lease is invalid");
    await expect(access(owned)).resolves.toBeUndefined();
    await expect(access(outside)).resolves.toBeUndefined();
    await store.release([owned]);
  });

  it("sweeps crash leftovers on restart and rejects unexpected directory entries", async () => {
    const dataDirectory = await temporaryDataDirectory();
    const first = await PrivateGeneratedAttachmentStore.create(dataDirectory);
    const leftover = await first.writeJpeg(new Uint8Array([1, 2, 3]));

    const restarted = await PrivateGeneratedAttachmentStore.create(dataDirectory);
    await expect(access(leftover)).rejects.toThrow();
    expect(restarted.usage()).toEqual({ bytes: 0, records: 0 });

    const unexpected = join(restarted.directory, "do-not-delete.txt");
    await writeFile(unexpected, "preserve");
    await expect(PrivateGeneratedAttachmentStore.create(dataDirectory))
      .rejects.toThrow("unexpected entry");
    await expect(readFile(unexpected, "utf8")).resolves.toBe("preserve");
  });

  it.runIf(process.platform !== "win32")(
    "unlinks a crash-leftover UUID symlink without following it",
    async () => {
      const dataDirectory = await temporaryDataDirectory();
      const store = await PrivateGeneratedAttachmentStore.create(dataDirectory);
      const outside = join(dataDirectory, "outside.txt");
      await writeFile(outside, "preserve");
      const link = join(
        store.directory,
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg",
      );
      await symlink(outside, link);

      await PrivateGeneratedAttachmentStore.create(dataDirectory);
      await expect(access(link)).rejects.toThrow();
      await expect(readFile(outside, "utf8")).resolves.toBe("preserve");
      expect(await readdir(store.directory)).toEqual([]);
    },
  );
});
