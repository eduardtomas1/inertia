import * as filesystem from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestShutdownTrace, TEST_SHUTDOWN_TRACE_BYTES, TEST_SHUTDOWN_TRACE_FILE } from
  "../../src/server/runtime/test-shutdown-trace";
import { closeElectronFixtureBounded, type ElectronFixtureCloseError } from
  "../e2e/support/electron-app-lifecycle";
import { attachRuntimeCleanupEvidence, attachRuntimeShutdownTrace, readRuntimeShutdownTrace } from
  "../e2e/support/runtime-shutdown-trace-evidence";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, lstat: vi.fn(actual.lstat) };
});

const valid = {
  deadlinePhase: "server cleanup", elapsedMs: 12_000,
  owners: [{ owner: "http-server", startMs: 5, endMs: null, state: "started" }],
};

describe("failure-only runtime shutdown trace evidence", () => {
  let root: string;
  let data: string;
  let path: string;
  const signal = () => new AbortController().signal;
  beforeEach(async () => {
    root = await filesystem.mkdtemp(join(tmpdir(), "inertia-trace-evidence-"));
    data = join(root, "data");
    path = join(data, TEST_SHUTDOWN_TRACE_FILE);
    await filesystem.mkdir(data);
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.mocked(filesystem.lstat).mockReset();
    vi.unstubAllEnvs();
    await filesystem.rm(root, { recursive: true, force: true });
  });

  it("collects the real worker payload before deletion and preserves the original cleanup failure", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("INERTIA_RUNTIME_SHUTDOWN_TRACE", "1");
    const trace = createTestShutdownTrace(data);
    trace.observe("store", () => undefined);
    void trace.observe("http-server", () => new Promise(() => undefined));
    trace.failure("server cleanup");
    const attach = vi.fn(async (_name: string, _options: { body?: Buffer | string }) => undefined);
    const original = new Error("original cleanup failure");
    const failure = await closeElectronFixtureBounded({
      current: null, requestRuntimeQuit: async () => null,
      waitForRuntimeExit: async () => undefined,
      closeServer: async () => { throw original; },
      onCleanupFailure: async (aborted) => attachRuntimeShutdownTrace(() => ({ attach }), root, aborted),
      removeDirectory: async () => {
        expect(attach).toHaveBeenCalledOnce();
        await filesystem.rm(root, { recursive: true, force: true });
      },
    }).catch((error: unknown) => error) as ElectronFixtureCloseError;
    expect(failure.errors).toEqual([original]);
    expect(attach.mock.calls[0]?.[0]).toBe("runtime-shutdown-trace");
    expect(JSON.parse(String(attach.mock.calls[0]?.[1].body))).toMatchObject({
      outcome: "captured", value: { deadlinePhase: "server cleanup", owners: [
        { owner: "store", state: "settled" },
        { owner: "http-server", state: "started", endMs: null },
      ] },
    });
    await expect(filesystem.lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("projects allowed fields without copying arbitrary strings or paths", async () => {
    await filesystem.writeFile(path, JSON.stringify({ ...valid, private: "PRIVATE",
      owners: [{ ...valid.owners[0], message: `PRIVATE ${root}` }] }));
    const evidence = await readRuntimeShutdownTrace(root, signal());
    expect(evidence).toEqual({ outcome: "captured", value: valid });
    expect(JSON.stringify(evidence)).not.toContain("PRIVATE");
    expect(JSON.stringify(evidence)).not.toContain(root);
  });

  it.each([undefined, { INERTIA_RUNTIME_SHUTDOWN_TRACE: "1" }])(
    "keeps runtime records and captures shutdown evidence only with explicit opt-in: %j",
    async (environment) => {
      const attach = vi.fn(async (_name: string, _options: { body?: Buffer | string }) => undefined);
      await attachRuntimeCleanupEvidence(() => ({ attach }), root, signal(), environment);
      expect(attach.mock.calls.map(([name]) => name).sort()).toEqual(environment
        ? ["electron-cleanup-runtime-records", "runtime-shutdown-trace"]
        : ["electron-cleanup-runtime-records"]);
    },
  );

  it("reports an absent trace as unavailable without assigning a cause", async () => {
    const attach = vi.fn(async (_name: string, _options: { body?: Buffer | string }) => undefined);
    await attachRuntimeShutdownTrace(() => ({ attach }), root, signal());
    expect(JSON.parse(String(attach.mock.calls[0]?.[1].body))).toEqual({ outcome: "unavailable" });
  });

  it.each([
    "not JSON PRIVATE",
    JSON.stringify({ ...valid, deadlinePhase: "PRIVATE" }),
    JSON.stringify({ ...valid, elapsedMs: -1 }),
    JSON.stringify({ ...valid, owners: Array(33).fill(valid.owners[0]) }),
    JSON.stringify({ ...valid, owners: [{ ...valid.owners[0], owner: "PRIVATE" }] }),
    JSON.stringify({ ...valid, owners: [{ ...valid.owners[0], startMs: 1.5 }] }),
    JSON.stringify({ ...valid, owners: [{ ...valid.owners[0], state: "settled", endMs: 4 }] }),
    JSON.stringify({ ...valid, owners: [{ ...valid.owners[0], state: "settled", endMs: 12_001 }] }),
    JSON.stringify({ ...valid, owners: [{ ...valid.owners[0], state: "started", endMs: 8 }] }),
  ])("rejects malformed or inconsistent trace payload %#", async (payload) => {
    await filesystem.writeFile(path, payload);
    expect(await readRuntimeShutdownTrace(root, signal())).toEqual({ outcome: "invalid" });
  });

  it.each(["file-link", "file-link-metadata", "parent-link", "directory", "oversized"])("rejects %s evidence", async (kind) => {
    if (kind === "file-link" || kind === "file-link-metadata") {
      const target = join(root, "private.json");
      await filesystem.writeFile(target, JSON.stringify(valid));
      if (kind === "file-link-metadata" || process.platform === "win32") {
        // File symlinks require a Windows privilege the test does not own.
        // Exercise rejection from the same lstat boundary without that privilege.
        const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
        const tracePath = join(await original.realpath(data), TEST_SHUTDOWN_TRACE_FILE);
        vi.mocked(filesystem.lstat).mockImplementation(async (file, options) => {
          const metadata = await original.lstat(file === tracePath ? target : file, options);
          return file === tracePath ? Object.assign(metadata, { isSymbolicLink: () => true }) : metadata;
        });
      } else {
        await filesystem.symlink(target, path, "file");
      }
    } else if (kind === "parent-link") {
      const target = join(root, "private-data");
      await filesystem.rename(data, target);
      await filesystem.writeFile(join(target, TEST_SHUTDOWN_TRACE_FILE), JSON.stringify(valid));
      await filesystem.symlink(target, data, process.platform === "win32" ? "junction" : "dir");
    } else if (kind === "directory") {
      await filesystem.mkdir(path);
    } else {
      await filesystem.writeFile(path, `${JSON.stringify(valid)}${" ".repeat(TEST_SHUTDOWN_TRACE_BYTES)}`);
    }
    expect(await readRuntimeShutdownTrace(root, signal())).toEqual({ outcome: "invalid" });
  });

  it("skips reads and reporting after the cleanup hook aborts", async () => {
    const inspect = vi.mocked(filesystem.lstat);
    const attach = vi.fn(async () => undefined);
    await attachRuntimeShutdownTrace(() => ({ attach }), root, AbortSignal.abort());
    expect(inspect).not.toHaveBeenCalled();
    expect(attach).not.toHaveBeenCalled();
  });

  it.each([false, true])("bounds stalled reads and ignores their late completion (abort: %s)", async (abort) => {
    vi.useFakeTimers();
    let finishRead!: (value: Awaited<ReturnType<typeof filesystem.lstat>>) => void;
    const pending = new Promise<Awaited<ReturnType<typeof filesystem.lstat>>>((resolve) => { finishRead = resolve; });
    vi.mocked(filesystem.lstat).mockReturnValueOnce(pending);
    const controller = new AbortController();
    const attach = vi.fn(async (_name: string, _options: { body?: Buffer | string }) => undefined);
    const capturing = attachRuntimeShutdownTrace(() => ({ attach }), root, controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    if (abort) controller.abort();
    await vi.advanceTimersByTimeAsync(500);
    await capturing;
    if (abort) expect(attach).not.toHaveBeenCalled();
    else expect(JSON.parse(String(attach.mock.calls[0]?.[1].body))).toEqual({ outcome: "timed-out" });
    controller.abort();
    finishRead(await filesystem.lstat(root));
    await vi.advanceTimersByTimeAsync(0);
    expect(attach).toHaveBeenCalledTimes(abort ? 0 : 1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["throws", "rejects", "hangs"])("cannot replace cleanup failure when the reporter %s", async (kind) => {
    vi.useFakeTimers();
    // The missing-file outcome makes the attachment payload deterministic.
    vi.mocked(filesystem.lstat).mockRejectedValueOnce(new Error("PRIVATE"));
    const attach = vi.fn((): Promise<void> => {
      if (kind === "throws") throw new Error("PRIVATE");
      if (kind === "rejects") return Promise.reject(new Error("PRIVATE"));
      return new Promise(() => undefined);
    });
    const original = new Error("original cleanup failure");
    const removeDirectory = vi.fn(async () => undefined);
    const closing = closeElectronFixtureBounded({
      current: null, requestRuntimeQuit: async () => null,
      waitForRuntimeExit: async () => undefined,
      closeServer: async () => { throw original; },
      onCleanupFailure: async (aborted) => attachRuntimeShutdownTrace(() => ({ attach }), root, aborted),
      removeDirectory,
    }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(250);
    const failure = await closing as ElectronFixtureCloseError;
    expect(failure.errors).toEqual([original]);
    expect(removeDirectory).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
