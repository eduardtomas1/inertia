import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = process.cwd();
const moduleUrl = pathToFileURL(join(repositoryRoot, "scripts", "release-container-smoke.mjs")).href;

async function smokeModule() {
  return await import(moduleUrl) as {
    releaseContainerNames: (
      version: string,
      channel: "canary" | "stable",
      architecture: "arm64" | "x64",
    ) => { appImage: string; dmg: string; zip: string };
    unversionedAppImageDependencies: (dynamicSection: string) => string[];
  };
}

describe("final release container smoke", () => {
  it("resolves every stable architecture-qualified final container exactly", async () => {
    const { releaseContainerNames } = await smokeModule();
    expect(releaseContainerNames("0.0.44", "stable", "x64")).toEqual({
      appImage: "Inertia-0.0.44.AppImage",
      dmg: "Inertia-0.0.44.dmg",
      zip: "Inertia-0.0.44-mac.zip",
    });
    expect(releaseContainerNames("0.0.44", "stable", "arm64")).toEqual({
      appImage: "Inertia-0.0.44-arm64.AppImage",
      dmg: "Inertia-0.0.44-arm64.dmg",
      zip: "Inertia-0.0.44-arm64-mac.zip",
    });
  });

  it("resolves every Canary architecture-qualified final container exactly", async () => {
    const { releaseContainerNames } = await smokeModule();
    expect(releaseContainerNames("1.2.3", "canary", "x64")).toEqual({
      appImage: "Inertia-Canary-1.2.3.AppImage",
      dmg: "Inertia-Canary-1.2.3-x64.dmg",
      zip: "Inertia-Canary-1.2.3-x64.zip",
    });
    expect(releaseContainerNames("1.2.3", "canary", "arm64")).toEqual({
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
    expect(unversionedAppImageDependencies(
      "0x0000000000000001 (NEEDED) Shared library: [libz.so.1]",
    )).toEqual([]);
  });

  it("pins the corrected builder and static AppImage runtime toolsets", async () => {
    const manifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")) as {
      build: { toolsets?: { appimage?: string } };
      devDependencies: { "electron-builder"?: string };
      scripts: Record<string, string>;
    };
    expect(manifest.devDependencies["electron-builder"]).toBe("26.15.6");
    expect(manifest.build.toolsets?.appimage).toBe("1.0.3");
    expect(manifest.scripts["test:release-container-smoke"])
      .toBe("node scripts/release-container-smoke.mjs");
  });

  it("executes final containers and clean native AppImage runtimes in CI and release", async () => {
    for (const workflowName of ["ci.yml", "release-platforms.yml"]) {
      const workflow = await readFile(
        join(repositoryRoot, ".github", "workflows", workflowName),
        "utf8",
      );
      expect(workflow).toContain("Prove AppImage runtime on pristine native Ubuntu");
      expect(workflow).toContain(
        "ubuntu@sha256:33ceb71981b602c1a7443a53469e4dba065f7503eab3078a2d7a57a2ab987517",
      );
      expect(workflow).toContain('"/release/$artifact" --appimage-version');
      expect(workflow).toContain("Smoke final macOS and Linux release containers");
      expect(workflow).toContain("run: npm run test:release-container-smoke");
      expect(workflow).toContain(
        "Smoke final Linux AppImage default and fallback launches under Xvfb",
      );
      expect(workflow).toContain("xvfb-run --auto-servernum npm run test:release-container-smoke");
    }
  });

  it("keeps container validation bounded to native architectures", async () => {
    const source = await readFile(join(repositoryRoot, "scripts", "release-container-smoke.mjs"), "utf8");
    expect(source).toContain('runBounded(appImage, ["--appimage-version"]');
    expect(source).toContain('runBounded(appImage, ["--appimage-extract"]');
    expect(source).toContain('}, ["APPIMAGE_EXTRACT_AND_RUN"]);');
    expect(source).toContain('APPIMAGE_EXTRACT_AND_RUN: "1"');
    expect(source).toContain("AppImage default mount/AppRun smoke passed");
    expect(source).toContain("AppImage extract-and-run fallback smoke passed");
    expect(source).toContain('INERTIA_PACKAGE_SMOKE_KIND: packageKind');
    expect(source).toContain('"macos-zip"');
    expect(source).toContain('"macos-dmg"');
    expect(source).toContain('"linux-appimage"');
    for (const name of [
      "libEGL.dylib",
      "libGLESv2.dylib",
      "libffmpeg.dylib",
      "libvk_swiftshader.dylib",
      "Mantle",
      "ReactiveObjC",
      "Squirrel",
      "ShipIt",
    ]) {
      expect(source).toContain(name);
    }
    expect(source).toContain("inspectNativeBinaryArchitecture");
  });
});
