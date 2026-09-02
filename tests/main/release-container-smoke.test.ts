import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

const repositoryRoot = process.cwd();
const moduleUrl = pathToFileURL(join(repositoryRoot, "scripts", "release-container-smoke.mjs")).href;

async function smokeModule() {
  return await import(moduleUrl) as {
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
    expect(unversionedAppImageDependencies(
      "0x0000000000000001 (NEEDED) Shared library: [libz.so.1]",
    )).toEqual([]);
  });

  it("reconciles interrupted DMG mount state before temporary cleanup", async () => {
    const { macImageIsMounted, reconcileMacImageMount } = await smokeModule();
    const mountPoint = "/private/tmp/inertia smoke/dmg";
    expect(macImageIsMounted({
      images: [{
        "system-entities": [
          { "dev-entry": "/dev/disk9s1", "mount-point": mountPoint },
        ],
      }],
    }, mountPoint)).toBe(true);
    expect(macImageIsMounted({ images: [] }, mountPoint)).toBe(false);

    let mounted = true;
    let detachCalls = 0;
    await expect(reconcileMacImageMount(mountPoint, {
      queryMount: async () => mounted,
      detach: async () => {
        detachCalls += 1;
        mounted = false;
      },
    })).resolves.toBeUndefined();
    expect(detachCalls).toBe(1);

    await expect(reconcileMacImageMount(mountPoint, {
      queryMount: async () => true,
      detach: async () => { throw new Error("interrupted detach"); },
    })).rejects.toMatchObject({ preserveTemporaryRoot: true });
    await expect(reconcileMacImageMount(mountPoint, {
      queryMount: async () => { throw new Error("unknown mount state"); },
      detach: async () => {},
    })).rejects.toMatchObject({ preserveTemporaryRoot: true });
  });

  it("uses the canonical physical macOS mountpoint identity", async () => {
    if (process.platform !== "darwin") return;
    const requested = await mkdtemp("/tmp/inertia-canonical-dmg-test-");
    try {
      const canonical = await realpath(requested);
      expect(requested).toMatch(/^\/tmp\//u);
      expect(canonical).toMatch(/^\/private\/tmp\//u);
    } finally {
      await rm(requested, { force: true, recursive: true });
    }
  });

  it("pins the corrected builder and static AppImage runtime toolsets", async () => {
    const manifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")) as {
      build: {
        mac?: { minimumSystemVersion?: string };
        toolsets?: { appimage?: string };
      };
      devDependencies: { "electron-builder"?: string };
      scripts: Record<string, string>;
    };
    expect(manifest.devDependencies["electron-builder"]).toBe("26.15.7");
    expect(manifest.build.toolsets?.appimage).toBe("1.0.3");
    expect(manifest.build.mac?.minimumSystemVersion).toBe("13.0");
    expect(manifest.scripts["test:release-container-smoke"])
      .toBe("node scripts/release-container-smoke.mjs");
  });

  it("executes final containers and clean native AppImage runtimes in CI and release", async () => {
    for (const workflowName of ["ci.yml", "release-platforms.yml"]) {
      const workflow = await readFile(
        join(repositoryRoot, ".github", "workflows", workflowName),
        "utf8",
      );
      expect(workflow).toContain(
        "Prove AppImage and guardian runtime on pristine Ubuntu 22.04",
      );
      expect(workflow).toContain(
        "ubuntu@sha256:2edbbc5dc405e9612ba3584ce95480277e3eb374407b5505fe26f17df77c7dbc",
      );
      expect(workflow).toContain('"$app" --appimage-version');
      expect(workflow).toContain('"$app" --appimage-extract');
      expect(workflow).toContain('"$guardian" seccomp-selftest');
      expect(workflow).toContain('"$guardian" identity "$child"');
      expect(workflow).toContain("cleanup() {");
      expect(workflow).toContain("trap cleanup EXIT");
      expect(workflow).not.toContain("trap 'kill");
      expect(workflow).toContain("Install Linux guardian toolchain");
      expect(workflow).toContain("binutils linux-libc-dev musl-tools");
      expect(workflow).toContain("musl-tools=1.2.4-2");
      expect(workflow).toContain("Verify the packaged Linux guardian is static");
      expect(workflow).toContain("readelf --program-headers");
      expect(workflow).toContain("readelf --dynamic");
      expect(workflow).toContain("Smoke final macOS and Linux release containers");
      expect(workflow).toContain("run: npm run test:release-container-smoke");
      expect(workflow).toContain(
        "Smoke final Linux AppImage default and fallback launches under Xvfb",
      );
      expect(workflow).toContain("xvfb-run --auto-servernum npm run test:release-container-smoke");
    }
  });

  it("builds the Linux guardian against static musl instead of the host glibc", async () => {
    const source = await readFile(
      join(repositoryRoot, "scripts", "build-runtime-process-guardian.mjs"),
      "utf8",
    );
    expect(source).toContain('"/usr/bin/musl-gcc"');
    expect(source).toContain('"-static-pie"');
    expect(source).toContain('"-s"');
    expect(source).toContain('`/usr/include/${linuxGnuTriplet}`');
    expect(source).toContain("musl-tools, linux-libc-dev, and binutils");
  });

  it("precompiles the Windows Job Object helper into a bounded AnyCPU executable", async () => {
    const source = await readFile(
      join(repositoryRoot, "scripts", "build-runtime-process-guardian.mjs"),
      "utf8",
    );
    expect(source).toContain('"windows-runtime-job.exe"');
    expect(source).toContain('"native", "runtime-process-guardian", "windows.cs"');
    expect(source).toContain("[Microsoft.CSharp.CSharpCodeProvider]::new()");
    expect(source).toContain("[System.CodeDom.Compiler.CompilerParameters]::new()");
    expect(source).toContain("$parameters.GenerateExecutable = $true");
    expect(source).toContain("$parameters.GenerateInMemory = $false");
    expect(source).toContain("$parameters.OutputAssembly = $outputPath");
    expect(source).toContain("$parameters.MainClass = 'InertiaRuntimeJob'");
    expect(source).toContain(
      "$parameters.ReferencedAssemblies.Add('System.dll') | Out-Null",
    );
    expect(source).toContain(
      "$parameters.CompilerOptions = '/platform:anycpu /optimize+ /target:exe'",
    );
    expect(source).toContain("$provider.CompileAssemblyFromSource(");
    expect(source).toContain("$results.Errors.HasErrors");
    expect(source).not.toContain("Add-Type -TypeDefinition");
    expect(source).toContain('shell: false');
    expect(source).toContain('timeout: 60_000');
    expect(source).toContain('metadata.size > 1024 * 1024');
    expect(source).toContain('createHash("sha256")');
    expect(source).toContain('"windows-runtime-job-integrity.json"');
    expect(source).toContain('JSON.stringify({ sha256 }');
  });

  it("keeps container validation bounded to native architectures", async () => {
    const source = await readFile(join(repositoryRoot, "scripts", "release-container-smoke.mjs"), "utf8");
    expect(source).toContain('import { runBounded } from "./bounded-process-tree.mjs"');
    expect(source).not.toContain("spawnSync");
    expect(source).toContain('await runContainerCommand(appImage, ["--appimage-version"]');
    expect(source).toContain('await runContainerCommand(appImage, ["--appimage-extract"]');
    expect(source).toContain("copyFile(appImage, installedAppImage, constants.COPYFILE_EXCL)");
    expect(source).toContain('runPackageSmoke(repositoryRoot, installedAppImage');
    expect(source).toContain("operationError?.preserveTemporaryRoot === true");
    expect(source).toContain("mountAttempted = true");
    expect(source).toContain("await realpath(requestedExtractionRoot)");
    expect(source).toContain("await reconcileMacImageMount(extractionRoot)");
    expect(source).toContain("posixProcessGroupHandoff");
    expect(source).toContain("INERTIA_PACKAGE_SMOKE_PROCESS_GROUP_FILE");
    expect(source).toContain("INERTIA_PACKAGE_SMOKE_PROCESS_GROUP_TOKEN");
    expect(source).toContain('"direct-app"');
    expect(source).toContain('"retained-wrapper"');
    expect(source).not.toContain('"handoff-wrapper"');
    expect(source).toContain('}, ["APPIMAGE_EXTRACT_AND_RUN"]);');
    expect(source).toContain('APPIMAGE_EXTRACT_AND_RUN: "1"');
    expect(source).toContain("AppImage default mount/AppRun smoke passed");
    expect(source).toContain("AppImage extract-and-run fallback smoke passed");
    expect(source).toContain('INERTIA_PACKAGE_SMOKE_KIND: packageKind');
    expect(source).toContain('"macos-zip"');
    expect(source).toContain('"macos-dmg"');
    expect(source).toContain('"linux-appimage"');
    for (const name of [
      "libffmpeg.dylib",
      "libvk_swiftshader.dylib",
      "Mantle",
      "ReactiveObjC",
      "Squirrel",
      "ShipIt",
    ]) {
      expect(source).toContain(name);
    }
    for (const removedAngleLibrary of ["libEGL", "libGLESv2"]) {
      expect(source).not.toContain(removedAngleLibrary);
    }
    expect(source).toContain("inspectNativeBinaryArchitecture");
  });
});
