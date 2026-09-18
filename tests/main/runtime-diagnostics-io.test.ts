import {
  chmodSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RuntimeDiagnostics,
  runtimeDiagnosticsDirectory,
} from "../../src/main/runtime-diagnostics";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, readSync: vi.fn(fs.readSync), fsyncSync: vi.fn(fs.fsyncSync) };
});

const roots: string[] = [];
afterEach(() => {
  vi.mocked(readSync).mockClear();
  vi.mocked(fsyncSync).mockClear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function diagnosticsFixture(now: () => number): {
  diagnostics: RuntimeDiagnostics;
  directory: string;
} {
  const root = mkdtempSync(join(tmpdir(), "inertia-runtime-diagnostics-io-"));
  roots.push(root);
  const directory = runtimeDiagnosticsDirectory(root);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(directory, "runtime.log"),
    `${JSON.stringify({ schemaVersion: 1, at: new Date(now()).toISOString(), event: "app.start" })}\n`,
    { mode: 0o600 },
  );
  return {
    diagnostics: new RuntimeDiagnostics(directory, {
      retentionMs: 60 * 60 * 1_000,
      now,
    }),
    directory,
  };
}

describe("runtime diagnostics journal I/O", () => {
  it("re-reads retained journals at startup and then at most once per prune interval", () => {
    let now = Date.now();
    const { diagnostics } = diagnosticsFixture(() => now);

    diagnostics.record("app.start");
    expect(readSync).toHaveBeenCalled();
    vi.mocked(readSync).mockClear();
    for (let generation = 0; generation < 5; generation += 1) {
      now += 59_000;
      diagnostics.record("runtime.state", { phase: "running", generation });
    }
    expect(readSync).not.toHaveBeenCalled();

    now += 5 * 60_000;
    diagnostics.record("runtime.state", { phase: "running", generation: 5 });
    expect(readSync).toHaveBeenCalled();
    vi.mocked(readSync).mockClear();
    now -= 10 * 60_000;
    diagnostics.record("runtime.state", { phase: "running", generation: 6 });
    expect(readSync).toHaveBeenCalled();
    vi.mocked(readSync).mockClear();
    diagnostics.ensureDirectory();
    expect(readSync).toHaveBeenCalled();
  });

  it("revalidates the directory and log files on every record between journal reads", () => {
    if (process.platform === "win32") return;
    const now = Date.now();
    const { diagnostics, directory } = diagnosticsFixture(() => now);
    diagnostics.record("app.start");
    vi.mocked(readSync).mockClear();

    chmodSync(directory, 0o755);
    symlinkSync(join(directory, "runtime.log"), join(directory, "runtime.3.log"));
    diagnostics.record("runtime.state", { phase: "running", generation: 1 });

    expect(readSync).not.toHaveBeenCalled();
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(readdirSync(directory)).not.toContain("runtime.3.log");
  });

  it("keeps stop and failure records durable without syncing every state record", () => {
    const now = Date.now();
    const { diagnostics } = diagnosticsFixture(() => now);

    diagnostics.record("runtime.state", { phase: "running", generation: 1 });
    expect(fsyncSync).not.toHaveBeenCalled();
    diagnostics.record("runtime.failure", {
      phase: "restarting",
      generation: 1,
      message: "bounded failure detail",
    });
    expect(fsyncSync).toHaveBeenCalledOnce();
    diagnostics.record("app.stop");
    expect(fsyncSync).toHaveBeenCalledTimes(2);
  });
});
