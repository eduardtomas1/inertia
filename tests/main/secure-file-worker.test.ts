import { createHash } from "node:crypto";
import {
  linkSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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

import {
  performSecureFileOperation,
  recoverSecureFileOperation,
} from "../../src/main/secure-file-worker";
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
  const segments = request.path.split("/");
  segments.pop();
  process.chdir(join(request.root, ...segments));
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
  it.skipIf(process.platform === "win32")(
    "reads and replaces a POSIX filename containing a literal backslash",
    async () => {
      const root = realpathSync(
        mkdtempSync(join(tmpdir(), "inertia-secure-file-posix-")),
      );
      roots.push(root);
      const filename = "notes\\draft.md";
      writeFileSync(join(root, filename), "before\n");

      const read = await perform(requestFor(root, filename, "read"));
      expect(read).toMatchObject({ ok: true, operation: "read" });

      const replaced = await perform(requestFor(
        root,
        filename,
        "replace",
        Buffer.from("after\n"),
      ));
      expect(replaced).toMatchObject({ ok: true, operation: "replace" });
      expect(readFileSync(join(root, filename), "utf8")).toBe("after\n");
    },
  );

  it("reads and replaces an identity-verified nested file through a pinned handle", async () => {
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

  it("does not overwrite a concurrent path replacement", async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "inertia-secure-file-cas-")),
    );
    roots.push(root);
    const target = join(root, "example.ts");
    const displaced = join(root, "displaced.ts");
    writeFileSync(target, "before\n");
    const request = requestFor(
      root,
      "example.ts",
      "replace",
      Buffer.from("edited\n"),
    );
    process.chdir(root);
    try {
      const result = await performSecureFileOperation(request, {
        beforeClaim: () => {
          renameSync(target, displaced);
          writeFileSync(target, "concurrent\n");
        },
      });
      expect(result).toMatchObject({ ok: false, code: "conflict" });
      expect(readFileSync(target, "utf8")).toBe("concurrent\n");
      expect(readFileSync(displaced, "utf8")).toBe("before\n");
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("restores a concurrent replacement claimed in the final rename gap", async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "inertia-secure-final-gap-")),
    );
    roots.push(root);
    const target = join(root, "example.ts");
    const displaced = join(root, "displaced.ts");
    writeFileSync(target, "before\n");
    const request = requestFor(
      root,
      "example.ts",
      "replace",
      Buffer.from("edited\n"),
    );
    process.chdir(root);
    try {
      const result = await performSecureFileOperation(request, {
        beforeClaimRename: () => {
          renameSync(target, displaced);
          writeFileSync(target, "concurrent\n");
        },
      });
      expect(result).toMatchObject({ ok: false, code: "conflict" });
      expect(readFileSync(target, "utf8")).toBe("concurrent\n");
      expect(readFileSync(displaced, "utf8")).toBe("before\n");
      expect(readdirSync(root).some((name) => (
        name.startsWith(".inertia-save-")
      ))).toBe(false);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("preserves a directory substituted in the final claim gap", async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "inertia-secure-final-directory-gap-")),
    );
    roots.push(root);
    const target = join(root, "example.ts");
    const displaced = join(root, "displaced.ts");
    writeFileSync(target, "before\n");
    const request = requestFor(
      root,
      "example.ts",
      "replace",
      Buffer.from("edited\n"),
    );
    process.chdir(root);
    try {
      const result = await performSecureFileOperation(request, {
        beforeClaimRename: () => {
          renameSync(target, displaced);
          mkdirSync(target);
        },
      });
      expect(result).toMatchObject({ ok: false, code: "unsafe" });
      expect(lstatSync(target).isDirectory()).toBe(true);
      expect(readFileSync(displaced, "utf8")).toBe("before\n");
      expect(readdirSync(root).filter((name) => (
        name.startsWith(".inertia-save-")
      ))).toEqual([]);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("preserves a directory link substituted in the final claim gap", async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "inertia-secure-final-link-gap-")),
    );
    roots.push(root);
    const target = join(root, "example.ts");
    const displaced = join(root, "displaced.ts");
    const concurrentDirectory = join(root, "concurrent-directory");
    mkdirSync(concurrentDirectory);
    writeFileSync(join(concurrentDirectory, "marker.txt"), "concurrent\n");
    writeFileSync(target, "before\n");
    const request = requestFor(
      root,
      "example.ts",
      "replace",
      Buffer.from("edited\n"),
    );
    process.chdir(root);
    try {
      const result = await performSecureFileOperation(request, {
        beforeClaimRename: () => {
          renameSync(target, displaced);
          symlinkSync(
            concurrentDirectory,
            target,
            process.platform === "win32" ? "junction" : "dir",
          );
        },
      });
      expect(result).toMatchObject({ ok: false, code: "unsafe" });
      expect(lstatSync(target).isSymbolicLink()).toBe(true);
      expect(readFileSync(join(target, "marker.txt"), "utf8"))
        .toBe("concurrent\n");
      expect(readFileSync(displaced, "utf8")).toBe("before\n");
      expect(readdirSync(root).filter((name) => (
        name.startsWith(".inertia-save-")
      ))).toEqual([]);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("does not overwrite a concurrently created claim destination", async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "inertia-secure-claim-destination-race-")),
    );
    roots.push(root);
    const target = join(root, "example.ts");
    writeFileSync(target, "before\n");
    const request = requestFor(
      root,
      "example.ts",
      "replace",
      Buffer.from("edited\n"),
    );
    let backupName = "";
    process.chdir(root);
    try {
      const result = await performSecureFileOperation(request, {
        beforeClaimRename: () => {
          const journalName = readdirSync(root).find((name) => (
            name.endsWith(".journal")
          ));
          if (!journalName) throw new Error("Expected a secure-save journal.");
          const journal = JSON.parse(
            readFileSync(journalName, "utf8"),
          ) as { backup: string };
          backupName = journal.backup;
          writeFileSync(backupName, "concurrent destination\n");
        },
      });
      expect(result).toMatchObject({ ok: false, code: "conflict" });
      expect(readFileSync(target, "utf8")).toBe("before\n");
      expect(readFileSync(backupName, "utf8"))
        .toBe("concurrent destination\n");
      expect(readdirSync(root).filter((name) => name.endsWith(".journal")))
        .toEqual([]);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("restores original content when a pinned write is interrupted", async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "inertia-secure-file-restore-")),
    );
    roots.push(root);
    const target = join(root, "example.ts");
    writeFileSync(target, "before\n");
    const request = requestFor(
      root,
      "example.ts",
      "replace",
      Buffer.from("replacement\n"),
    );
    process.chdir(root);
    try {
      const result = await performSecureFileOperation(request, {
        writeStaged: async (handle) => {
          await handle.write(Buffer.from("partial"), 0, 7, 0);
          throw new Error("Injected write failure.");
        },
      });
      expect(result).toMatchObject({ ok: false, code: "unavailable" });
      expect(readFileSync(target, "utf8")).toBe("before\n");
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("never publishes a partial secure-save journal", async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "inertia-secure-journal-partial-")),
    );
    roots.push(root);
    const target = join(root, "example.ts");
    writeFileSync(target, "before\n");
    const request = requestFor(
      root,
      "example.ts",
      "replace",
      Buffer.from("after\n"),
    );
    process.chdir(root);
    try {
      const result = await performSecureFileOperation(request, {
        writeJournalPending: async (handle) => {
          await handle.write(Buffer.from("{"), 0, 1, 0);
          throw new Error("Injected pending-journal interruption.");
        },
      });
      expect(result).toMatchObject({ ok: false, code: "unavailable" });
      expect(readFileSync(target, "utf8")).toBe("before\n");
      expect(readdirSync(root).filter((name) => (
        name.endsWith(".journal") || name.endsWith(".pending")
      ))).toEqual([]);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("does not publish a substituted pending journal source", async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "inertia-secure-journal-source-race-")),
    );
    roots.push(root);
    const target = join(root, "example.ts");
    const displacedPending = join(root, "displaced-pending");
    writeFileSync(target, "before\n");
    const request = requestFor(
      root,
      "example.ts",
      "replace",
      Buffer.from("after\n"),
    );
    let pendingName = "";
    let journalName = "";
    process.chdir(root);
    try {
      const result = await performSecureFileOperation(request, {
        beforeJournalPublish: (pending, journal) => {
          pendingName = pending;
          journalName = journal;
          renameSync(pending, displacedPending);
          writeFileSync(pending, "substituted\n");
        },
      });
      expect(result).toMatchObject({ ok: false, code: "unsafe" });
      expect(readFileSync(target, "utf8")).toBe("before\n");
      expect(readFileSync(pendingName, "utf8")).toBe("substituted\n");
      expect(readFileSync(displacedPending, "utf8")).toContain(
        "\"version\":1",
      );
      expect(() => lstatSync(journalName)).toThrow();
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("does not replace a concurrently created journal destination", async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "inertia-secure-journal-destination-race-")),
    );
    roots.push(root);
    const target = join(root, "example.ts");
    writeFileSync(target, "before\n");
    const request = requestFor(
      root,
      "example.ts",
      "replace",
      Buffer.from("after\n"),
    );
    let journalName = "";
    process.chdir(root);
    try {
      const result = await performSecureFileOperation(request, {
        beforeJournalPublish: (_pending, journal) => {
          journalName = journal;
          writeFileSync(journal, "concurrent\n");
        },
      });
      expect(result).toMatchObject({ ok: false, code: "conflict" });
      expect(readFileSync(target, "utf8")).toBe("before\n");
      expect(readFileSync(journalName, "utf8")).toBe("concurrent\n");
      expect(readdirSync(root).filter((name) => name.endsWith(".pending")))
        .toEqual([]);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("ignores and later cleans a terminated unpublished journal", async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "inertia-secure-journal-pending-")),
    );
    roots.push(root);
    const target = join(root, "example.ts");
    writeFileSync(target, "before\n");
    const request = requestFor(
      root,
      "example.ts",
      "replace",
      Buffer.from("after\n"),
    );
    process.chdir(root);
    try {
      const interrupted = await performSecureFileOperation(request, {
        stopAfter: "journal-pending",
      });
      expect(interrupted).toMatchObject({
        ok: false,
        code: "unavailable",
      });
      expect(readFileSync(target, "utf8")).toBe("before\n");
      expect(readdirSync(root).filter((name) => name.endsWith(".journal")))
        .toEqual([]);
      expect(readdirSync(root).filter((name) => name.endsWith(".pending")))
        .toHaveLength(1);

      const retried = await performSecureFileOperation(request);
      expect(retried).toMatchObject({ ok: true, operation: "replace" });
      expect(readFileSync(target, "utf8")).toBe("after\n");
      expect(readdirSync(root).some((name) => (
        name.startsWith(".inertia-save-")
      ))).toBe(false);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("rolls back when the staged inode gains a hard link before install", async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "inertia-secure-stage-link-")),
    );
    roots.push(root);
    const target = join(root, "example.ts");
    const alias = join(root, "stage-alias.ts");
    writeFileSync(target, "before\n");
    const request = requestFor(
      root,
      "example.ts",
      "replace",
      Buffer.from("after\n"),
    );
    process.chdir(root);
    try {
      const result = await performSecureFileOperation(request, {
        afterClaim: () => {
          const stage = readdirSync(root).find((name) => (
            name.endsWith(".stage")
          ));
          if (!stage) throw new Error("Expected a staged save.");
          linkSync(join(root, stage), alias);
        },
      });
      expect(result).toMatchObject({ ok: false, code: "unsafe" });
      expect(readFileSync(target, "utf8")).toBe("before\n");
      expect(readFileSync(alias, "utf8")).toBe("after\n");
      expect(statSync(target).nlink).toBe(1);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("preserves a substituted cleanup target instead of unlinking it", async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "inertia-secure-cleanup-race-")),
    );
    roots.push(root);
    const target = join(root, "example.ts");
    const displaced = join(root, "displaced-replacement.ts");
    writeFileSync(target, "before\n");
    const request = requestFor(
      root,
      "example.ts",
      "replace",
      Buffer.from("after\n"),
    );
    let substituted = false;
    let installed = false;
    process.chdir(root);
    try {
      const result = await performSecureFileOperation(request, {
        afterInstall: () => {
          installed = true;
          throw new Error("Force rollback after install.");
        },
        beforeQuarantine: (name) => {
          if (!installed || name !== "example.ts" || substituted) return;
          substituted = true;
          renameSync(target, displaced);
          writeFileSync(target, "concurrent\n");
        },
      });
      expect(result).toMatchObject({ ok: false, code: "unsafe" });
      expect(substituted).toBe(true);
      expect(readFileSync(target, "utf8")).toBe("concurrent\n");
      expect(readFileSync(displaced, "utf8")).toBe("after\n");
    } finally {
      process.chdir(originalCwd);
    }
  });

  it.skipIf(process.platform === "win32")(
    "preserves a raced-in cleanup symlink at its requested path",
    async () => {
      const root = realpathSync(
        mkdtempSync(join(tmpdir(), "inertia-secure-cleanup-symlink-")),
      );
      roots.push(root);
      const target = join(root, "example.ts");
      const displaced = join(root, "displaced-replacement.ts");
      const concurrent = join(root, "concurrent.ts");
      writeFileSync(target, "before\n");
      writeFileSync(concurrent, "concurrent\n");
      const request = requestFor(
        root,
        "example.ts",
        "replace",
        Buffer.from("after\n"),
      );
      let substituted = false;
      let installed = false;
      process.chdir(root);
      try {
        const result = await performSecureFileOperation(request, {
          afterInstall: () => {
            installed = true;
            throw new Error("Force rollback after install.");
          },
          beforeQuarantine: (name) => {
            if (!installed || name !== "example.ts" || substituted) return;
            substituted = true;
            renameSync(target, displaced);
            symlinkSync("concurrent.ts", target);
          },
        });
        expect(result).toMatchObject({ ok: false, code: "unsafe" });
        expect(substituted).toBe(true);
        expect(lstatSync(target).isSymbolicLink()).toBe(true);
        expect(readFileSync(target, "utf8")).toBe("concurrent\n");
        expect(readFileSync(displaced, "utf8")).toBe("after\n");
      } finally {
        process.chdir(originalCwd);
      }
    },
  );

  it("preserves a raced-in cleanup directory at its requested path", async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "inertia-secure-cleanup-directory-")),
    );
    roots.push(root);
    const target = join(root, "example.ts");
    const displaced = join(root, "displaced-replacement.ts");
    writeFileSync(target, "before\n");
    const request = requestFor(
      root,
      "example.ts",
      "replace",
      Buffer.from("after\n"),
    );
    let substituted = false;
    let installed = false;
    process.chdir(root);
    try {
      const result = await performSecureFileOperation(request, {
        afterInstall: () => {
          installed = true;
          throw new Error("Force rollback after install.");
        },
        beforeQuarantine: (name) => {
          if (!installed || name !== "example.ts" || substituted) return;
          substituted = true;
          renameSync(target, displaced);
          mkdirSync(target);
        },
      });
      expect(result).toMatchObject({ ok: false, code: "unsafe" });
      expect(substituted).toBe(true);
      expect(lstatSync(target).isDirectory()).toBe(true);
      expect(readFileSync(displaced, "utf8")).toBe("after\n");
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("preserves a raced-in cleanup directory link at its requested path", async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "inertia-secure-cleanup-directory-link-")),
    );
    roots.push(root);
    const target = join(root, "example.ts");
    const displaced = join(root, "displaced-replacement.ts");
    const concurrentDirectory = join(root, "concurrent-directory");
    mkdirSync(concurrentDirectory);
    writeFileSync(join(concurrentDirectory, "marker.txt"), "concurrent\n");
    writeFileSync(target, "before\n");
    const request = requestFor(
      root,
      "example.ts",
      "replace",
      Buffer.from("after\n"),
    );
    let substituted = false;
    let installed = false;
    process.chdir(root);
    try {
      const result = await performSecureFileOperation(request, {
        afterInstall: () => {
          installed = true;
          throw new Error("Force rollback after install.");
        },
        beforeQuarantine: (name) => {
          if (!installed || name !== "example.ts" || substituted) return;
          substituted = true;
          renameSync(target, displaced);
          symlinkSync(
            concurrentDirectory,
            target,
            process.platform === "win32" ? "junction" : "dir",
          );
        },
      });
      expect(result).toMatchObject({ ok: false, code: "unsafe" });
      expect(substituted).toBe(true);
      expect(lstatSync(target).isSymbolicLink()).toBe(true);
      expect(readFileSync(join(target, "marker.txt"), "utf8"))
        .toBe("concurrent\n");
      expect(readFileSync(displaced, "utf8")).toBe("after\n");
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("restores the verified backup when the staged source is substituted before install", async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "inertia-secure-stage-install-race-")),
    );
    roots.push(root);
    const target = join(root, "example.ts");
    const displacedStage = join(root, "displaced-stage");
    writeFileSync(target, "before\n");
    const request = requestFor(
      root,
      "example.ts",
      "replace",
      Buffer.from("after\n"),
    );
    process.chdir(root);
    try {
      const result = await performSecureFileOperation(request, {
        beforeInstallLink: () => {
          const stage = readdirSync(root).find((name) => name.endsWith(".stage"));
          if (!stage) throw new Error("Expected a staged save.");
          renameSync(join(root, stage), displacedStage);
          writeFileSync(join(root, stage), "attacker\n");
        },
      });
      expect(result).toMatchObject({ ok: false, code: "unsafe" });
      expect(readFileSync(target, "utf8")).toBe("before\n");
      expect(readFileSync(displacedStage, "utf8")).toBe("after\n");
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("restores the verified backup during recovery when the stage was substituted", async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "inertia-secure-stage-recovery-race-")),
    );
    roots.push(root);
    const target = join(root, "example.ts");
    const displacedStage = join(root, "displaced-stage");
    writeFileSync(target, "before\n");
    const request = requestFor(
      root,
      "example.ts",
      "replace",
      Buffer.from("after\n"),
    );
    process.chdir(root);
    try {
      await expect(performSecureFileOperation(request, {
        stopAfter: "claim",
      })).resolves.toMatchObject({ ok: false, code: "unavailable" });
      const stage = readdirSync(root).find((name) => name.endsWith(".stage"));
      if (!stage) throw new Error("Expected a staged save.");
      renameSync(join(root, stage), displacedStage);
      writeFileSync(join(root, stage), "attacker\n");

      const recovery = await performSecureFileOperation({
        operation: "recover",
        root: request.root,
        rootIdentity: request.rootIdentity,
        parentIdentities: request.parentIdentities,
        path: request.path,
      });
      expect(recovery).toEqual({ ok: true, operation: "recover" });
      expect(readFileSync(target, "utf8")).toBe("before\n");
      expect(readFileSync(displacedStage, "utf8")).toBe("after\n");
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("rejects a substituted backup during restart recovery", async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "inertia-secure-backup-recovery-race-")),
    );
    roots.push(root);
    const target = join(root, "example.ts");
    const displacedBackup = join(root, "displaced-backup");
    writeFileSync(target, "before\n");
    const request = requestFor(
      root,
      "example.ts",
      "replace",
      Buffer.from("after\n"),
    );
    process.chdir(root);
    try {
      await expect(performSecureFileOperation(request, {
        stopAfter: "claim",
      })).resolves.toMatchObject({ ok: false, code: "unavailable" });
      const backup = readdirSync(root).find((name) => name.endsWith(".backup"));
      if (!backup) throw new Error("Expected a secure-save backup.");
      renameSync(backup, displacedBackup);
      writeFileSync(backup, "substituted\n");

      const recovery = await performSecureFileOperation({
        operation: "recover",
        root: request.root,
        rootIdentity: request.rootIdentity,
        parentIdentities: request.parentIdentities,
        path: request.path,
      });
      expect(recovery).toMatchObject({ ok: false, code: "unsafe" });
      expect(() => lstatSync(target)).toThrow();
      expect(readFileSync(backup, "utf8")).toBe("substituted\n");
      expect(readFileSync(displacedBackup, "utf8")).toBe("before\n");
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("rejects a backup that gains another hard link before recovery", async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "inertia-secure-backup-link-race-")),
    );
    roots.push(root);
    const target = join(root, "example.ts");
    const backupAlias = join(root, "backup-alias");
    writeFileSync(target, "before\n");
    const request = requestFor(
      root,
      "example.ts",
      "replace",
      Buffer.from("after\n"),
    );
    process.chdir(root);
    try {
      await expect(performSecureFileOperation(request, {
        stopAfter: "claim",
      })).resolves.toMatchObject({ ok: false, code: "unavailable" });
      const backup = readdirSync(root).find((name) => name.endsWith(".backup"));
      if (!backup) throw new Error("Expected a secure-save backup.");
      linkSync(backup, backupAlias);

      const recovery = await performSecureFileOperation({
        operation: "recover",
        root: request.root,
        rootIdentity: request.rootIdentity,
        parentIdentities: request.parentIdentities,
        path: request.path,
      });
      expect(recovery).toMatchObject({ ok: false, code: "unsafe" });
      expect(() => lstatSync(target)).toThrow();
      expect(readFileSync(backupAlias, "utf8")).toBe("before\n");
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("fails closed when the rollback backup is substituted", async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "inertia-secure-backup-rollback-race-")),
    );
    roots.push(root);
    const target = join(root, "example.ts");
    const displacedBackup = join(root, "displaced-backup");
    writeFileSync(target, "before\n");
    const request = requestFor(
      root,
      "example.ts",
      "replace",
      Buffer.from("after\n"),
    );
    process.chdir(root);
    try {
      const result = await performSecureFileOperation(request, {
        afterClaim: () => {
          const backup = readdirSync(root).find((name) => (
            name.endsWith(".backup")
          ));
          if (!backup) throw new Error("Expected a secure-save backup.");
          renameSync(backup, displacedBackup);
          writeFileSync(backup, "substituted\n");
          throw new Error("Force rollback.");
        },
      });
      expect(result).toMatchObject({ ok: false, code: "unsafe" });
      expect(() => lstatSync(target)).toThrow();
      expect(readFileSync(displacedBackup, "utf8")).toBe("before\n");
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("does not unlink a substituted hard-link probe", async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "inertia-secure-probe-race-")),
    );
    roots.push(root);
    const target = join(root, "example.ts");
    const displaced = join(root, "displaced-probe");
    writeFileSync(target, "before\n");
    const request = requestFor(
      root,
      "example.ts",
      "replace",
      Buffer.from("after\n"),
    );
    let probeName = "";
    process.chdir(root);
    try {
      const result = await performSecureFileOperation(request, {
        beforeQuarantine: (name) => {
          if (!name.endsWith(".probe") || probeName) return;
          probeName = name;
          renameSync(join(root, name), displaced);
          writeFileSync(join(root, name), "concurrent probe\n");
        },
      });
      expect(result).toMatchObject({ ok: false, code: "unsafe" });
      expect(readFileSync(join(root, probeName), "utf8"))
        .toBe("concurrent probe\n");
      expect(readFileSync(displaced, "utf8")).toBe("after\n");
      expect(readFileSync(target, "utf8")).toBe("before\n");
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("pins the published journal inode through same-process cleanup", async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "inertia-secure-journal-race-")),
    );
    roots.push(root);
    const target = join(root, "example.ts");
    const displacedJournal = join(root, "displaced-journal");
    writeFileSync(target, "before\n");
    const request = requestFor(
      root,
      "example.ts",
      "replace",
      Buffer.from("after\n"),
    );
    let journalName = "";
    process.chdir(root);
    try {
      const result = await performSecureFileOperation(request, {
        afterInstall: () => {
          const journal = readdirSync(root).find((name) => (
            name.endsWith(".journal")
          ));
          if (!journal) throw new Error("Expected a published journal.");
          journalName = journal;
          const content = readFileSync(join(root, journal));
          renameSync(join(root, journal), displacedJournal);
          writeFileSync(join(root, journal), content);
        },
      });
      expect(result).toMatchObject({ ok: false, code: "unsafe" });
      expect(readFileSync(join(root, journalName))).toEqual(
        readFileSync(displacedJournal),
      );
      expect(readFileSync(target, "utf8")).toBe("after\n");
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("does not modify a target that gains another hard link before save", async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "inertia-secure-file-link-race-")),
    );
    roots.push(root);
    const target = join(root, "example.ts");
    const alias = join(root, "alias.ts");
    writeFileSync(target, "before\n");
    const request = requestFor(
      root,
      "example.ts",
      "replace",
      Buffer.from("edited\n"),
    );
    process.chdir(root);
    try {
      const result = await performSecureFileOperation(request, {
        beforeClaim: () => linkSync(target, alias),
      });
      expect(result).toMatchObject({ ok: false, code: "unsafe" });
      expect(readFileSync(target, "utf8")).toBe("before\n");
      expect(readFileSync(alias, "utf8")).toBe("before\n");
    } finally {
      process.chdir(originalCwd);
    }
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

  it.each(["claim", "install"] as const)(
    "recovers a terminated transaction after %s",
    async (stopAfter) => {
      const root = realpathSync(
        mkdtempSync(join(tmpdir(), "inertia-secure-recover-")),
      );
      roots.push(root);
      const target = join(root, "example.ts");
      writeFileSync(target, "before\n");
      const request = requestFor(
        root,
        "example.ts",
        "replace",
        Buffer.from("after\n"),
      );
      process.chdir(root);
      try {
        const interrupted = await performSecureFileOperation(request, {
          stopAfter,
        });
        expect(interrupted).toMatchObject({
          ok: false,
          code: "unavailable",
        });
        expect(readdirSync(root).some((name) => (
          name.startsWith(".inertia-save-")
        ))).toBe(true);

        if (stopAfter === "claim") {
          const recovery = await performSecureFileOperation({
            operation: "recover",
            root: request.root,
            rootIdentity: request.rootIdentity,
            parentIdentities: request.parentIdentities,
            path: request.path,
          });
          expect(recovery).toEqual({ ok: true, operation: "recover" });
        } else {
          await expect(recoverSecureFileOperation(request)).resolves.toBe(true);
        }
        expect(readFileSync(target, "utf8")).toBe(
          stopAfter === "claim" ? "before\n" : "after\n",
        );
        expect(readdirSync(root).some((name) => (
          name.startsWith(".inertia-save-")
        ))).toBe(false);
      } finally {
        process.chdir(originalCwd);
      }
    },
  );

  it("recovers a journal published immediately before worker termination", async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "inertia-secure-journal-published-")),
    );
    roots.push(root);
    const target = join(root, "example.ts");
    writeFileSync(target, "before\n");
    const request = requestFor(
      root,
      "example.ts",
      "replace",
      Buffer.from("after\n"),
    );
    process.chdir(root);
    try {
      const interrupted = await performSecureFileOperation(request, {
        stopAfter: "journal-published",
      });
      expect(interrupted).toMatchObject({
        ok: false,
        code: "unavailable",
      });
      expect(readFileSync(target, "utf8")).toBe("before\n");
      const pendingName = readdirSync(root).find((name) => (
        name.endsWith(".pending")
      ));
      const journalName = readdirSync(root).find((name) => (
        name.endsWith(".journal")
      ));
      expect(pendingName).toBeTruthy();
      expect(journalName).toBeTruthy();
      const pending = lstatSync(join(root, pendingName!), { bigint: true });
      const journal = lstatSync(join(root, journalName!), { bigint: true });
      expect(identity(pending)).toEqual(identity(journal));
      expect(Number(pending.nlink)).toBe(2);

      const recovery = await performSecureFileOperation({
        operation: "recover",
        root: request.root,
        rootIdentity: request.rootIdentity,
        parentIdentities: request.parentIdentities,
        path: request.path,
      });
      expect(recovery).toEqual({ ok: true, operation: "recover" });
      expect(readFileSync(target, "utf8")).toBe("before\n");
      expect(readdirSync(root).some((name) => (
        name.startsWith(".inertia-save-")
      ))).toBe(false);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("recovers when the worker stops after quarantining the claimed target", async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "inertia-secure-claim-quarantine-")),
    );
    roots.push(root);
    const target = join(root, "example.ts");
    writeFileSync(target, "before\n");
    const request = requestFor(
      root,
      "example.ts",
      "replace",
      Buffer.from("after\n"),
    );
    process.chdir(root);
    try {
      const interrupted = await performSecureFileOperation(request, {
        stopAfter: "claim-quarantine",
      });
      expect(interrupted).toMatchObject({
        ok: false,
        code: "unavailable",
      });
      expect(() => lstatSync(target)).toThrow();
      expect(readdirSync(root).some((name) => (
        name.endsWith(".target.quarantine")
      ))).toBe(true);

      const recovery = await performSecureFileOperation({
        operation: "recover",
        root: request.root,
        rootIdentity: request.rootIdentity,
        parentIdentities: request.parentIdentities,
        path: request.path,
      });
      expect(recovery).toEqual({ ok: true, operation: "recover" });
      expect(readFileSync(target, "utf8")).toBe("before\n");
      expect(readdirSync(root).some((name) => (
        name.startsWith(".inertia-save-")
      ))).toBe(false);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("finishes rollback after the installed replacement is quarantined", async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "inertia-secure-rollback-quarantine-")),
    );
    roots.push(root);
    const target = join(root, "example.ts");
    writeFileSync(target, "before\n");
    const request = requestFor(
      root,
      "example.ts",
      "replace",
      Buffer.from("after\n"),
    );
    process.chdir(root);
    try {
      const interrupted = await performSecureFileOperation(request, {
        afterInstall: () => {
          throw new Error("Force secure save rollback.");
        },
        stopAfter: "rollback-target-quarantine",
      });
      expect(interrupted).toMatchObject({
        ok: false,
        code: "unavailable",
      });
      expect(() => lstatSync(target)).toThrow();
      expect(readdirSync(root).some((name) => (
        name.endsWith(".rollback-target.quarantine")
      ))).toBe(true);

      const recovery = await performSecureFileOperation({
        operation: "recover",
        root: request.root,
        rootIdentity: request.rootIdentity,
        parentIdentities: request.parentIdentities,
        path: request.path,
      });
      expect(recovery).toEqual({ ok: true, operation: "recover" });
      expect(readFileSync(target, "utf8")).toBe("before\n");
      expect(readdirSync(root).some((name) => (
        name.startsWith(".inertia-save-")
      ))).toBe(false);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("rejects a linked rollback replacement quarantine", async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "inertia-secure-rollback-quarantine-link-")),
    );
    roots.push(root);
    const target = join(root, "example.ts");
    const alias = join(root, "rollback-alias.ts");
    writeFileSync(target, "before\n");
    const request = requestFor(
      root,
      "example.ts",
      "replace",
      Buffer.from("after\n"),
    );
    process.chdir(root);
    try {
      await expect(performSecureFileOperation(request, {
        afterInstall: () => {
          throw new Error("Force secure save rollback.");
        },
        stopAfter: "rollback-target-quarantine",
      })).resolves.toMatchObject({ ok: false, code: "unavailable" });
      const quarantine = readdirSync(root).find((name) => (
        name.endsWith(".rollback-target.quarantine")
      ));
      expect(quarantine).toBeTruthy();
      linkSync(join(root, quarantine!), alias);

      const recoveryRequest = {
        operation: "recover" as const,
        root: request.root,
        rootIdentity: request.rootIdentity,
        parentIdentities: request.parentIdentities,
        path: request.path,
      };
      await expect(performSecureFileOperation(recoveryRequest))
        .resolves.toMatchObject({ ok: false, code: "unsafe" });
      expect(() => lstatSync(target)).toThrow();

      rmSync(alias);
      await expect(performSecureFileOperation(recoveryRequest))
        .resolves.toEqual({ ok: true, operation: "recover" });
      expect(readFileSync(target, "utf8")).toBe("before\n");
      expect(readdirSync(root).some((name) => (
        name.startsWith(".inertia-save-")
      ))).toBe(false);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("rejects an extra hard link added to a quarantined stage", async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "inertia-secure-stage-quarantine-link-")),
    );
    roots.push(root);
    const target = join(root, "example.ts");
    const alias = join(root, "stage-alias.ts");
    writeFileSync(target, "before\n");
    const request = requestFor(
      root,
      "example.ts",
      "replace",
      Buffer.from("after\n"),
    );
    process.chdir(root);
    try {
      const interrupted = await performSecureFileOperation(request, {
        stopAfter: "stage-quarantine",
      });
      expect(interrupted).toMatchObject({
        ok: false,
        code: "unavailable",
      });
      expect(readFileSync(target, "utf8")).toBe("after\n");
      const quarantineName = readdirSync(root).find((name) => (
        name.endsWith(".stage.quarantine")
      ));
      expect(quarantineName).toBeTruthy();
      linkSync(join(root, quarantineName!), alias);

      const recoveryRequest = {
        operation: "recover" as const,
        root: request.root,
        rootIdentity: request.rootIdentity,
        parentIdentities: request.parentIdentities,
        path: request.path,
      };
      const rejected = await performSecureFileOperation(recoveryRequest);
      expect(rejected).toMatchObject({ ok: false, code: "unsafe" });
      expect(readFileSync(target, "utf8")).toBe("after\n");

      rmSync(alias);
      const recovered = await performSecureFileOperation(recoveryRequest);
      expect(recovered).toEqual({ ok: true, operation: "recover" });
      expect(readFileSync(target, "utf8")).toBe("after\n");
      expect(readdirSync(root).some((name) => (
        name.startsWith(".inertia-save-")
      ))).toBe(false);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("recovers when the worker stops after quarantining its journal", async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "inertia-secure-journal-quarantine-")),
    );
    roots.push(root);
    const target = join(root, "example.ts");
    writeFileSync(target, "before\n");
    const request = requestFor(
      root,
      "example.ts",
      "replace",
      Buffer.from("after\n"),
    );
    process.chdir(root);
    try {
      const interrupted = await performSecureFileOperation(request, {
        stopAfter: "journal-quarantine",
      });
      expect(interrupted).toMatchObject({
        ok: false,
        code: "unavailable",
      });
      expect(readFileSync(target, "utf8")).toBe("after\n");
      expect(readdirSync(root).some((name) => (
        name.endsWith(".journal.quarantine")
      ))).toBe(true);

      const recovery = await performSecureFileOperation({
        operation: "recover",
        root: request.root,
        rootIdentity: request.rootIdentity,
        parentIdentities: request.parentIdentities,
        path: request.path,
      });
      expect(recovery).toEqual({ ok: true, operation: "recover" });
      expect(readFileSync(target, "utf8")).toBe("after\n");
      expect(readdirSync(root).some((name) => (
        name.startsWith(".inertia-save-")
      ))).toBe(false);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("reconciles an installed transaction before the first read after restart", async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "inertia-secure-read-recovery-")),
    );
    roots.push(root);
    const target = join(root, "example.ts");
    writeFileSync(target, "before\n");
    const replacementRequest = requestFor(
      root,
      "example.ts",
      "replace",
      Buffer.from("after\n"),
    );
    process.chdir(root);
    try {
      const interrupted = await performSecureFileOperation(
        replacementRequest,
        { stopAfter: "install" },
      );
      expect(interrupted).toMatchObject({
        ok: false,
        code: "unavailable",
      });

      const read = await performSecureFileOperation(
        requestFor(root, "example.ts", "read"),
      );
      expect(read).toMatchObject({
        ok: true,
        operation: "read",
        contentBase64: Buffer.from("after\n").toString("base64"),
      });
      expect(readdirSync(root).some((name) => (
        name.startsWith(".inertia-save-")
      ))).toBe(false);
    } finally {
      process.chdir(originalCwd);
    }
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

  it.skipIf(process.platform === "win32").each(
    ["read", "replace"] as const,
  )(
    "rejects %s when the pinned parent was moved and substituted",
    async (operation) => {
      const root = realpathSync(
        mkdtempSync(join(tmpdir(), "inertia-secure-parent-race-")),
      );
      const outside = realpathSync(
        mkdtempSync(join(tmpdir(), "inertia-secure-parent-outside-")),
      );
      const moved = join(outside, "moved-src");
      roots.push(root, outside);
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, "src", "example.ts"), "inside\n");
      const request = requestFor(
        root,
        "src/example.ts",
        operation,
        Buffer.from("edited\n"),
      );
      process.chdir(join(root, "src"));
      renameSync(join(root, "src"), moved);
      symlinkSync(
        moved,
        join(root, "src"),
        process.platform === "win32" ? "junction" : "dir",
      );
      try {
        expect(await performSecureFileOperation(request)).toMatchObject({
          ok: false,
          code: "unsafe",
        });
        expect(readFileSync(join(moved, "example.ts"), "utf8"))
          .toBe("inside\n");
      } finally {
        process.chdir(originalCwd);
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "rolls back when the pinned parent moves outside after the target is claimed",
    async () => {
      const root = realpathSync(
        mkdtempSync(join(tmpdir(), "inertia-secure-claimed-parent-")),
      );
      const outside = realpathSync(
        mkdtempSync(join(tmpdir(), "inertia-secure-claimed-outside-")),
      );
      const moved = join(outside, "moved-src");
      roots.push(root, outside);
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, "src", "example.ts"), "before\n");
      const request = requestFor(
        root,
        "src/example.ts",
        "replace",
        Buffer.from("after\n"),
      );
      process.chdir(join(root, "src"));
      try {
        const result = await performSecureFileOperation(request, {
          afterClaim: () => {
            renameSync(join(root, "src"), moved);
            symlinkSync(moved, join(root, "src"), "dir");
          },
        });
        expect(result).toMatchObject({ ok: false, code: "unsafe" });
        expect(readFileSync(join(moved, "example.ts"), "utf8"))
          .toBe("before\n");
        expect(readdirSync(moved).some((name) => (
          name.startsWith(".inertia-save-")
        ))).toBe(false);
      } finally {
        process.chdir(originalCwd);
      }
    },
  );

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
