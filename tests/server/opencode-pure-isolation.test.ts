import {
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const proofFixture = vi.hoisted(() => ({
  clientCreationFails: false,
  cleanupFails: false,
  healthVersion: "1.18.26",
  neverResolveVersionHealth: false,
  pureLoadsPlugin: false,
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
      const plugin = readFileSync(
        join(root, ".opencode", "plugins", "inertia-isolation-proof.js"),
        "utf8",
      );
      const encodedSentinel = /writeFileSync\(("(?:[^"\\]|\\.)*")/u.exec(plugin)?.[1];
      if (!encodedSentinel) throw new Error("The proof fixture could not find its sentinel.");
      if (!pure || proofFixture.pureLoadsPlugin) {
        writeFileSync(JSON.parse(encodedSentinel) as string, "executed", "utf8");
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
    proofFixture.healthVersion = "1.18.26";
    proofFixture.neverResolveVersionHealth = false;
    proofFixture.pureLoadsPlugin = false;
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
    await expect(prove()).resolves.toEqual({ cleanupConfirmed: true, verified: true });
    await expect(prove()).resolves.toEqual({ cleanupConfirmed: true, verified: true });
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
        () => ({ cleanupConfirmed: true, verified: true }),
      ),
    );
    expect(proofFixture.starts.map(({ executable, pure }) => ({ executable, pure })))
      .toEqual([
        { executable, pure: false },
        { executable, pure: true },
      ]);
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
    await expect(prove("1.18.26")).resolves.toMatchObject({ verified: true });
    const changedTime = new Date(Date.now() + 60_000);
    utimesSync(executable, changedTime, changedTime);
    await expect(prove("1.18.26")).resolves.toMatchObject({ verified: true });
    writeFileSync(executable, "changed selected executable identity", "utf8");
    await expect(prove("1.18.26")).resolves.toMatchObject({ verified: true });
    const replacement = `${executable}.replacement`;
    writeFileSync(replacement, "replacement selected executable", "utf8");
    rmSync(executable);
    renameSync(replacement, executable);
    await expect(prove("1.18.26")).resolves.toMatchObject({ verified: true });
    proofFixture.healthVersion = "1.18.27";
    await expect(prove("1.18.27")).resolves.toMatchObject({ verified: true });
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
    )).resolves.toEqual({ cleanupConfirmed: true, verified: false });
    proofFixture.pureLoadsPlugin = false;
    await expect(probeOpenCodePureIsolation(
      executable,
      "1.18.26",
      { env: process.env, pathEntries: [] },
      vi.fn(),
      { pluginObservationMs: 1 },
    )).resolves.toEqual({ cleanupConfirmed: true, verified: true });
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
    )).resolves.toEqual({ cleanupConfirmed: true, verified: false });

    proofFixture.healthVersion = "1.18.26";
    proofFixture.cleanupFails = true;
    await expect(probeOpenCodePureIsolation(
      executable,
      "1.18.26",
      { env: process.env, pathEntries: [] },
      vi.fn(),
      { pluginObservationMs: 1 },
    )).resolves.toEqual({ cleanupConfirmed: false, verified: false });
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
    )).resolves.toEqual({ cleanupConfirmed: true, verified: false });
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

    await expect(prove()).resolves.toEqual({ cleanupConfirmed: true, verified: false });
    expect(proofFixture.starts).toHaveLength(1);
    expect(proofFixture.terminateCalls).toBe(1);

    proofFixture.cleanupFails = true;
    await expect(prove()).resolves.toEqual({ cleanupConfirmed: false, verified: false });
    expect(proofFixture.starts).toHaveLength(2);
    expect(proofFixture.terminateCalls).toBe(2);
  });
});
