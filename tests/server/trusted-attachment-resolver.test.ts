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

const directories: string[] = [];
const id = "11111111-1111-4111-8111-111111111111";
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
  return { resolve: vi.fn(async () => attachment) };
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

    await expect(resolver.resolveAll([rendererPayload])).resolves.toEqual([{
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
    const resolver = new TrustedAttachmentResolver(
      root,
      broker({ ...trusted, path: await realpath(outside) }),
    );

    await expect(resolver.resolveAll([trusted])).rejects.toThrow(
      /no longer available|verified/u,
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

    await expect(resolver.resolveAll([trusted])).rejects.toThrow(
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

    await expect(mismatch.resolveAll([trusted])).rejects.toThrow();
    await expect(missing.resolveAll([trusted])).rejects.toThrow();
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

    await expect(resolver.resolveAll([trusted])).rejects.toThrow(
      /no longer available|verified/u,
    );
  });
});
