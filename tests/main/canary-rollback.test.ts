import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CanaryRollbackManager,
  writeBufferCompletely,
} from "../../src/main/canary-rollback";

const roots: string[] = [];
const packageName = "Inertia-Canary-1.2.3.AppImage";
const packageBytes = Buffer.from("verified-canary-package", "utf8");
const packageDigest = createHash("sha256").update(packageBytes).digest("hex");

function root(): string {
  const path = mkdtempSync(join(tmpdir(), "inertia-canary-rollback-"));
  roots.push(path);
  return path;
}

function manager(options: {
  fetch?: typeof globalThis.fetch;
  openPath?: (path: string) => Promise<string>;
  revealPath?: (path: string) => void;
  activeAppImagePath?: string | null;
  userDataDirectory?: string;
  version?: string;
  timeoutMs?: number;
  platform?: NodeJS.Platform;
  architecture?: "arm64" | "x64";
} = {}): CanaryRollbackManager {
  const userDataDirectory = options.userDataDirectory ?? root();
  const activeAppImagePath = options.activeAppImagePath === undefined
    ? join(userDataDirectory, "Inertia-Canary-current.AppImage")
    : options.activeAppImagePath;
  if (activeAppImagePath) writeFileSync(activeAppImagePath, "current-canary");
  const fetch = options.fetch ?? vi.fn<typeof globalThis.fetch>(async (input) => {
    const url = String(input);
    return url.endsWith("SHA256SUMS.txt")
      ? new Response(`${packageDigest}  ${packageName}\n`)
      : new Response(packageBytes, {
          headers: { "content-length": String(packageBytes.length) },
        });
  });
  return new CanaryRollbackManager({
    channel: "canary",
    version: options.version ?? "1.2.3",
    platform: options.platform ?? "linux",
    architecture: options.architecture ?? "x64",
    userDataDirectory,
    fetch,
    openPath: options.openPath ?? vi.fn(async () => ""),
    revealPath: options.revealPath ?? vi.fn(),
    ...(activeAppImagePath === null ? {} : { activeAppImagePath }),
    now: () => new Date("2030-01-02T03:04:05.000Z"),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Canary last-known-good rollback", () => {
  it("completes short file writes and rejects writers that stop progressing", async () => {
    const written = Buffer.alloc(packageBytes.length);
    const shortWriter = {
      write: vi.fn(async (
        buffer: Uint8Array,
        offset: number,
        length: number,
      ) => {
        const bytesWritten = Math.min(3, length);
        Buffer.from(buffer).copy(written, offset, offset, offset + bytesWritten);
        return { bytesWritten };
      }),
    };
    await writeBufferCompletely(shortWriter, packageBytes);
    expect(written).toEqual(packageBytes);
    expect(shortWriter.write).toHaveBeenCalledTimes(8);
    await expect(writeBufferCompletely({
      write: vi.fn(async () => ({ bytesWritten: 0 })),
    }, packageBytes)).rejects.toThrow("safe progress");
  });

  it("aborts stalled downloads and permits a bounded retry", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      }));
    const subject = manager({ fetch, timeoutMs: 10 });
    await expect(subject.prepare()).rejects.toThrow("checksum download timed out");
    await expect(subject.prepare()).rejects.toThrow("checksum download timed out");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("aborts a stalled package body without recording partial state", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      if (String(input).endsWith("SHA256SUMS.txt")) {
        return new Response(`${packageDigest}  ${packageName}\n`);
      }
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener("abort", () => {
            controller.error(new DOMException("aborted", "AbortError"));
          }, { once: true });
        },
      }));
    });
    const subject = manager({ fetch, timeoutMs: 10 });
    await expect(subject.prepare()).rejects.toThrow("package download timed out");
    await expect(subject.current()).resolves.toMatchObject({ state: "not-prepared" });
    expect(readdirSync(join(subject.options.userDataDirectory, "canary-rollback")))
      .toEqual([]);
  });

  it("reveals a reverified Linux AppImage with explicit replacement instructions", async () => {
    const opened = vi.fn(async () => "");
    const revealed = vi.fn();
    const subject = manager({ openPath: opened, revealPath: revealed });

    await expect(subject.current()).resolves.toMatchObject({ state: "not-prepared" });
    await expect(subject.prepare()).resolves.toEqual({
      state: "ready",
      version: "1.2.3",
      message: "Verified Canary 1.2.3 is retained for rollback.",
    });
    const directory = join(subject.options.userDataDirectory, "canary-rollback");
    expect(readFileSync(join(directory, packageName))).toEqual(packageBytes);
    expect(readdirSync(directory).sort()).toEqual([
      packageName,
      "last-known-good.json",
    ]);

    await expect(subject.open()).resolves.toMatchObject({
      state: "ready",
      version: "1.2.3",
      message: expect.stringMatching(
        /^Revealed the verified Canary 1\.2\.3 AppImage\. Quit Canary, replace the active AppImage at .+ with the revealed file, keep that destination executable, then reopen Canary\.$/u,
      ),
    });
    expect(revealed).toHaveBeenCalledWith(join(directory, packageName));
    expect(opened).not.toHaveBeenCalled();
  });

  it("opens a reverified rollback installer outside Linux", async () => {
    const userDataDirectory = root();
    await manager({ userDataDirectory }).prepare();
    const opened = vi.fn(async () => "");
    const revealed = vi.fn();
    const subject = manager({
      userDataDirectory,
      platform: "darwin",
      openPath: opened,
      revealPath: revealed,
    });
    await expect(subject.open()).resolves.toMatchObject({
      state: "ready",
      version: "1.2.3",
      message: "Opened the verified Canary 1.2.3 rollback package.",
    });
    expect(opened).toHaveBeenCalledWith(join(
      userDataDirectory,
      "canary-rollback",
      packageName,
    ));
    expect(revealed).not.toHaveBeenCalled();
  });

  it("retains the architecture-qualified ARM64 rollback package", async () => {
    const armPackage = "Inertia.Canary.Setup.1.2.3.arm64.exe";
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) =>
      String(input).endsWith("SHA256SUMS.txt")
        ? new Response(`${packageDigest}  ${armPackage}\n`)
        : new Response(packageBytes));
    const subject = manager({
      architecture: "arm64",
      fetch,
      platform: "win32",
    });

    await expect(subject.prepare()).resolves.toMatchObject({ state: "ready" });
    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([
      "https://github.com/eduardtomas1/inertia/releases/download/canary-v1.2.3/SHA256SUMS.txt",
      `https://github.com/eduardtomas1/inertia/releases/download/canary-v1.2.3/${armPackage}`,
    ]);
    expect(readFileSync(join(
      subject.options.userDataDirectory,
      "canary-rollback",
      armPackage,
    ))).toEqual(packageBytes);
  });

  it("does not reveal or launch Linux rollback without a verified active AppImage", async () => {
    const opened = vi.fn(async () => "");
    const revealed = vi.fn();
    const subject = manager({
      activeAppImagePath: null,
      openPath: opened,
      revealPath: revealed,
    });
    await subject.prepare();
    await expect(subject.open()).resolves.toEqual({
      state: "failed",
      version: "1.2.3",
      message: "The active Canary AppImage path could not be verified; no rollback file was opened.",
    });
    expect(opened).not.toHaveBeenCalled();
    expect(revealed).not.toHaveBeenCalled();
  });

  it("keeps failed updates bounded and never records a digest mismatch", async () => {
    const subject = manager({
      fetch: vi.fn<typeof globalThis.fetch>(async (input) => String(input).endsWith("SHA256SUMS.txt")
        ? new Response(`${"0".repeat(64)}  ${packageName}\n`)
        : new Response(packageBytes)),
    });
    await expect(subject.prepare()).rejects.toThrow("digest did not match");
    await expect(subject.current()).resolves.toMatchObject({ state: "not-prepared" });
    expect(readdirSync(join(subject.options.userDataDirectory, "canary-rollback")))
      .toEqual([]);
  });

  it("preserves the verified last-known-good package when the next preparation fails", async () => {
    const userDataDirectory = root();
    const previous = manager({ userDataDirectory });
    await previous.prepare();

    const next = manager({
      userDataDirectory,
      version: "1.2.4",
      fetch: vi.fn<typeof globalThis.fetch>(async () => new Response("unavailable", {
        status: 503,
      })),
    });
    await expect(next.prepare()).rejects.toThrow("checksum unavailable");
    await expect(previous.current()).resolves.toMatchObject({
      state: "ready",
      version: "1.2.3",
    });
    expect(readFileSync(join(userDataDirectory, "canary-rollback", packageName)))
      .toEqual(packageBytes);
  });

  it("fails closed after a retained package is tampered with", async () => {
    const subject = manager();
    await subject.prepare();
    const path = join(subject.options.userDataDirectory, "canary-rollback", packageName);
    writeFileSync(path, "substituted");
    await expect(subject.current()).resolves.toMatchObject({
      state: "failed",
      message: "The retained Canary rollback package failed verification.",
    });
    await expect(subject.open()).resolves.toMatchObject({ state: "failed" });
  });
});
