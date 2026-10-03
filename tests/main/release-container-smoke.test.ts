import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = process.cwd();
const moduleUrl = pathToFileURL(
  join(repositoryRoot, "scripts", "release-container-smoke.mjs"),
).href;

async function smokeModule() {
  return (await import(moduleUrl)) as {
    macImageIsMounted: (value: unknown, mountPoint: string) => boolean;
    reconcileMacImageMount: (
      mountPoint: string,
      operations: {
        queryMount: (mountPoint: string) => Promise<boolean>;
        detach: (mountPoint: string) => Promise<void>;
      },
    ) => Promise<void>;
    releaseContainerNames: (
      version: string,
      channel: "canary" | "stable",
      architecture: "arm64" | "x64",
    ) => {
      appImage: string;
      dmg: string;
      installedAppImage: string;
      productName: string;
      zip: string;
    };
    unversionedAppImageDependencies: (dynamicSection: string) => string[];
  };
}

describe("final release container smoke", () => {
  it("resolves every stable architecture-qualified final container exactly", async () => {
    const { releaseContainerNames } = await smokeModule();
    expect(releaseContainerNames("0.0.44", "stable", "x64")).toEqual({
      productName: "Inertia",
      installedAppImage: "Inertia.AppImage",
      appImage: "Inertia-0.0.44.AppImage",
      dmg: "Inertia-0.0.44.dmg",
      zip: "Inertia-0.0.44-mac.zip",
    });
    expect(releaseContainerNames("0.0.44", "stable", "arm64")).toEqual({
      productName: "Inertia",
      installedAppImage: "Inertia.AppImage",
      appImage: "Inertia-0.0.44-arm64.AppImage",
      dmg: "Inertia-0.0.44-arm64.dmg",
      zip: "Inertia-0.0.44-arm64-mac.zip",
    });
  });

  it("resolves every Canary architecture-qualified final container exactly", async () => {
    const { releaseContainerNames } = await smokeModule();
    expect(releaseContainerNames("1.2.3", "canary", "x64")).toEqual({
      productName: "Inertia Canary",
      installedAppImage: "Inertia Canary.AppImage",
      appImage: "Inertia-Canary-1.2.3.AppImage",
      dmg: "Inertia-Canary-1.2.3-x64.dmg",
      zip: "Inertia-Canary-1.2.3-x64.zip",
    });
    expect(releaseContainerNames("1.2.3", "canary", "arm64")).toEqual({
      productName: "Inertia Canary",
      installedAppImage: "Inertia Canary.AppImage",
      appImage: "Inertia-Canary-1.2.3-arm64.AppImage",
      dmg: "Inertia-Canary-1.2.3-arm64.dmg",
      zip: "Inertia-Canary-1.2.3-arm64.zip",
    });
  });

  it("rejects the exact legacy ARM64 AppImage runtime dependency", async () => {
    const { unversionedAppImageDependencies } = await smokeModule();
    const legacy = [
      " 0x0000000000000001 (NEEDED)             Shared library: [libdl.so.2]",
      " 0x0000000000000001 (NEEDED)             Shared library: [libz.so]",
      " 0x0000000000000001 (NEEDED)             Shared library: [libc.so.6]",
    ].join("\n");
    expect(unversionedAppImageDependencies(legacy)).toEqual(["libz.so"]);
    expect(
      unversionedAppImageDependencies(
        "0x0000000000000001 (NEEDED) Shared library: [libz.so.1]",
      ),
    ).toEqual([]);
  });

  it("reconciles interrupted DMG mount state before temporary cleanup", async () => {
    const { macImageIsMounted, reconcileMacImageMount } = await smokeModule();
    const mountPoint = "/private/tmp/inertia smoke/dmg";
    expect(
      macImageIsMounted(
        {
          images: [
            {
              "system-entities": [
                { "dev-entry": "/dev/disk9s1", "mount-point": mountPoint },
              ],
            },
          ],
        },
        mountPoint,
      ),
    ).toBe(true);
    expect(macImageIsMounted({ images: [] }, mountPoint)).toBe(false);

    let mounted = true;
    let detachCalls = 0;
    await expect(
      reconcileMacImageMount(mountPoint, {
        queryMount: async () => mounted,
        detach: async () => {
          detachCalls += 1;
          mounted = false;
        },
      }),
    ).resolves.toBeUndefined();
    expect(detachCalls).toBe(1);

    await expect(
      reconcileMacImageMount(mountPoint, {
        queryMount: async () => true,
        detach: async () => {
          throw new Error("interrupted detach");
        },
      }),
    ).rejects.toMatchObject({ preserveTemporaryRoot: true });
    await expect(
      reconcileMacImageMount(mountPoint, {
        queryMount: async () => {
          throw new Error("unknown mount state");
        },
        detach: async () => {},
      }),
    ).rejects.toMatchObject({ preserveTemporaryRoot: true });
  });
});
