// @inertia-test-suite portable

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

import { afterEach, describe, expect, it } from "vitest";

import { parseWindowsInstallerCandidateExecutableDigest } from
  "../../src/main/app-update-bootstrap";

const roots: string[] = [];
const require = createRequire(import.meta.url);
const buildModuleUrl = pathToFileURL(join(
  import.meta.dirname,
  "..",
  "..",
  "scripts",
  "windows-update-lineage-build.mjs",
)).href;

interface WindowsLineageBuildModule {
  bindWindowsInstallerToCandidateExecutable(context: unknown): Promise<void>;
  verifyWindowsInstallerCandidateMarker(
    installerPath: string,
    marker: string,
  ): Promise<void>;
}

async function buildModule(): Promise<WindowsLineageBuildModule> {
  return await import(buildModuleUrl) as WindowsLineageBuildModule;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) =>
    await rm(root, { recursive: true, force: true })));
});

describe("Windows update lineage build metadata", () => {
  it("embeds the exact final candidate executable digest for NSIS", async () => {
    const root = await mkdtemp(join(tmpdir(), "inertia-win-lineage-build-"));
    roots.push(root);
    const appOutDir = join(root, "win-unpacked");
    await mkdir(appOutDir);
    const executableBytes = Buffer.from("final resource-edited signed executable");
    await writeFile(join(appOutDir, "Inertia.exe"), executableBytes);
    const windowsOptions: { legalTrademarks?: string } = {};

    await (await buildModule()).bindWindowsInstallerToCandidateExecutable({
      appOutDir,
      electronPlatformName: "win32",
      packager: {
        appInfo: { productFilename: "Inertia" },
        platformSpecificBuildOptions: windowsOptions,
      },
    });

    const expectedDigest = createHash("sha256")
      .update(executableBytes)
      .digest("hex");
    expect(parseWindowsInstallerCandidateExecutableDigest(
      windowsOptions.legalTrademarks,
    )).toBe(expectedDigest);
    const installer = join(root, "Inertia.Setup.1.3.0.exe");
    await writeFile(installer, Buffer.concat([
      Buffer.from("signed-installer"),
      Buffer.from(windowsOptions.legalTrademarks!, "utf16le"),
      Buffer.alloc(2),
    ]));
    await expect((await buildModule()).verifyWindowsInstallerCandidateMarker(
      installer,
      windowsOptions.legalTrademarks!,
    )).resolves.toBeUndefined();
    await writeFile(installer, "installer without marker");
    await expect((await buildModule()).verifyWindowsInstallerCandidateMarker(
      installer,
      windowsOptions.legalTrademarks!,
    )).rejects.toThrow("omits its candidate lineage marker");
  });

  it("fails closed instead of overwriting unrelated version metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "inertia-win-lineage-build-"));
    roots.push(root);
    const appOutDir = join(root, "win-unpacked");
    await mkdir(appOutDir);
    await writeFile(join(appOutDir, "Inertia.exe"), "candidate");

    await expect((await buildModule())
      .bindWindowsInstallerToCandidateExecutable({
        appOutDir,
        electronPlatformName: "win32",
        packager: {
          appInfo: { productFilename: "Inertia" },
          platformSpecificBuildOptions: {
            legalTrademarks: "existing release metadata",
          },
        },
      })).rejects.toThrow("reserved for update lineage");
  });

  it("keeps the release config hook ahead of NSIS artifact verification", async () => {
    const config = await readFile(join(
      import.meta.dirname,
      "..",
      "..",
      "scripts",
      "electron-builder.release.cjs",
    ), "utf8");
    const lineageHook = config.indexOf("afterSign: bindWindowsCandidateLineage");
    const artifactHook = config.indexOf(
      "artifactBuildCompleted: verifyWindowsNsisPayload",
    );
    expect(lineageHook).toBeGreaterThan(0);
    expect(artifactHook).toBeGreaterThan(lineageHook);
  });

  it("is consumed after app signing and before the signed NSIS artifact gate", async () => {
    const platformPackager = await readFile(require.resolve(
      "app-builder-lib/out/platformPackager.js",
    ), "utf8");
    const packMethodStart = platformPackager.indexOf("async pack(");
    const doPackCall = platformPackager.indexOf(
      "await this.doPack(",
      packMethodStart,
    );
    const packageCall = platformPackager.indexOf(
      "this.packageInDistributableFormat(",
      doPackCall,
    );
    expect(doPackCall).toBeGreaterThan(packMethodStart);
    expect(packageCall).toBeGreaterThan(doPackCall);
    const doPackMethod = platformPackager.indexOf(
      "async doPack(",
      packageCall,
    );
    expect(packageCall).toBeLessThan(doPackMethod);
    const signingCall = platformPackager.indexOf(
      "await this.doSignAfterPack(",
      doPackMethod,
    );
    expect(signingCall).toBeGreaterThan(doPackMethod);

    const nsisTarget = await readFile(require.resolve(
      "app-builder-lib/out/targets/nsis/NsisTarget.js",
    ), "utf8");
    expect(nsisTarget).toContain(
      "this.packager.platformSpecificBuildOptions.legalTrademarks",
    );
    expect(nsisTarget).toContain('LegalTrademarks "');
    const installerSigning = nsisTarget.indexOf(
      "packager.signIf(installerPath)",
    );
    const artifactGate = nsisTarget.indexOf(
      "emitArtifactBuildCompleted",
      installerSigning,
    );
    expect(installerSigning).toBeGreaterThan(0);
    expect(artifactGate).toBeGreaterThan(installerSigning);
  });
});
