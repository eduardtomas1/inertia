import { createHash } from "node:crypto";
import {
  linkSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { performSecureFileOperation } from "../../src/main/secure-file-worker";
import type {
  SecureFileIdentity,
  SecureFileRequest,
} from "../../src/node/secure-file-protocol";

const roots: string[] = [];
const originalCwd = process.cwd();

function identity(info: { dev: bigint; ino: bigint }): SecureFileIdentity {
  return {
    dev: info.dev.toString(10),
    ino: info.ino.toString(10),
  };
}

function requestFor(
  root: string,
  path: string,
  operation: "read" | "replace",
  content = Buffer.alloc(0),
): SecureFileRequest {
  const segments = path.split("/");
  const basename = segments.pop()!;
  const parentIdentities: SecureFileIdentity[] = [];
  let cursor = root;
  for (const segment of segments) {
    cursor = join(cursor, segment);
    parentIdentities.push(identity(lstatSync(cursor, { bigint: true })));
  }
  const target = join(cursor, basename);
  const existing = readFileSync(target);
  const base = {
    root,
    rootIdentity: identity(statSync(root, { bigint: true })),
    parentIdentities,
    targetIdentity: identity(lstatSync(target, { bigint: true })),
    path,
    maxBytes: 1024,
  };
  return operation === "read"
    ? { ...base, operation: "read" }
    : {
        ...base,
        operation: "replace",
        expectedDigest: createHash("sha256").update(existing).digest("hex"),
        contentBase64: content.toString("base64"),
        expectedMode: statSync(target).mode & 0o777,
        mode: statSync(target).mode & 0o777,
      };
}

async function perform(
  request: SecureFileRequest,
): ReturnType<typeof performSecureFileOperation> {
  process.chdir(request.root);
  try {
    return await performSecureFileOperation(request);
  } finally {
    process.chdir(originalCwd);
  }
}

afterEach(() => {
  process.chdir(originalCwd);
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("secure file worker", () => {
  it("reads and atomically replaces an identity-verified nested file", async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "inertia-secure-file-")),
    );
    roots.push(root);
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "example.ts"), "before\n");

    const read = await perform(requestFor(root, "src/example.ts", "read"));
    expect(read).toMatchObject({ ok: true, operation: "read" });
    if (!read.ok || read.operation !== "read") return;
    expect(Buffer.from(read.contentBase64, "base64").toString("utf8"))
      .toBe("before\n");

    const replace = await perform(requestFor(
      root,
      "src/example.ts",
      "replace",
      Buffer.from("after\n"),
    ));
    expect(replace).toMatchObject({ ok: true, operation: "replace" });
    expect(readFileSync(join(root, "src", "example.ts"), "utf8"))
      .toBe("after\n");
  });

  it("supports empty replacement content without weakening the size bound", async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "inertia-secure-empty-")),
    );
    roots.push(root);
    writeFileSync(join(root, "empty.txt"), "not empty");

    const result = await perform(requestFor(
      root,
      "empty.txt",
      "replace",
      Buffer.alloc(0),
    ));
    expect(result).toMatchObject({
      ok: true,
      operation: "replace",
      metadata: { size: 0 },
    });
    expect(readFileSync(join(root, "empty.txt"))).toHaveLength(0);
  });

  it.skipIf(process.platform === "win32")(
    "rejects replacement after a concurrent permission change",
    async () => {
      const root = realpathSync(
        mkdtempSync(join(tmpdir(), "inertia-secure-mode-")),
      );
      roots.push(root);
      const target = join(root, "example.ts");
      writeFileSync(target, "before\n", { mode: 0o644 });
      const request = requestFor(
        root,
        "example.ts",
        "replace",
        Buffer.from("after\n"),
      );
      chmodSync(target, 0o600);

      expect(await perform(request)).toMatchObject({
        ok: false,
        code: "conflict",
      });
      expect(readFileSync(target, "utf8")).toBe("before\n");
      expect(statSync(target).mode & 0o777).toBe(0o600);
    },
  );

  it("rejects stale parent identity and symlinked parent paths", async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "inertia-secure-parent-")),
    );
    const outside = realpathSync(
      mkdtempSync(join(tmpdir(), "inertia-secure-outside-")),
    );
    roots.push(root, outside);
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "example.ts"), "safe\n");
    writeFileSync(join(outside, "example.ts"), "outside\n");
    const original = requestFor(root, "src/example.ts", "read");
    const stale: SecureFileRequest = {
      ...original,
      parentIdentities: [{ dev: "0", ino: "1" }],
    };
    expect(await perform(stale)).toMatchObject({ ok: false, code: "unsafe" });

    rmSync(join(root, "src"), { recursive: true, force: true });
    symlinkSync(outside, join(root, "src"), "dir");
    const linked = {
      ...stale,
      parentIdentities: [identity(statSync(outside, { bigint: true }))],
      targetIdentity: identity(lstatSync(join(outside, "example.ts"), {
        bigint: true,
      })),
    };
    expect(await perform(linked)).toMatchObject({
      ok: false,
      code: "unsafe",
    });
    expect(readFileSync(join(outside, "example.ts"), "utf8")).toBe("outside\n");
  });

  it("rejects a replacement root before touching its target", async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "inertia-secure-root-")),
    );
    const movedRoot = `${root}-moved`;
    const outside = realpathSync(
      mkdtempSync(join(tmpdir(), "inertia-secure-root-outside-")),
    );
    roots.push(root, movedRoot, outside);
    writeFileSync(join(root, "example.ts"), "inside\n");
    writeFileSync(join(outside, "example.ts"), "outside\n");
    const request = requestFor(
      root,
      "example.ts",
      "replace",
      Buffer.from("replacement\n"),
    );
    renameSync(root, movedRoot);
    symlinkSync(
      outside,
      root,
      process.platform === "win32" ? "junction" : "dir",
    );

    expect(await perform(request)).toMatchObject({
      ok: false,
      code: "unsafe",
    });
    expect(readFileSync(join(outside, "example.ts"), "utf8"))
      .toBe("outside\n");
    expect(readFileSync(join(movedRoot, "example.ts"), "utf8"))
      .toBe("inside\n");
  });

  it("refuses to replace a multiply-linked target", async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "inertia-secure-hardlink-")),
    );
    roots.push(root);
    writeFileSync(join(root, "source.txt"), "shared\n");
    linkSync(join(root, "source.txt"), join(root, "alias.txt"));

    const result = await perform(requestFor(
      root,
      "alias.txt",
      "replace",
      Buffer.from("changed\n"),
    ));

    expect(result).toMatchObject({ ok: false, code: "unsafe" });
    expect(readFileSync(join(root, "source.txt"), "utf8")).toBe("shared\n");
    expect(readFileSync(join(root, "alias.txt"), "utf8")).toBe("shared\n");
  });
});
