import type * as ChildProcess from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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

import { prepareRuntimeBootstrapRecovery } from "../../src/main/runtime-bootstrap-recovery";

const roots: string[] = [];
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;

afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  spawnSyncMock.mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("runtime bootstrap recovery", () => {
  it("probes the macOS boot identity once per launch", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-bootstrap-recovery-")); roots.push(root);
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
});
