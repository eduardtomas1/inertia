import type * as ChildProcess from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const { spawnSyncMock, originalSpawnSync } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn(),
  originalSpawnSync: { current: null as typeof ChildProcess.spawnSync | null },
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  originalSpawnSync.current = actual.spawnSync;
  return { ...actual, spawnSync: spawnSyncMock };
});

vi.mock("electron", () => ({
  dialog: {
    showErrorBox: vi.fn(),
    showMessageBox: vi.fn(async () => ({ response: 1 })),
  },
}));

import { dialog } from "electron";

import { prepareRuntimeBootstrapRecovery } from "../../src/main/runtime-bootstrap-recovery";
import { runtimeCleanupReceiptIds } from "../../src/main/runtime-cleanup-receipts";
import { RuntimeGenerationLeaseJournal } from "../../src/node/runtime-generation-leases";
import { RuntimeOwnedProcessJournal } from "../../src/node/runtime-owned-process-journal";

const roots: string[] = [];
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;

afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  spawnSyncMock.mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("runtime bootstrap recovery", () => {
  it.skipIf(process.platform === "win32")("probes the macOS boot identity once per launch", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "inertia-bootstrap-recovery-"))); roots.push(root);
    spawnSyncMock.mockImplementation((command: string, ...rest: unknown[]) => {
      if (command === "/usr/sbin/sysctl") {
        const stdout = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA\n";
        return { pid: 1, output: [null, stdout, ""], stdout, stderr: "", status: 0, signal: null };
      }
      return (originalSpawnSync.current as (...args: unknown[]) => unknown)(command, ...rest);
    });
    Object.defineProperty(process, "platform", { ...platform, value: "darwin" });

    const result = await prepareRuntimeBootstrapRecovery(join(root, "data"), null);

    expect(result.bootstrapSafety.systemBootId).toBe("darwin:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(spawnSyncMock.mock.calls.filter(([command]) => command === "/usr/sbin/sysctl"))
      .toHaveLength(1);
  });

  it.skipIf(process.platform === "win32")("completes an exactly recovered macOS generation at launch without the recovery dialog", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "inertia-bootstrap-recovery-"))); roots.push(root);
    const dataDirectory = join(root, "data");
    const bootId = "darwin:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const generationId = "30000000-0000-4000-8000-000000000003:52";
    spawnSyncMock.mockImplementation((command: string, ...rest: unknown[]) => {
      if (command === "/usr/sbin/sysctl") {
        const stdout = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA\n";
        return { pid: 1, output: [null, stdout, ""], stdout, stderr: "", status: 0, signal: null };
      }
      return (originalSpawnSync.current as (...args: unknown[]) => unknown)(command, ...rest);
    });
    Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
    await prepareRuntimeBootstrapRecovery(dataDirectory, null);
    expect(new RuntimeGenerationLeaseJournal(dataDirectory).publish(generationId, bootId)).toBe(true);
    expect(new RuntimeOwnedProcessJournal(dataDirectory, { platform: "darwin" })
      .startSession(generationId, bootId)).toBe(true);
    vi.mocked(dialog.showMessageBox).mockClear();

    const result = await prepareRuntimeBootstrapRecovery(dataDirectory, join(root, "runtime-process-guardian"));

    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    expect(result.modernDarwinRecoveryAuthority).toBeNull();
    expect(runtimeCleanupReceiptIds(dataDirectory)).toEqual([generationId]);
    expect(new RuntimeGenerationLeaseJournal(dataDirectory).all()).toEqual([]);
  });
});
