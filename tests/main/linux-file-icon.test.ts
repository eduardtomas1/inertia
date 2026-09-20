import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ fork: vi.fn() }));
vi.mock("electron", () => ({ utilityProcess: native }));
import { setLinuxFileIcon } from "../../src/main/linux-file-icon";

class Worker extends EventEmitter {
  kill = vi.fn(() => true);
  postMessage = vi.fn();
}
let worker: Worker;
const file = join(tmpdir(), "Inertia.AppImage");
const icon = join(tmpdir(), "inertia-icon.png");
const workerPath = join(tmpdir(), "application", "out", "main", "linux-file-icon-worker.js");
beforeEach(() => {
  vi.useFakeTimers();
  worker = new Worker();
  native.fork.mockReset().mockReturnValue(worker);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

it("passes only the desktop environment and succeeds after a clean worker exit", async () => {
  vi.stubEnv("NODE_OPTIONS", "--inspect");
  const result = setLinuxFileIcon(file, icon, workerPath);
  expect(native.fork.mock.calls[0][0]).toBe(workerPath);
  worker.emit("spawn");
  expect(worker.postMessage).toHaveBeenCalledWith({ file, icon: pathToFileURL(icon).href });
  expect(native.fork.mock.calls[0][2].env).not.toHaveProperty("NODE_OPTIONS");
  worker.emit("exit", 0);
  await expect(result).resolves.toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it("consumes fatal worker errors before exit and retains the failure", async () => {
  const result = setLinuxFileIcon(file, icon, workerPath);
  expect(() => worker.emit("error", "FatalError", "fixture", "native failure")).not.toThrow();
  worker.emit("exit", 0);
  await expect(result).resolves.toBe(false);
  expect(worker.kill).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("contains a failed initial message and does not leave its deadline running", async () => {
  worker.postMessage.mockImplementation(() => { throw new Error("worker gone"); });
  const result = setLinuxFileIcon(file, icon, workerPath);
  expect(() => worker.emit("spawn")).not.toThrow();
  await expect(result).resolves.toBe(false);
  expect(worker.kill).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("settles at the deadline even when termination throws or exit never arrives", async () => {
  worker.kill.mockImplementation(() => { throw new Error("already gone"); });
  const result = setLinuxFileIcon(file, icon, workerPath);
  await vi.advanceTimersByTimeAsync(5_000);
  await expect(result).resolves.toBe(false);
  expect(() => worker.emit("error", "FatalError")).not.toThrow();
  worker.emit("spawn");
  expect(worker.postMessage).not.toHaveBeenCalled();
});

it("reports a nonzero worker exit as failure", async () => {
  const result = setLinuxFileIcon(file, icon, workerPath);
  worker.emit("exit", 1);
  await expect(result).resolves.toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
