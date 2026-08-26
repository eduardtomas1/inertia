import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { packageSmokeEnvironment } from "../../src/main/package-smoke-environment";

const moduleUrl = pathToFileURL(resolve("scripts/package-smoke-launch.mjs")).href;
const ownerToken = "f7a23950-7f55-4a35-9c38-b6ca1fc5c438";

async function launchModule() {
  return await import(moduleUrl) as {
    packageSmokeProcessesExited: (options: {
      launcherPid: number;
      mainPid: number;
      ownedProcessGroupId?: number | null;
      runtimePid: number;
      processExists: (pid: number) => boolean;
      processGroupExists: (pid: number) => boolean;
    }) => boolean;
    parsePackageSmokeOwnedPids: (
      value: unknown,
      options: { launchedAt: number; ownerToken: string },
    ) => null | { mainPid: number; runtimePid: number };
    parsePackageSmokeReadiness: (
      value: unknown,
      options: {
        allowLauncherHandoff: boolean;
        launchedAt: number;
        launcherPid: number;
        ownedProcessGroupId?: number;
        ownerToken: string;
        processExists: (pid: number) => boolean;
        processGroupId: (pid: number) => number | null;
      },
    ) => null | { mainPid: number; runtimePid: number; ownerToken: string };
    waitForPackageSmokeReadiness: (options: {
      allowLauncherHandoff: boolean;
      launcherExit: Promise<{ error: Error | null; code: number | null; signal: string | null }>;
      launcherTimeoutMs: number;
      waitForReadiness: () => Promise<unknown>;
    }) => Promise<unknown>;
    packagedAppUsesDetachedProcessGroup: (
      platform: NodeJS.Platform,
      inheritSupervisedProcessGroup: boolean,
    ) => boolean;
  };
}

function readiness(overrides: Record<string, unknown> = {}) {
  return {
    mainPid: 202,
    runtimePid: 303,
    generation: 1,
    websocketUrl: "ws://127.0.0.1:43123",
    timestampMs: 2_000,
    ownerToken,
    ...overrides,
  };
}

afterEach(() => vi.unstubAllEnvs());

describe("package smoke launcher handoff", () => {
  it("keeps final-container apps inside the inherited supervisor group", async () => {
    const { packagedAppUsesDetachedProcessGroup, parsePackageSmokeReadiness } = await launchModule();
    expect(packagedAppUsesDetachedProcessGroup("darwin", true)).toBe(false);
    expect(packagedAppUsesDetachedProcessGroup("linux", true)).toBe(false);
    expect(packagedAppUsesDetachedProcessGroup("linux", false)).toBe(true);
    expect(parsePackageSmokeReadiness(readiness(), {
      allowLauncherHandoff: true,
      launchedAt: 1_000,
      launcherPid: 101,
      ownedProcessGroupId: 909,
      ownerToken,
      processExists: (pid) => pid === 202 || pid === 303,
      processGroupId: () => 909,
    })).toMatchObject({ mainPid: 202, runtimePid: 303 });
  });

  it("accepts a live, token-bound main process distinct from a successful AppImage launcher", async () => {
    const { parsePackageSmokeReadiness, waitForPackageSmokeReadiness } = await launchModule();
    expect(parsePackageSmokeReadiness(readiness(), {
      allowLauncherHandoff: true,
      launchedAt: 1_000,
      launcherPid: 101,
      ownerToken,
      processExists: (pid) => pid === 202 || pid === 303,
      processGroupId: () => 101,
    })).toMatchObject({ mainPid: 202, runtimePid: 303, ownerToken });

    const marker = readiness();
    await expect(waitForPackageSmokeReadiness({
      allowLauncherHandoff: true,
      launcherExit: Promise.resolve({ error: null, code: 0, signal: null }),
      launcherTimeoutMs: 1_000,
      waitForReadiness: async () => marker,
    })).resolves.toBe(marker);
  });

  it("rejects nonzero or signalled launcher exits before readiness", async () => {
    const { waitForPackageSmokeReadiness } = await launchModule();
    const never = () => new Promise<never>(() => {});
    await expect(waitForPackageSmokeReadiness({
      allowLauncherHandoff: true,
      launcherExit: Promise.resolve({ error: null, code: 7, signal: null }),
      launcherTimeoutMs: 1_000,
      waitForReadiness: never,
    })).rejects.toThrow("launcher exited before reporting readiness (7)");
    await expect(waitForPackageSmokeReadiness({
      allowLauncherHandoff: true,
      launcherExit: Promise.resolve({ error: null, code: null, signal: "SIGABRT" }),
      launcherTimeoutMs: 1_000,
      waitForReadiness: never,
    })).rejects.toThrow("launcher exited before reporting readiness (SIGABRT)");
  });

  it("rejects a late nonzero launcher exit even after valid readiness", async () => {
    const { waitForPackageSmokeReadiness } = await launchModule();
    let settleExit: ((value: { error: null; code: number; signal: null }) => void) | undefined;
    const launcherExit = new Promise<{ error: null; code: number; signal: null }>((settle) => {
      settleExit = settle;
    });
    const waiting = waitForPackageSmokeReadiness({
      allowLauncherHandoff: true,
      launcherExit,
      launcherTimeoutMs: 1_000,
      waitForReadiness: async () => readiness(),
    });
    settleExit?.({ error: null, code: 9, signal: null });
    await expect(waiting).rejects.toThrow("launcher exited before reporting readiness (9)");
  });

  it("bounds a wrapper that never completes its handoff after readiness", async () => {
    vi.useFakeTimers();
    try {
      const { waitForPackageSmokeReadiness } = await launchModule();
      const waiting = waitForPackageSmokeReadiness({
        allowLauncherHandoff: true,
        launcherExit: new Promise(() => {}),
        launcherTimeoutMs: 25,
        waitForReadiness: async () => readiness(),
      });
      const assertion = expect(waiting).rejects.toThrow(
        "AppImage launcher did not complete handoff before the startup deadline",
      );
      await vi.advanceTimersByTimeAsync(25);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let a successful launcher exit hide a missing readiness marker", async () => {
    const { waitForPackageSmokeReadiness } = await launchModule();
    await expect(waitForPackageSmokeReadiness({
      allowLauncherHandoff: true,
      launcherExit: Promise.resolve({ error: null, code: 0, signal: null }),
      launcherTimeoutMs: 1_000,
      waitForReadiness: async () => { throw new Error("Timed out waiting for the owner marker."); },
    })).rejects.toThrow("Timed out waiting for the owner marker");
  });

  it("rejects forged, stale, dead, and non-handoff readiness markers", async () => {
    const { parsePackageSmokeOwnedPids, parsePackageSmokeReadiness } = await launchModule();
    const options = {
      allowLauncherHandoff: true,
      launchedAt: 1_000,
      launcherPid: 101,
      ownerToken,
      processExists: (pid: number) => pid === 202 || pid === 303,
      processGroupId: () => 101,
    };
    expect(parsePackageSmokeReadiness(readiness({
      ownerToken: "4e0c1048-460a-4215-bbcc-8c59370656f4",
    }), options)).toBeNull();
    expect(parsePackageSmokeReadiness(readiness({ timestampMs: 999 }), options)).toBeNull();
    expect(parsePackageSmokeReadiness(readiness({ mainPid: 404 }), options)).toBeNull();
    expect(parsePackageSmokeReadiness(readiness({ runtimePid: 404 }), options)).toBeNull();
    expect(parsePackageSmokeReadiness(readiness({ mainPid: 101 }), options)).toBeNull();
    expect(parsePackageSmokeReadiness(readiness(), {
      ...options,
      processGroupId: (pid) => pid === 202 ? 101 : 404,
    })).toBeNull();
    expect(parsePackageSmokeOwnedPids(readiness(), options)).toEqual({
      mainPid: 202,
      runtimePid: 303,
      timestampMs: 2_000,
      ownerToken,
    });
  });

  it("waits for the wrapper-owned process group as well as main and runtime cleanup", async () => {
    const { packageSmokeProcessesExited } = await launchModule();
    const state = new Set([101, 202, 303]);
    const options = {
      launcherPid: 101,
      mainPid: 202,
      runtimePid: 303,
      processExists: (pid: number) => state.has(pid),
      processGroupExists: (pid: number) => state.has(pid),
    };
    expect(packageSmokeProcessesExited(options)).toBe(false);
    state.delete(202);
    state.delete(303);
    expect(packageSmokeProcessesExited(options)).toBe(false);
    state.delete(101);
    expect(packageSmokeProcessesExited(options)).toBe(true);
  });

  it("retains token-bound PIDs for individual cleanup when group validation fails", async () => {
    const {
      packageSmokeProcessesExited,
      parsePackageSmokeOwnedPids,
      parsePackageSmokeReadiness,
    } = await launchModule();
    const options = {
      allowLauncherHandoff: true,
      launchedAt: 1_000,
      launcherPid: 101,
      ownerToken,
      processExists: (pid: number) => pid === 202 || pid === 303,
      processGroupId: () => 404,
    };
    expect(parsePackageSmokeReadiness(readiness(), options)).toBeNull();
    const owned = parsePackageSmokeOwnedPids(readiness(), options);
    expect(owned).toMatchObject({ mainPid: 202, runtimePid: 303 });
    expect(packageSmokeProcessesExited({
      launcherPid: 101,
      mainPid: owned?.mainPid ?? 0,
      runtimePid: owned?.runtimePid ?? 0,
      processExists: options.processExists,
      processGroupExists: () => false,
    })).toBe(false);
  });

  it("only exposes a bounded UUID owner token to packaged test builds", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("INERTIA_PACKAGE_SMOKE_FILE", resolve("ready.json"));
    vi.stubEnv("INERTIA_PACKAGE_SMOKE_OWNER_TOKEN", ownerToken);
    expect(packageSmokeEnvironment()).toMatchObject({ ownerToken });
    vi.stubEnv("INERTIA_PACKAGE_SMOKE_OWNER_TOKEN", `${ownerToken}suffix`);
    expect(packageSmokeEnvironment()).toMatchObject({ ownerToken: null });
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("INERTIA_PACKAGE_SMOKE_OWNER_TOKEN", ownerToken);
    expect(packageSmokeEnvironment()).toMatchObject({ ownerToken: null });
  });
});
