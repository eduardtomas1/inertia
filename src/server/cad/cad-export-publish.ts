import { spawn } from "node:child_process";

import {
  FILE_OPEN_DIRECTORY,
  FILE_OPEN_NO_FOLLOW,
} from "../../node/platform-file-open-flags";

const PUBLISH_TIMEOUT_MS = 15_000;
const MAX_PUBLISH_STDOUT_BYTES = 4_096;

export interface PinnedExportPublishInput {
  readonly canonicalAncestor: string;
  readonly dev: string;
  readonly ino: string;
  readonly subdirectories: readonly string[];
  readonly fileName: string;
  readonly produced: string;
  readonly replacing: boolean;
}

const PINNED_PUBLISH_SCRIPT = `
  const { randomBytes } = require("node:crypto");
  const { constants } = require("node:fs");
  const { lstat, mkdir, open, readFile, realpath, rename, rm } = require("node:fs/promises");

  const DIRECTORY_ONLY = ${FILE_OPEN_DIRECTORY};
  const NO_FOLLOW = ${FILE_OPEN_NO_FOLLOW};
  const WINDOWS = process.platform === "win32";

  function samePath(left, right) {
    return WINDOWS ? left.toLowerCase() === right.toLowerCase() : left === right;
  }

  function safeSegment(segment) {
    return typeof segment === "string"
      && segment.length > 0
      && segment !== "."
      && segment !== ".."
      && !segment.includes("/")
      && !segment.includes("\\\\");
  }

  async function writeNewFile(name, bytes) {
    const handle = await open(name, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW);
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
        if (bytesWritten <= 0) throw new Error("short-write");
        offset += bytesWritten;
      }
      await handle.sync().catch(() => undefined);
    } finally {
      await handle.close();
    }
  }

  async function run() {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));

    // Verify the kernel-pinned cwd matches the approved ancestor identity before touching anything.
    const root = await lstat(".", { bigint: true });
    const rootCanonical = await realpath(".");
    if (
      !root.isDirectory()
      || String(root.dev) !== input.dev
      || String(root.ino) !== input.ino
      || !samePath(rootCanonical, input.canonicalAncestor)
    ) {
      throw new Error("ancestor-identity-changed");
    }

    // Create and descend one verified, non-symlink segment at a time inside the pinned cwd.
    for (const segment of input.subdirectories) {
      if (!safeSegment(segment)) throw new Error("invalid-segment");
      try {
        await mkdir(segment);
      } catch (error) {
        if (!error || error.code !== "EEXIST") throw error;
      }
      const entry = await lstat(segment, { bigint: true });
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error("parent-symlink");
      }
      if (!WINDOWS) {
        const dirHandle = await open(segment, constants.O_RDONLY | DIRECTORY_ONLY | NO_FOLLOW);
        try {
          const opened = await dirHandle.stat({ bigint: true });
          if (!opened.isDirectory() || opened.dev !== entry.dev || opened.ino !== entry.ino) {
            throw new Error("parent-changed");
          }
        } finally {
          await dirHandle.close();
        }
      }
      process.chdir(segment);
      const pinned = await lstat(".", { bigint: true });
      if (!pinned.isDirectory() || pinned.dev !== entry.dev || pinned.ino !== entry.ino) {
        throw new Error("parent-changed");
      }
    }

    if (!safeSegment(input.fileName)) throw new Error("invalid-filename");
    const bytes = await readFile(input.produced);

    if (!input.replacing) {
      await writeNewFile(input.fileName, bytes);
    } else {
      const existing = await lstat(input.fileName).catch(() => undefined);
      if (existing !== undefined && (existing.isSymbolicLink() || !existing.isFile())) {
        throw new Error("target-symlink");
      }
      const temporary = "." + input.fileName + "." + randomBytes(6).toString("hex") + ".tmp";
      await writeNewFile(temporary, bytes);
      try {
        const current = await lstat(input.fileName).catch(() => undefined);
        if (current !== undefined && (current.isSymbolicLink() || !current.isFile())) {
          throw new Error("target-symlink");
        }
        await rename(temporary, input.fileName);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    }

    process.stdout.write(JSON.stringify({ ok: true }));
  }

  run().catch((error) => {
    process.stderr.write(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
`;

/**
 * Publishes an approved CAD export from a child process whose working directory
 * is pinned to the verified ancestor directory, creating any missing nested
 * segments one non-symlink step at a time and publishing by single relative name.
 */
export async function publishToPinnedDirectory(
  input: PinnedExportPublishInput,
): Promise<void> {
  const payload = JSON.stringify(input);
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ["--no-warnings", "-e", PINNED_PUBLISH_SCRIPT], {
      cwd: input.canonicalAncestor,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let settled = false;
    let stdoutBytes = 0;
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectPromise(error);
      else resolvePromise();
    };

    const timer = setTimeout(() => {
      try {
        child.kill(process.platform === "win32" ? undefined : "SIGKILL");
      } catch {
        // Ignore teardown errors on already-exited processes.
      }
      finish(new Error("Pinned CAD export publication timed out."));
    }, PUBLISH_TIMEOUT_MS);
    timer.unref();

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk, "utf8");
      if (stdoutBytes <= MAX_PUBLISH_STDOUT_BYTES) stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderrChunks.length < 16) stderrChunks.push(chunk);
    });
    child.once("error", (error) => {
      finish(error instanceof Error ? error : new Error(String(error)));
    });
    child.once("close", (code) => {
      let receipt: unknown = null;
      try {
        receipt = JSON.parse(stdoutChunks.join(""));
      } catch {
        receipt = null;
      }
      if (
        code === 0
        && typeof receipt === "object"
        && receipt !== null
        && "ok" in receipt
        && receipt.ok === true
      ) {
        finish();
        return;
      }
      const detail = stderrChunks.join("").trim();
      finish(new Error(detail || "Pinned CAD export publication failed."));
    });

    child.stdin.end(payload);
  });
}
