import {
  mkdtemp,
  open,
  readdir,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ATTACHMENT_COPY_CHUNK_BYTES,
  importSelectedAttachmentPaths,
  privacySafeAttachmentImportError,
} from "../../src/main/attachment-selection-import";
import {
  AttachmentRegistry,
  type AttachmentImportWriter,
} from "../../src/main/attachment-registry";
import type { ChatAttachment } from "../../src/shared/contracts";
import { validXlsxFixture } from "../fixtures/attachments/malicious-structures";

const directories: string[] = [];

async function directory(prefix: string): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), prefix));
  directories.push(created);
  return created;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(async (path) =>
    await rm(path, { recursive: true, force: true })));
});

function registryFor(
  output: string,
  options: {
    beforeImport?: (index: number) => Promise<void> | void;
    failAt?: number;
  } = {},
): {
  registry: Pick<AttachmentRegistry, "importFromWriter" | "rollback">;
  maxActive: () => number;
  released: string[];
} {
  let sequence = 0;
  let active = 0;
  let maximum = 0;
  const paths = new Map<string, string>();
  const released: string[] = [];
  return {
    maxActive: () => maximum,
    released,
    registry: {
      importFromWriter: async (
        source: AttachmentImportWriter,
        signal?: AbortSignal,
      ): Promise<ChatAttachment> => {
        const index = sequence;
        sequence += 1;
        await options.beforeImport?.(index);
        if (index === options.failAt) throw new Error("synthetic failure");
        const id = `${String(index + 1).padStart(8, "0")}-1111-4111-8111-111111111111`;
        const path = join(output, `${id}.pdf`);
        const destination = await open(path, "wx", 0o600);
        const operationSignal = signal ?? new AbortController().signal;
        active += 1;
        maximum = Math.max(maximum, active);
        try {
          await source.write(destination, operationSignal);
        } catch (error) {
          await rm(path, { force: true });
          throw error;
        } finally {
          active -= 1;
          await destination.close();
        }
        paths.set(id, path);
        return {
          id,
          name: source.name,
          path: id,
          mimeType: "application/pdf",
          size: source.size,
        };
      },
      rollback: async (id: string): Promise<void> => {
        released.push(id);
        const path = paths.get(id);
        if (path) await rm(path, { force: true });
        paths.delete(id);
      },
    },
  };
}

describe("native attachment selection streaming", () => {
  it("copies an exact 20 MiB selection one source at a time in 64 KiB chunks", async () => {
    const source = await directory("inertia-selection-source-");
    const output = await directory("inertia-selection-output-");
    const size = 2_621_440;
    const paths: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      const path = join(source, `input-${index}.pdf`);
      await writeFile(path, "", { mode: 0o600 });
      await truncate(path, size);
      paths.push(path);
    }
    const allocations: number[] = [];
    const allocate = Buffer.allocUnsafe.bind(Buffer);
    vi.spyOn(Buffer, "allocUnsafe").mockImplementation((bytes) => {
      allocations.push(bytes);
      return allocate(bytes);
    });
    const fake = registryFor(output);

    const imported = await importSelectedAttachmentPaths(
      fake.registry,
      paths,
      "all",
      new AbortController().signal,
    );

    expect(imported).toHaveLength(8);
    expect(fake.maxActive()).toBe(1);
    expect(Math.max(...allocations)).toBe(ATTACHMENT_COPY_CHUNK_BYTES);
    expect(await readdir(output)).toHaveLength(8);
  });

  it("rolls back earlier staged capabilities after a later failure", async () => {
    const source = await directory("inertia-selection-source-");
    const output = await directory("inertia-selection-output-");
    const paths = await Promise.all([0, 1, 2].map(async (index) => {
      const path = join(source, `input-${index}.pdf`);
      await writeFile(path, `safe-${index}`, { mode: 0o600 });
      return path;
    }));
    const fake = registryFor(output, { failAt: 2 });

    await expect(importSelectedAttachmentPaths(
      fake.registry,
      paths,
      "all",
      new AbortController().signal,
    )).rejects.toThrow("synthetic failure");

    expect(fake.released).toHaveLength(2);
    expect(await readdir(output)).toEqual([]);
  });

  it("rolls back the staged native prefix when renderer lifetime is cancelled", async () => {
    const source = await directory("inertia-selection-source-");
    const output = await directory("inertia-selection-output-");
    const paths = await Promise.all([0, 1].map(async (index) => {
      const path = join(source, `input-${index}.pdf`);
      await writeFile(path, `safe-${index}`, { mode: 0o600 });
      return path;
    }));
    const lifetime = new AbortController();
    const fake = registryFor(output, {
      beforeImport: (index) => {
        if (index === 1) lifetime.abort();
      },
    });

    await expect(importSelectedAttachmentPaths(
      fake.registry,
      paths,
      "all",
      lifetime.signal,
    )).rejects.toThrow("aborted");

    expect(fake.released).toHaveLength(1);
    expect(await readdir(output)).toEqual([]);
  });

  it("deduplicates identical content across sequential staged writes", async () => {
    const source = await directory("inertia-selection-source-");
    const output = await directory("inertia-selection-output-");
    const first = join(source, "first.xlsx");
    const second = join(source, "renamed.xlsx");
    const bytes = validXlsxFixture();
    await Promise.all([
      writeFile(first, bytes, { mode: 0o600 }),
      writeFile(second, bytes, { mode: 0o600 }),
    ]);
    const registry = new AttachmentRegistry(output);

    const imported = await importSelectedAttachmentPaths(
      registry,
      [first, second],
      "all",
      new AbortController().signal,
    );

    expect(imported).toHaveLength(1);
    expect(imported[0]?.name).toBe("first.xlsx");
    expect(await readdir(output)).toHaveLength(1);
    expect(registry.usage()).toEqual({ records: 1, bytes: bytes.length });
    await registry.dispose();
  });

  it("rejects replacement between dialog selection and sequential open", async () => {
    const source = await directory("inertia-selection-source-");
    const output = await directory("inertia-selection-output-");
    const first = join(source, "first.pdf");
    const second = join(source, "second.pdf");
    await writeFile(first, "first", { mode: 0o600 });
    await writeFile(second, "second", { mode: 0o600 });
    const fake = registryFor(output, {
      beforeImport: async (index) => {
        if (index !== 0) return;
        await rename(second, join(source, "selected-second.pdf"));
        await writeFile(second, "second", { mode: 0o600 });
      },
    });

    await expect(importSelectedAttachmentPaths(
      fake.registry,
      [first, second],
      "all",
      new AbortController().signal,
    )).rejects.toThrow(/changed while it was being opened/u);
    expect(fake.released).toHaveLength(1);
    expect(await readdir(output)).toEqual([]);
  });

  it("rejects symbolic-link selections before opening source bytes", async () => {
    const source = await directory("inertia-selection-source-");
    const output = await directory("inertia-selection-output-");
    const target = join(source, "target.pdf");
    const linked = join(source, "linked.pdf");
    await writeFile(target, "safe", { mode: 0o600 });
    await symlink(target, linked);
    const fake = registryFor(output);

    await expect(importSelectedAttachmentPaths(
      fake.registry,
      [linked],
      "all",
      new AbortController().signal,
    )).rejects.toThrow(/safe regular file/u);
    expect(await readdir(output)).toEqual([]);
  });

  it("maps path-bearing filesystem failures to a privacy-safe message", () => {
    const privatePath = "/Users/person/secret/client-acquisition.pdf";
    const sanitized = privacySafeAttachmentImportError(
      new Error(`EACCES: permission denied, open '${privatePath}'`),
    );

    expect(sanitized.message).toBe("Attachments could not be added safely.");
    expect(sanitized.message).not.toContain(privatePath);
  });
});
