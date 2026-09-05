import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { packageSmokeEnvironment } from "../../src/main/package-smoke-environment";

const moduleUrl = pathToFileURL(resolve("scripts/package-smoke-launch.mjs")).href;
const ownerToken = "f7a23950-7f55-4a35-9c38-b6ca1fc5c438";

async function launchModule() {
  return await import(moduleUrl) as {
    packageSmokeChildEnvironment: (environment: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
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
        launchMode: "direct-app" | "handoff-wrapper" | "retained-wrapper";
        launchedAt: number;
        launcherPid: number;
        ownedProcessGroupId?: number | null;
        ownerToken: string;
        processExists: (pid: number) => boolean;
        processGroupId: (pid: number) => number | null;
      },
    ) => null | { mainPid: number; runtimePid: number; ownerToken: string };
    waitForPackageSmokeReadiness: (options: {
      launchMode: "direct-app" | "handoff-wrapper" | "retained-wrapper";
      launcherExit: Promise<{ error: Error | null; code: number | null; signal: string | null }>;
      launcherTimeoutMs: number;
      waitForReadiness: () => Promise<unknown>;
    }) => Promise<unknown>;
    packagedAppUsesDetachedProcessGroup: (
      platform: NodeJS.Platform,
    ) => boolean;
    resolvePackageSmokeLaunchMode: (options: {
      configuredMode?: string;
      extractAndRun?: string;
      packageKind?: string;
    }) => "direct-app" | "handoff-wrapper" | "retained-wrapper";
    waitForPackageSmokeExit: (options: {
      beforeQuitTimestampMs: number;
      launchMode: "direct-app" | "handoff-wrapper" | "retained-wrapper";
      launcherExit: Promise<{
        error: Error | null;
        code: number | null;
        endedAt: number;
        signal: string | null;
      }>;
      mainExit: Promise<{ error: null; code: number; endedAt: number; signal: null }>;
      mainProcessExists: () => boolean;
    }) => Promise<{ endedAt: number }>;
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
  it("binds each package kind to its exact launcher entry path", async () => {
    const { resolvePackageSmokeLaunchMode } = await launchModule();
    expect(resolvePackageSmokeLaunchMode({ packageKind: "macos-dmg" })).toBe("direct-app");
    expect(resolvePackageSmokeLaunchMode({
      configuredMode: "direct-app",
      packageKind: "macos-zip",
    })).toBe("direct-app");
    expect(resolvePackageSmokeLaunchMode({
      configuredMode: "direct-app",
      packageKind: "macos-dmg",
    })).toBe("direct-app");
    expect(resolvePackageSmokeLaunchMode({
      packageKind: "linux-appimage",
    })).toBe("direct-app");
    expect(resolvePackageSmokeLaunchMode({
      configuredMode: "retained-wrapper",
      extractAndRun: "1",
      packageKind: "linux-appimage",
    })).toBe("retained-wrapper");
    expect(resolvePackageSmokeLaunchMode({
      configuredMode: "handoff-wrapper",
      extractAndRun: "1",
      packageKind: "linux-appimage",
    })).toBe("handoff-wrapper");
    expect(() => resolvePackageSmokeLaunchMode({
      configuredMode: "retained-wrapper",
      packageKind: "linux-appimage",
    })).toThrow("does not match its exact runtime entry path");
    expect(() => resolvePackageSmokeLaunchMode({
      configuredMode: "handoff-wrapper",
      packageKind: "linux-appimage",
    })).toThrow("does not match its exact runtime entry path");
    expect(() => resolvePackageSmokeLaunchMode({
      configuredMode: "retained-wrapper",
      packageKind: "macos-zip",
    })).toThrow("cannot use an AppImage launcher contract");
    expect(() => resolvePackageSmokeLaunchMode({
      extractAndRun: "1",
      packageKind: "linux-unpacked",
    })).toThrow("cannot use an AppImage launcher contract");
  });

  it("does not expose outer supervisor controls to the packaged app", async () => {
    const { packageSmokeChildEnvironment } = await launchModule();
    expect(packageSmokeChildEnvironment({
      APPIMAGE_EXTRACT_AND_RUN: "1",
      INERTIA_PACKAGE_SMOKE_LAUNCH_MODE: "handoff-wrapper",
      INERTIA_PACKAGE_SMOKE_PROCESS_GROUP_FILE: "/private/group.json",
      INERTIA_PACKAGE_SMOKE_PROCESS_GROUP_TOKEN: ownerToken,
      INERTIA_PACKAGE_SMOKE_SUPERVISOR_ROOT: "/private",
      SAFE_VALUE: "retained",
    })).toEqual({
      APPIMAGE_EXTRACT_AND_RUN: "1",
      SAFE_VALUE: "retained",
    });
  });

  it("gives every final-container app an exact detached process group", async () => {
    const { packagedAppUsesDetachedProcessGroup, parsePackageSmokeReadiness } = await launchModule();
    expect(packagedAppUsesDetachedProcessGroup("darwin")).toBe(true);
    expect(packagedAppUsesDetachedProcessGroup("linux")).toBe(true);
    expect(packagedAppUsesDetachedProcessGroup("win32")).toBe(false);
    expect(parsePackageSmokeReadiness(readiness(), {
      launchMode: "handoff-wrapper",
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
      launchMode: "handoff-wrapper",
      launchedAt: 1_000,
      launcherPid: 101,
      ownerToken,
      processExists: (pid) => pid === 202 || pid === 303,
      processGroupId: () => 101,
    })).toMatchObject({ mainPid: 202, runtimePid: 303, ownerToken });

    const marker = readiness();
    await expect(waitForPackageSmokeReadiness({
      launchMode: "handoff-wrapper",
      launcherExit: Promise.resolve({ error: null, code: 0, signal: null }),
      launcherTimeoutMs: 1_000,
      waitForReadiness: async () => marker,
    })).resolves.toBe(marker);
  });

  it("rejects direct readiness with a dead process or a process outside the owned group", async () => {
    const { parsePackageSmokeReadiness } = await launchModule();
    const options = {
      launchMode: "direct-app" as const,
      launchedAt: 1_000,
      launcherPid: 202,
      ownedProcessGroupId: 202,
      ownerToken,
      processExists: (pid: number) => pid === 202 || pid === 303,
      processGroupId: () => 202,
    };
    expect(parsePackageSmokeReadiness(readiness(), options)).toMatchObject({
      mainPid: 202,
      runtimePid: 303,
    });
    expect(parsePackageSmokeReadiness(readiness(), {
      ...options,
      processExists: (pid) => pid === 202,
    })).toBeNull();
    expect(parsePackageSmokeReadiness(readiness(), {
      ...options,
      processGroupId: (pid) => pid === 202 ? 202 : 404,
    })).toBeNull();
  });

  it("accepts retained-wrapper readiness only while the exact wrapper remains alive", async () => {
    const { parsePackageSmokeReadiness, waitForPackageSmokeReadiness } = await launchModule();
    expect(parsePackageSmokeReadiness(readiness(), {
      launchMode: "retained-wrapper",
      launchedAt: 1_000,
      launcherPid: 101,
      ownedProcessGroupId: 101,
      ownerToken,
      processExists: (pid) => pid === 101 || pid === 202 || pid === 303,
      processGroupId: () => 101,
    })).toMatchObject({ mainPid: 202, runtimePid: 303 });
    expect(parsePackageSmokeReadiness(readiness(), {
      launchMode: "retained-wrapper",
      launchedAt: 1_000,
      launcherPid: 101,
      ownedProcessGroupId: 101,
      ownerToken,
      processExists: (pid) => pid === 202 || pid === 303,
      processGroupId: () => 101,
    })).toBeNull();

    const marker = readiness();
    await expect(waitForPackageSmokeReadiness({
      launchMode: "retained-wrapper",
      launcherExit: new Promise(() => {}),
      launcherTimeoutMs: 1_000,
      waitForReadiness: async () => marker,
    })).resolves.toBe(marker);
  });

  it("rejects every retained-wrapper exit before readiness", async () => {
    const { waitForPackageSmokeReadiness } = await launchModule();
    const never = () => new Promise<never>(() => {});
    for (const exit of [
      { error: null, code: 0, signal: null },
      { error: null, code: 7, signal: null },
      { error: null, code: null, signal: "SIGABRT" },
    ]) {
      await expect(waitForPackageSmokeReadiness({
        launchMode: "retained-wrapper",
        launcherExit: Promise.resolve(exit),
        launcherTimeoutMs: 1_000,
        waitForReadiness: never,
      })).rejects.toThrow("retained wrapper exited before reporting readiness");
    }
  });

  it("requires the retained wrapper to exit cleanly after packaged shutdown begins", async () => {
    const { waitForPackageSmokeExit } = await launchModule();
    const mainExit = Promise.resolve({
      error: null,
      code: 0,
      endedAt: 3_000,
      signal: null,
    });
    await expect(waitForPackageSmokeExit({
      beforeQuitTimestampMs: 2_000,
      launchMode: "retained-wrapper",
      launcherExit: Promise.resolve({
        error: null,
        code: 0,
        endedAt: 3_100,
        signal: null,
      }),
      mainExit,
      mainProcessExists: () => false,
    })).resolves.toMatchObject({ endedAt: 3_100 });
    await expect(waitForPackageSmokeExit({
      beforeQuitTimestampMs: 2_000,
      launchMode: "retained-wrapper",
      launcherExit: Promise.resolve({
        error: null,
        code: 0,
        endedAt: 1_999,
        signal: null,
      }),
      mainExit,
      mainProcessExists: () => false,
    })).rejects.toThrow("wrapper exited before packaged shutdown began");
    await expect(waitForPackageSmokeExit({
      beforeQuitTimestampMs: 2_000,
      launchMode: "retained-wrapper",
      launcherExit: Promise.resolve({
        error: null,
        code: 0,
        endedAt: 2_999,
        signal: null,
      }),
      mainExit,
      mainProcessExists: () => false,
    })).resolves.toMatchObject({ endedAt: 3_000 });
    await expect(waitForPackageSmokeExit({
      beforeQuitTimestampMs: 2_000,
      launchMode: "retained-wrapper",
      launcherExit: Promise.resolve({
        error: null,
        code: 9,
        endedAt: 3_100,
        signal: null,
      }),
      mainExit,
      mainProcessExists: () => false,
    })).rejects.toThrow("retained AppImage wrapper exited with 9");
    await expect(waitForPackageSmokeExit({
      beforeQuitTimestampMs: 2_000,
      launchMode: "retained-wrapper",
      launcherExit: Promise.resolve({
        error: null,
        code: 0,
        endedAt: 3_000,
        signal: null,
      }),
      mainExit: Promise.resolve({
        error: null,
        code: 0,
        endedAt: 3_100,
        signal: null,
      }),
      mainProcessExists: () => true,
    })).rejects.toThrow("stopped supervising before the packaged app exited");
  });

  it("requires a clean direct application shutdown", async () => {
    const { waitForPackageSmokeExit } = await launchModule();
    await expect(waitForPackageSmokeExit({
      beforeQuitTimestampMs: 2_000,
      launchMode: "direct-app",
      launcherExit: Promise.resolve({
        error: null,
        code: 7,
        endedAt: 3_000,
        signal: null,
      }),
      mainExit: Promise.resolve({
        error: null,
        code: 0,
        endedAt: 3_000,
        signal: null,
      }),
      mainProcessExists: () => false,
    })).rejects.toThrow("packaged app exited with 7");
  });

  it("rejects nonzero or signalled launcher exits before readiness", async () => {
    const { waitForPackageSmokeReadiness } = await launchModule();
    const never = () => new Promise<never>(() => {});
    await expect(waitForPackageSmokeReadiness({
      launchMode: "handoff-wrapper",
      launcherExit: Promise.resolve({ error: null, code: 7, signal: null }),
      launcherTimeoutMs: 1_000,
      waitForReadiness: never,
    })).rejects.toThrow("launcher exited before reporting readiness (7)");
    await expect(waitForPackageSmokeReadiness({
      launchMode: "handoff-wrapper",
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
      launchMode: "handoff-wrapper",
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
        launchMode: "handoff-wrapper",
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
      launchMode: "handoff-wrapper",
      launcherExit: Promise.resolve({ error: null, code: 0, signal: null }),
      launcherTimeoutMs: 1_000,
      waitForReadiness: async () => { throw new Error("Timed out waiting for the owner marker."); },
    })).rejects.toThrow("Timed out waiting for the owner marker");
  });

  it("rejects forged, stale, dead, and non-handoff readiness markers", async () => {
    const { parsePackageSmokeOwnedPids, parsePackageSmokeReadiness } = await launchModule();
    const options = {
      launchMode: "handoff-wrapper" as const,
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
      launchMode: "handoff-wrapper" as const,
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
    vi.stubEnv("INERTIA_PACKAGE_SMOKE_EXPECT_APPIMAGE_FD", "4");
    expect(packageSmokeEnvironment()).toMatchObject({
      appImageFileDescriptor: 4,
      ownerToken,
    });
    vi.stubEnv("INERTIA_PACKAGE_SMOKE_OWNER_TOKEN", `${ownerToken}suffix`);
    expect(packageSmokeEnvironment()).toMatchObject({
      appImageFileDescriptor: null,
      ownerToken: null,
    });
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("INERTIA_PACKAGE_SMOKE_OWNER_TOKEN", ownerToken);
    expect(packageSmokeEnvironment()).toMatchObject({
      appImageFileDescriptor: null,
      ownerToken: null,
    });
  });
});
