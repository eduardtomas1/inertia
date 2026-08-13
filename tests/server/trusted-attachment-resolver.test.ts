import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatAttachment } from "../../src/shared/contracts";
import type { TrustedRuntimeAttachment } from "../../src/shared/runtime-attachments";
import {
  TrustedAttachmentResolver,
  type RuntimeAttachmentBroker,
} from "../../src/server/runtime/attachments/trusted-attachment-resolver";
import { publicRuntimeError } from "../../src/server/runtime-errors";

const directories: string[] = [];
const id = "11111111-1111-4111-8111-111111111111";
const handoffId = "22222222-2222-4222-8222-222222222222";
const png = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

async function fixture(): Promise<{
  root: string;
  trusted: TrustedRuntimeAttachment;
}> {
  const directory = await mkdtemp(join(tmpdir(), "inertia-trusted-attachment-"));
  directories.push(directory);
  const root = join(directory, "imports");
  await mkdir(root);
  const path = join(root, `${id}.png`);
  await writeFile(path, png);
  return {
    root: await realpath(root),
    trusted: {
      id,
      name: "preview.png",
      path: await realpath(path),
      mimeType: "image/png",
      size: png.length,
      digest: createHash("sha256").update(png).digest("hex"),
    },
  };
}

function broker(
  attachment: TrustedRuntimeAttachment | null,
): RuntimeAttachmentBroker {
  return {
    resolve: vi.fn(async () => attachment),
    release: vi.fn(async () => true),
    cleanup: vi.fn(async () => true),
    relinquish: vi.fn(async () => true),
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("trusted runtime attachment resolution", () => {
  it("uses only the main-authorized descriptor and ignores renderer path and metadata", async () => {
    const { root, trusted } = await fixture();
    const resolver = new TrustedAttachmentResolver(root, broker(trusted));
    const rendererPayload: ChatAttachment = {
      id,
      name: "tampered.jpg",
      path: join(root, "..", "outside-secret.jpg"),
      mimeType: "image/jpeg",
      size: 1,
    };

    await expect(resolver.resolveAll([rendererPayload], handoffId)).resolves.toEqual([{
      id,
      name: "preview.png",
      path: trusted.path,
      mimeType: "image/png",
      size: png.length,
    }]);
  });

  it("rejects a broker path outside the trusted root", async () => {
    const { root, trusted } = await fixture();
    const outside = join(root, "..", "outside.png");
    await writeFile(outside, png);
    const attachmentBroker = broker({
      ...trusted,
      path: await realpath(outside),
    });
    const resolver = new TrustedAttachmentResolver(root, attachmentBroker);

    await expect(resolver.resolveAll([trusted], handoffId)).rejects.toThrow(
      /no longer available|verified/u,
    );
    expect(attachmentBroker.relinquish).toHaveBeenCalledWith(id);
    await expect(resolver.resolveAll([trusted], handoffId)).rejects.toSatisfy(
      (error: unknown) => publicRuntimeError(error)
        === "The selected attachment is no longer available or could not be verified.",
    );
  });

  it.each([
    (trusted: TrustedRuntimeAttachment) => ({
      ...trusted,
      name: "preview.jpg",
    }),
    (trusted: TrustedRuntimeAttachment) => ({
      ...trusted,
      mimeType: "image/jpeg" as const,
    }),
    (trusted: TrustedRuntimeAttachment) => ({
      ...trusted,
      size: trusted.size - 1,
    }),
    (trusted: TrustedRuntimeAttachment) => ({
      ...trusted,
      digest: "0".repeat(64),
    }),
  ])("rejects tampered trusted metadata %#", async (tamper) => {
    const { root, trusted } = await fixture();
    const resolver = new TrustedAttachmentResolver(
      root,
      broker(tamper(trusted)),
    );

    await expect(resolver.resolveAll([trusted], handoffId)).rejects.toThrow(
      /no longer available|verified/u,
    );
  });

  it("rejects mismatched and missing capability identities", async () => {
    const { root, trusted } = await fixture();
    const mismatch = new TrustedAttachmentResolver(root, broker({
      ...trusted,
      id: "22222222-2222-4222-8222-222222222222",
    }));
    const missing = new TrustedAttachmentResolver(root, broker(null));

    await expect(mismatch.resolveAll([trusted], handoffId)).rejects.toThrow();
    await expect(missing.resolveAll([trusted], handoffId)).rejects.toThrow();
  });

  it("rejects an id paired with another registered path", async () => {
    const { root, trusted } = await fixture();
    const otherId = "22222222-2222-4222-8222-222222222222";
    const otherPath = join(root, `${otherId}.png`);
    await writeFile(otherPath, png);
    const resolver = new TrustedAttachmentResolver(root, broker({
      ...trusted,
      path: await realpath(otherPath),
    }));

    await expect(resolver.resolveAll([trusted], handoffId)).rejects.toThrow(
      /no longer available|verified/u,
    );
  });

  it("relinquishes earlier claims when aggregate resolution is aborted", async () => {
    const { root, trusted } = await fixture();
    const secondId = "22222222-2222-4222-8222-222222222222";
    const relinquish = vi.fn(async () => true);
    const attachmentBroker: RuntimeAttachmentBroker = {
      resolve: vi.fn((
        requestedId: string,
        _handoffId: string,
        signal?: AbortSignal,
      ): Promise<TrustedRuntimeAttachment | null> => {
        if (requestedId === id) return Promise.resolve(trusted);
        return new Promise<TrustedRuntimeAttachment | null>(
          (_resolve, reject) => {
            signal?.addEventListener("abort", () => {
              reject(new Error("aborted"));
            }, { once: true });
          },
        );
      }),
      release: vi.fn(async () => true),
      cleanup: vi.fn(async () => true),
      relinquish,
    };
    const resolver = new TrustedAttachmentResolver(root, attachmentBroker);
    const controller = new AbortController();
    const resolving = resolver.resolvePayloads([
      trusted,
      {
        id: secondId,
        name: "second.png",
        path: "opaque-renderer-path",
        mimeType: "image/png",
        size: png.length,
      },
    ], handoffId, controller.signal);
    await vi.waitFor(() => {
      expect(attachmentBroker.resolve).toHaveBeenCalledWith(
        secondId,
        handoffId,
        controller.signal,
      );
    });

    controller.abort();

    await expect(resolving).rejects.toThrow("aborted");
    expect(relinquish).toHaveBeenCalledWith(id);
  });
});
