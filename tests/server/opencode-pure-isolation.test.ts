import {
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const proofFixture = vi.hoisted(() => ({
  clientCreationFails: false,
  cleanupFails: false,
  controlSkipsPlugin: false,
  healthVersion: "1.18.26",
  neverResolveVersionHealth: false,
  pureLoadsPlugin: false,
  pureLoadsPluginAfterMs: null as number | null,
  pureWallClockStepMs: 0,
  restoreWallClock: (): void => undefined,
  startupTimesOut: false,
  starts: [] as Array<{ executable: string; pure: boolean; root: string }>,
  terminateCalls: 0,
}));

vi.mock("../../src/server/provider/opencode-boundary", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("../../src/server/provider/opencode-boundary")
  >();
  return {
    ...original,
    createOwnedOpenCodeClient: () => {
      if (proofFixture.clientCreationFails) {
        throw new Error("fixture client construction failed");
      }
      return {
        app: {
          agents: vi.fn(async () => ({ data: [] })),
        },
        global: {
          health: vi.fn(async () => proofFixture.neverResolveVersionHealth
            ? await new Promise<never>(() => undefined)
            : { data: { healthy: true, version: proofFixture.healthVersion } }),
        },
        provider: {
          list: vi.fn(async () => ({ data: { all: [], connected: [], default: {} } })),
        },
      };
    },
  };
});

vi.mock("../../src/server/provider/opencode-owned-server", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("../../src/server/provider/opencode-owned-server")
  >();
  return {
    ...original,
    startOwnedOpenCodeServer: vi.fn(async (
      executable: string,
      root: string,
      _environment: NodeJS.ProcessEnv,
      _output: unknown,
      _terminate: unknown,
      _subject: string,
      _signal: AbortSignal | undefined,
      pure: boolean,
    ) => {
      proofFixture.starts.push({ executable, pure, root });
      if (proofFixture.startupTimesOut) {
        throw new original.OpenCodeServerTimeoutError(
          "Timed out waiting for the OpenCode server to start.",
        );
      }
      const plugin = readFileSync(
        join(root, ".opencode", "plugins", "inertia-isolation-proof.js"),
        "utf8",
      );
      const encodedSentinel = /writeFileSync\(("(?:[^"\\]|\\.)*")/u.exec(plugin)?.[1];
      if (!encodedSentinel) throw new Error("The proof fixture could not find its sentinel.");
      if (pure ? proofFixture.pureLoadsPlugin : !proofFixture.controlSkipsPlugin) {
        writeFileSync(JSON.parse(encodedSentinel) as string, "executed", "utf8");
      }
      const delayedPluginMs = proofFixture.pureLoadsPluginAfterMs;
      if (pure && delayedPluginMs !== null) {
        setTimeout(() => {
          void writeFile(JSON.parse(encodedSentinel) as string, "executed", "utf8")
            .catch(() => undefined);
        }, delayedPluginMs);
      }
      if (pure && proofFixture.pureWallClockStepMs !== 0) {
        const wallClockNow = Date.now.bind(Date);
        let steps = 0;
        const wallClock = vi.spyOn(Date, "now").mockImplementation(() => {
          steps += 1;
          return wallClockNow() + steps * proofFixture.pureWallClockStepMs;
        });
        proofFixture.restoreWallClock = () => wallClock.mockRestore();
      }
      return {
        child: { exitCode: null, signalCode: null },
        terminate: async () => {
          proofFixture.terminateCalls += 1;
          if (proofFixture.cleanupFails) throw new Error("fixture cleanup failed");
        },
        url: "http://127.0.0.1:1",
      };
    }),
    waitForOpenCodeHealth: vi.fn(async () => undefined),
  };
});

import { probeOpenCodePureIsolation } from
  "../../src/server/provider/opencode-pure-isolation";

describe("selected OpenCode semantic isolation", () => {
  const roots: string[] = [];
  const selectedExecutable = (): string => {
    const root = mkdtempSync(join(tmpdir(), "inertia-opencode-selected-"));
    roots.push(root);
    const executable = join(root, "opencode");
    writeFileSync(executable, "selected executable", "utf8");
    return executable;
  };

  afterEach(() => {
    proofFixture.clientCreationFails = false;
    proofFixture.cleanupFails = false;
    proofFixture.controlSkipsPlugin = false;
    proofFixture.healthVersion = "1.18.26";
    proofFixture.neverResolveVersionHealth = false;
    proofFixture.pureLoadsPlugin = false;
    proofFixture.pureLoadsPluginAfterMs = null;
    proofFixture.pureWallClockStepMs = 0;
    proofFixture.restoreWallClock();
    proofFixture.restoreWallClock = () => undefined;
    proofFixture.startupTimesOut = false;
    proofFixture.starts.length = 0;
    proofFixture.terminateCalls = 0;
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("proves the exact selected executable once and reuses its successful proof", async () => {
    const executable = selectedExecutable();
    const prove = async () => await probeOpenCodePureIsolation(
      executable,
      "1.18.26",
      { env: process.env, pathEntries: [] },
      vi.fn(),
      { pluginObservationMs: 1 },
    );
    await expect(prove()).resolves.toEqual({ cleanupConfirmed: true, outcome: "verified" });
    await expect(prove()).resolves.toEqual({ cleanupConfirmed: true, outcome: "verified" });
    expect(proofFixture.starts.map(({ executable, pure }) => ({ executable, pure })))
      .toEqual([
        { executable, pure: false },
        { executable, pure: true },
      ]);
    expect(proofFixture.terminateCalls).toBe(2);
  });

  it("shares one proof across concurrent callers", async () => {
    const executable = selectedExecutable();
    const prove = async () => await probeOpenCodePureIsolation(
      executable,
      "1.18.26",
      { env: process.env, pathEntries: [] },
      vi.fn(),
      { pluginObservationMs: 1 },
    );

    await expect(Promise.all(Array.from({ length: 12 }, prove))).resolves.toEqual(
      Array.from(
        { length: 12 },
        () => ({ cleanupConfirmed: true, outcome: "verified" }),
      ),
    );
    expect(proofFixture.starts.map(({ executable, pure }) => ({ executable, pure })))
      .toEqual([
        { executable, pure: false },
        { executable, pure: true },
      ]);
    expect(proofFixture.terminateCalls).toBe(2);
  });

  it("cancels only the proof owned by the matching runtime lifetime", async () => {
    const executable = selectedExecutable();
    proofFixture.neverResolveVersionHealth = true;
    const firstLifetime = new AbortController();
    const secondLifetime = new AbortController();
    const prove = (signal: AbortSignal) => probeOpenCodePureIsolation(
      executable,
      "1.18.26",
      { env: process.env, pathEntries: [] },
      vi.fn(),
      { pluginObservationMs: 1, requestTimeoutMs: 5_000, signal },
    );

    const first = prove(firstLifetime.signal);
    const second = prove(secondLifetime.signal);
    await vi.waitFor(() => expect(proofFixture.starts).toHaveLength(2), { timeout: 10_000 });
    firstLifetime.abort();
    await expect(first).resolves.toEqual({
      cleanupConfirmed: true,
      outcome: "cancelled",
    });
    expect(proofFixture.terminateCalls).toBe(1);

    secondLifetime.abort();
    await expect(second).resolves.toEqual({
      cleanupConfirmed: true,
      outcome: "cancelled",
    });
    expect(proofFixture.terminateCalls).toBe(2);
  });

  it("invalidates successful proofs on executable identity or version changes", async () => {
    const executable = selectedExecutable();
    const prove = async (version: string) => await probeOpenCodePureIsolation(
      executable,
      version,
      { env: process.env, pathEntries: [] },
      vi.fn(),
      { pluginObservationMs: 1 },
    );
    await expect(prove("1.18.26")).resolves.toMatchObject({ outcome: "verified" });
    const changedTime = new Date(Date.now() + 60_000);
    utimesSync(executable, changedTime, changedTime);
    await expect(prove("1.18.26")).resolves.toMatchObject({ outcome: "verified" });
    writeFileSync(executable, "changed selected executable identity", "utf8");
    await expect(prove("1.18.26")).resolves.toMatchObject({ outcome: "verified" });
    const replacement = `${executable}.replacement`;
    writeFileSync(replacement, "replacement selected executable", "utf8");
    rmSync(executable);
    renameSync(replacement, executable);
    await expect(prove("1.18.26")).resolves.toMatchObject({ outcome: "verified" });
    proofFixture.healthVersion = "1.18.27";
    await expect(prove("1.18.27")).resolves.toMatchObject({ outcome: "verified" });
    expect(proofFixture.starts).toHaveLength(10);
  });

  it("rejects a pure server that executes the project plugin", async () => {
    const executable = selectedExecutable();
    proofFixture.pureLoadsPlugin = true;
    await expect(probeOpenCodePureIsolation(
      executable,
      "1.18.26",
      { env: process.env, pathEntries: [] },
      vi.fn(),
      { pluginObservationMs: 1 },
    )).resolves.toEqual({ cleanupConfirmed: true, outcome: "incompatible" });
    proofFixture.pureLoadsPlugin = false;
    await expect(probeOpenCodePureIsolation(
      executable,
      "1.18.26",
      { env: process.env, pathEntries: [] },
      vi.fn(),
      { pluginObservationMs: 1 },
    )).resolves.toEqual({ cleanupConfirmed: true, outcome: "verified" });
    expect(proofFixture.starts).toHaveLength(4);
  });

  it("rejects version substitution and distinguishes unconfirmed cleanup", async () => {
    const executable = selectedExecutable();
    proofFixture.healthVersion = "1.18.25";
    await expect(probeOpenCodePureIsolation(
      executable,
      "1.18.26",
      { env: process.env, pathEntries: [] },
      vi.fn(),
      { pluginObservationMs: 1 },
    )).resolves.toEqual({ cleanupConfirmed: true, outcome: "incompatible" });

    proofFixture.healthVersion = "1.18.26";
    proofFixture.cleanupFails = true;
    await expect(probeOpenCodePureIsolation(
      executable,
      "1.18.26",
      { env: process.env, pathEntries: [] },
      vi.fn(),
      { pluginObservationMs: 1 },
    )).resolves.toEqual({ cleanupConfirmed: false, outcome: "operational-error" });
    const startsAfterCleanupFailure = proofFixture.starts.length;
    const terminationsAfterCleanupFailure = proofFixture.terminateCalls;
    await expect(probeOpenCodePureIsolation(
      executable,
      "1.18.26",
      { env: process.env, pathEntries: [] },
      vi.fn(),
      { pluginObservationMs: 1 },
    )).resolves.toEqual({ cleanupConfirmed: false, outcome: "operational-error" });
    expect(proofFixture.starts).toHaveLength(startsAfterCleanupFailure);
    expect(proofFixture.terminateCalls).toBe(terminationsAfterCleanupFailure);
  });

  it("bounds a version health request that never resolves and still cleans up", async () => {
    const executable = selectedExecutable();
    proofFixture.neverResolveVersionHealth = true;
    await expect(probeOpenCodePureIsolation(
      executable,
      "1.18.26",
      { env: process.env, pathEntries: [] },
      vi.fn(),
      { pluginObservationMs: 1, requestTimeoutMs: 5 },
    )).resolves.toEqual({ cleanupConfirmed: true, outcome: "timed-out" });
    expect(proofFixture.starts).toHaveLength(1);
    expect(proofFixture.terminateCalls).toBe(1);
  });

  it("always terminates a started server when SDK client construction throws", async () => {
    const executable = selectedExecutable();
    proofFixture.clientCreationFails = true;
    const prove = async () => await probeOpenCodePureIsolation(
      executable,
      "1.18.26",
      { env: process.env, pathEntries: [] },
      vi.fn(),
      { pluginObservationMs: 1 },
    );

    await expect(prove()).resolves.toEqual({ cleanupConfirmed: true, outcome: "operational-error" });
    expect(proofFixture.starts).toHaveLength(1);
    expect(proofFixture.terminateCalls).toBe(1);

    proofFixture.cleanupFails = true;
    await expect(prove()).resolves.toEqual({ cleanupConfirmed: false, outcome: "operational-error" });
    expect(proofFixture.starts).toHaveLength(2);
    expect(proofFixture.terminateCalls).toBe(2);
  });

  it("reports a control server that never loads the project plugin as incompatible", async () => {
    const executable = selectedExecutable();
    proofFixture.controlSkipsPlugin = true;
    await expect(probeOpenCodePureIsolation(
      executable,
      "1.18.26",
      { env: process.env, pathEntries: [] },
      vi.fn(),
      { pluginObservationMs: 1 },
    )).resolves.toEqual({ cleanupConfirmed: true, outcome: "incompatible" });
    expect(proofFixture.starts).toHaveLength(1);
    expect(proofFixture.terminateCalls).toBe(1);
  });

  it("reports a server startup timeout as timed out and retries it later", async () => {
    const executable = selectedExecutable();
    const prove = async () => await probeOpenCodePureIsolation(
      executable,
      "1.18.26",
      { env: process.env, pathEntries: [] },
      vi.fn(),
      { pluginObservationMs: 1 },
    );
    proofFixture.startupTimesOut = true;
    await expect(prove()).resolves.toEqual({ cleanupConfirmed: true, outcome: "timed-out" });
    proofFixture.startupTimesOut = false;
    await expect(prove()).resolves.toEqual({ cleanupConfirmed: true, outcome: "verified" });
    expect(proofFixture.starts).toHaveLength(3);
  });

  it("reports an unusable version as incompatible without starting a server", async () => {
    await expect(probeOpenCodePureIsolation(
      selectedExecutable(),
      undefined,
      { env: process.env, pathEntries: [] },
      vi.fn(),
      { pluginObservationMs: 1 },
    )).resolves.toEqual({ cleanupConfirmed: true, outcome: "incompatible" });
    expect(proofFixture.starts).toHaveLength(0);
  });

  it("keeps the full plugin observation window when the wall clock jumps forward", async () => {
    const executable = selectedExecutable();
    proofFixture.pureLoadsPluginAfterMs = 150;
    proofFixture.pureWallClockStepMs = 3_600_000;
    await expect(probeOpenCodePureIsolation(
      executable,
      "1.18.26",
      { env: process.env, pathEntries: [] },
      vi.fn(),
      { pluginObservationMs: 400 },
    )).resolves.toEqual({ cleanupConfirmed: true, outcome: "incompatible" });
    expect(proofFixture.terminateCalls).toBe(2);
  });

  it("ends the plugin observation window when the wall clock jumps backward", async () => {
    const executable = selectedExecutable();
    proofFixture.pureWallClockStepMs = -3_600_000;
    const startedAt = performance.now();
    await expect(probeOpenCodePureIsolation(
      executable,
      "1.18.26",
      { env: process.env, pathEntries: [] },
      vi.fn(),
      { pluginObservationMs: 200 },
    )).resolves.toEqual({ cleanupConfirmed: true, outcome: "verified" });
    expect(performance.now() - startedAt).toBeLessThan(3_000);
  }, 10_000);
});
