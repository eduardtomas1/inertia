import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = process.cwd();

async function source(path: string): Promise<string> {
  return readFile(join(repositoryRoot, path), "utf8");
}

function workflowStep(workflow: string, name: string): string {
  const marker = `      - name: ${name}`;
  const start = workflow.indexOf(marker);
  const end = workflow.indexOf("\n      - name:", start + marker.length);
  return workflow.slice(start, end < 0 ? undefined : end);
}

function workflowMatrixEntry(workflow: string, label: string): string {
  const marker = `          - label: ${label}`;
  const start = workflow.indexOf(marker);
  if (start < 0) throw new Error(`Missing CI matrix entry for ${label}.`);
  const boundaries = [
    workflow.indexOf("\n          - label:", start + marker.length),
    workflow.indexOf("\n    env:", start + marker.length),
  ].filter((boundary) => boundary >= 0);
  if (boundaries.length === 0) {
    throw new Error(`Unbounded CI matrix entry for ${label}.`);
  }
  return workflow.slice(start, Math.min(...boundaries));
}

describe("cross-platform packaged behavior contract", () => {
  it("keeps one authoritative stable-only Discord release notifier", async () => {
    const workflowDirectory = join(repositoryRoot, ".github/workflows");
    const workflowNames = (await readdir(workflowDirectory))
      .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
      .sort();
    expect(workflowNames).not.toContain("discord-release.yml");

    const notifierWorkflows: string[] = [];
    let notifierJobs = 0;
    for (const name of workflowNames) {
      const workflow = await source(`.github/workflows/${name}`);
      if (workflow.includes("DISCORD_WEBHOOK_URL")) notifierWorkflows.push(name);
      notifierJobs += workflow.match(/^  notify-discord:\s*$/gmu)?.length ?? 0;
    }
    expect(notifierWorkflows).toEqual(["release-platforms.yml"]);
    expect(notifierJobs).toBe(1);

    const releaseWorkflow = await source(".github/workflows/release-platforms.yml");
    const notifierStart = releaseWorkflow.indexOf("\n  notify-discord:");
    expect(notifierStart).toBeGreaterThanOrEqual(0);
    const notifier = releaseWorkflow.slice(notifierStart);
    expect(notifier).toContain("needs: upload");
    expect(notifier).toContain(
      "if: ${{ !startsWith(inputs.release_tag || github.ref_name, 'canary-v') }}",
    );
    expect(notifier).toContain("DISCORD_WEBHOOK_URL: ${{ secrets.DISCORD_WEBHOOK_URL }}");
  });

  it("keeps Canary packages behind the full smoke, fuse, checksum, provenance, and atomic-feed gate", async () => {
    const workflow = await source(".github/workflows/release-platforms.yml");
    for (const expected of [
      '- "canary-v*.*.*"',
      "INERTIA_RELEASE_CHANNEL:",
      "npm run verify:fuses -- \"$app\"",
      "run: npm run test:package-smoke",
      "run: xvfb-run --auto-servernum npm run test:package-smoke",
      "node scripts/release-assets.mjs finalize",
      "actions/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8",
      "node scripts/prepare-canary-feed.mjs",
      "--prerelease --latest=false",
      "HEAD:canary-feed",
    ]) {
      expect(workflow).toContain(expected);
    }
  });

  it("keeps deterministic exact-head Canary screenshot wiring", async () => {
    const readme = await source("README.md");
    expect(readme).toContain("### Canary release channel");
    expect(readme).toContain(
      "![Inertia Canary channel status and rollback controls](docs/screenshots/inertia-canary-channel.png)",
    );

    const scenario = await source("tests/e2e/canary-channel.spec.ts");
    expect(scenario).toContain("process.env.INERTIA_CANARY_SCREENSHOT_PATH");
    expect(scenario).toContain("INERTIA_CANARY_SCREENSHOT_PATH must be absolute");
    expect(scenario).toContain("await copyFile(evidence, requestedPath)");
    const screenshot = await readFile(join(
      repositoryRoot,
      "docs/screenshots/inertia-canary-channel.png",
    ));
    expect([...screenshot.subarray(0, 8)]).toEqual([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
    ]);
  });

  it("documents six checksum-first native choices without disabling platform security", async () => {
    const readme = await source("README.md");
    const normalizedReadme = readme.replace(/\s+/gu, " ");
    for (const choice of [
      "| macOS | Apple silicon (arm64) |",
      "| macOS | Intel (x64) |",
      "| Windows | x64 |",
      "| Windows | ARM64 |",
      "| Linux | x64 |",
      "| Linux | ARM64 |",
    ]) {
      expect(normalizedReadme).toContain(choice);
    }
    for (const expected of [
      "SHA256SUMS.txt",
      "System Settings → Privacy & Security → Open Anyway",
      "Do not remove quarantine attributes or disable Gatekeeper.",
      "Windows protected your PC",
      "More info",
      "Unknown publisher",
      "Run anyway",
    ]) {
      expect(normalizedReadme).toContain(expected);
    }
    expect(normalizedReadme).toContain("Do not disable SmartScreen.");
    expect(readme).not.toContain("xattr");
    expect(readme).not.toContain("spctl --master-disable");

    const releasing = await source("docs/RELEASING.md");
    const normalizedReleasing = releasing.replace(/\s+/gu, " ");
    expect(normalizedReleasing).toContain("credential-free public union is exactly 11");
    expect(normalizedReleasing).toContain("Manual macOS and Windows releases do not publish");
    expect(normalizedReleasing).toContain(
      "Do not strip quarantine attributes or disable Gatekeeper.",
    );
    expect(normalizedReleasing).toContain("Do not disable SmartScreen.");
    expect(releasing).not.toContain("xattr");
    expect(releasing).not.toContain("spctl --master-disable");
  });

  it("keeps build, Electron E2E, fuse verification, and native smoke on all six CI targets", async () => {
    const workflow = await source(".github/workflows/ci.yml");
    for (const expected of [
      "runner: ubuntu-24.04",
      "runner: ubuntu-24.04-arm",
      "runner: windows-2025",
      "runner: windows-11-arm",
      "runner: macos-15",
      "runner: macos-15-intel",
      "run: npm run check",
      "run: npm run test:native-architecture",
      "run: npm exec -- playwright test",
      "run: xvfb-run --auto-servernum npm exec -- playwright test",
      'run: npm run "${{ matrix.release_dist_script }}"',
      'run: npm run "${{ matrix.dist_script }}"',
      "npm run verify:fuses -- \"$app\"",
      "run: npm run test:package-smoke",
      "run: xvfb-run --auto-servernum npm run test:package-smoke",
    ]) {
      expect(workflow).toContain(expected);
    }
  });

  it("keeps every native architecture CI target explicitly bounded", async () => {
    const workflow = await source(".github/workflows/ci.yml");
    expect(workflow).toContain(
      "timeout-minutes: ${{ matrix.timeout_minutes }}",
    );
    for (const [label, runner, artifact, architecture, timeout] of [
      ["Linux x64", "ubuntu-24.04", "linux-x64", "x64", 40],
      ["Linux ARM64", "ubuntu-24.04-arm", "linux-arm64", "arm64", 55],
      ["Windows x64", "windows-2025", "windows-x64", "x64", 55],
      ["Windows ARM64", "windows-11-arm", "windows-arm64", "arm64", 70],
      ["macOS arm64", "macos-15", "macos-arm64", "arm64", 40],
      ["macOS x64", "macos-15-intel", "macos-x64", "x64", 45],
    ] as const) {
      const entry = workflowMatrixEntry(workflow, label);
      expect(entry).toContain(`runner: ${runner}`);
      expect(entry).toContain(`artifact: ${artifact}`);
      expect(entry).toContain(`arch: ${architecture}`);
      expect(entry).toContain(`timeout_minutes: ${timeout}`);
    }
  });

  it("shards ordinary Windows units and runs the complete gate for release candidates", async () => {
    const workflow = await source(".github/workflows/ci.yml");
    const ordinaryCheck = workflowStep(
      workflow,
      "Typecheck, unit test, and build",
    );
    expect(ordinaryCheck).toContain("if: runner.os != 'Windows'");
    expect(ordinaryCheck).toContain("run: npm run check");

    const windowsPlatformCheck = workflowStep(
      workflow,
      "Typecheck and build the Windows platform gate",
    );
    expect(windowsPlatformCheck).toContain("runner.os == 'Windows'");
    expect(windowsPlatformCheck).toContain(
      "!startsWith(github.head_ref, 'codex/release-')",
    );
    expect(windowsPlatformCheck).toContain("run: npm run check:platform");

    const windowsReleaseCheck = workflowStep(
      workflow,
      "Run the complete Windows release-candidate gate",
    );
    expect(windowsReleaseCheck).toContain("runner.os == 'Windows'");
    expect(windowsReleaseCheck).toContain(
      "startsWith(github.head_ref, 'codex/release-')",
    );
    expect(windowsReleaseCheck).toContain("run: npm run check");

    expect(workflow).toContain("name: Windows unit tests (${{ matrix.shard }}/2)");
    expect(workflow).toContain("timeout-minutes: 30");
    expect(workflow).toContain("shard: [1, 2]");
    expect(workflow).toContain(
      "run: npm test -- --shard=${{ matrix.shard }}/2",
    );

    const packageJson = JSON.parse(await source("package.json")) as {
      build: { files: string[] };
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts["check:platform"]).toBe(
      "npm run check:quality && npm run check:private-connect && npm run build:bundle",
    );
    expect(packageJson.scripts["prebuild:bundle"]).toBe(
      "node scripts/build-runtime-process-guardian.mjs",
    );
    expect(packageJson.scripts.check).toBe(
      "npm run check:quality && npm run test && npm run check:private-connect && npm run build:bundle",
    );
    expect(packageJson.build.files).toContain(
      "resources/generated/windows-runtime-job-integrity.json",
    );

    const vitest = await source("vitest.config.ts");
    expect(vitest).toContain("maxWorkers: isWindowsCi ? 1 : undefined");
  });

  it("keeps one native smoke implementation for macOS, Windows, and Linux runtime supervision", async () => {
    const smoke = await source("scripts/package-smoke.mjs");
    const launchContract = await source("scripts/package-smoke-launch.mjs");
    const main = await source("src/main/index.ts");
    const windowsJobBootstrap = await source(
      "src/main/runtime-windows-job-bootstrap.ts",
    );
    const windowsJob = await source("src/main/windows-runtime-job.ts");
    const processSafety = await source("src/main/runtime-supervisor-process-safety.ts");
    expect(smoke).toContain('process.platform === "darwin"');
    expect(smoke).toContain('process.platform === "win32"');
    expect(smoke).toContain('process.platform === "linux"');
    expect(smoke).toContain(
      "`The packaged ${process.platform} runtime process guardian is missing or invalid.`",
    );
    expect(smoke).toContain('"runtime-process-guardian"');
    expect(smoke).toContain('"windows-runtime-job.dll"');
    expect(smoke).toContain("MAX_RUNTIME_GUARDIAN_BYTES");
    expect(smoke).toContain('spawnSync(guardian, ["seccomp-selftest"]');
    expect(smoke).toContain(
      "The packaged Linux runtime process guardian self-test failed.",
    );
    expect(smoke).toContain(
      "The packaged Windows runtime Job Object assembly is missing or invalid.",
    );
    expect(smoke).toContain(
      "The packaged Windows runtime Job Object assembly failed protected byte-identity verification.",
    );
    expect(smoke).toContain(
      '["resources", "generated", "windows-runtime-job-integrity.json"]',
    );
    expect(main).toContain("resolveDesktopRuntimeProcessSafetyAssets");
    expect(windowsJobBootstrap).toContain(
      "resolveRequiredRuntimeProcessGuardianPath",
    );
    expect(windowsJobBootstrap).toContain(
      "resolveRequiredWindowsRuntimeJobAssembly",
    );
    expect(windowsJobBootstrap).toContain("resourcesPath: process.resourcesPath");
    expect(windowsJobBootstrap).toContain("appPath: app.getAppPath()");
    expect(windowsJob).not.toContain("process.cwd()");
    expect(windowsJob).toContain("windows-runtime-job-integrity.json");
    expect(windowsJob).toContain("timingSafeEqual(actual, expected)");
    expect(windowsJob).toContain("[IO.FileShare]::Read");
    expect(windowsJob).toContain("[Reflection.Assembly]::Load($assemblyBytes)");
    expect(processSafety).toContain("configuration.windowsRuntimeJobAssembly");
    expect(smoke).toContain('process.arch === "x64" ? "" : `-${process.arch}`');
    expect(smoke).toContain(
      "mkdir(dataDirectory, { recursive: true, mode: 0o700 })",
    );
    expect(smoke).toContain(
      'process.platform === "darwin" ? ["--use-mock-keychain"] : []',
    );
    expect(launchContract).toContain("runtimePid === mainPid");
    expect(smoke).toContain("runtime-stopped");
    expect(smoke.indexOf('"before-quit"')).toBeLessThan(
      smoke.indexOf("const exit = await withTimeout("),
    );
    expect(smoke).toContain(
      "The packaged app did not finish shutdown after before-quit.",
    );
    expect(smoke).toContain("const shutdownStartedAt = beforeQuit.timestampMs");
    expect(smoke).toContain("launchToRuntimeReadyMs: readiness.timestampMs - launchedAt");
    expect(smoke).toContain("shutdownToProcessExitMs: exit.endedAt - shutdownStartedAt");
    expect(smoke).toContain("postExitCleanupMs: cleanupCompletedAt - exit.endedAt");
    expect(smoke).toContain("endedAt: Date.now()");
    expect(smoke).toContain("process-group cleanup");
    expect(smoke).toContain("Packaged Codex Ω (profile)");
    expect(smoke).toContain('join(root, "codex-bin")');
    expect(smoke).toContain("acknowledged:");
    expect(smoke).toContain('type: "provider.refresh"');
    expect(smoke).toContain('frame?.type === "runtime.event" ? frame.event : frame');
    expect(smoke).toContain("INERTIA_PACKAGE_SMOKE_PDF_INPUT");
    expect(smoke).toContain("packaged PDF extraction result");
    expect(smoke).toContain("const PACKAGED_PDF_TIMEOUT_MS = 47_000;");
    expect(smoke).toContain("PACKAGED_PDF_TIMEOUT_MS,");
    expect(smoke).toContain("pdfExtraction=true");
    expect(main).toContain(
      "codexBinaryPath: packageSmokeCodexExecutable",
    );
    const runtimeForkStart = main.indexOf(
      "spawn: () => utilityProcess.fork(",
    );
    const runtimeFork = main.slice(runtimeForkStart, runtimeForkStart + 500);
    expect(runtimeForkStart).toBeGreaterThanOrEqual(0);
    expect(runtimeFork).toContain("env: runtimeBootstrap.runtimeProcessEnvironment(),");
    expect(main.match(/timestampMs: Date\.now\(\)/gu)).toHaveLength(2);
    expect(main).toContain("packageSmokePdf:");
    expect(main).toContain("waitForRequestedPackageSmokeResults({");
    const results = await source("src/main/package-smoke-results.ts");
    expect(results).toContain("options.timeoutMs ?? 47_000");
    const worker = await source("src/server/runtime-worker.ts");
    const readiness = worker.lastIndexOf('type: "runtime.ready"');
    const pdfSmoke = worker.lastIndexOf("packageSmokePdfOperation = runPackagedPdfSmoke(");
    expect(readiness).toBeGreaterThanOrEqual(0);
    expect(pdfSmoke).toBeGreaterThan(readiness);
    expect(worker).toContain("packageSmokePdfController?.abort(");
    expect(worker).toContain("packageSmokePdfOperation?.catch(() => undefined)");
    expect(results).toContain("JSON.parse(await readFile(path, \"utf8\"))");
  });

  it("fails closed when packaged updater wiring or the test network boundary drifts", async () => {
    const packageJson = JSON.parse(await source("package.json")) as {
      inertiaReleaseChannel?: unknown;
      build: { publish?: unknown; extraMetadata?: unknown };
    };
    expect(packageJson.inertiaReleaseChannel).toBe("stable");
    expect(packageJson.build.publish).toEqual([{
      provider: "generic",
      url: "https://github.com/eduardtomas1/inertia/releases/latest/download",
    }]);
    expect(packageJson.build.extraMetadata).toBeUndefined();

    const smoke = await source("scripts/package-smoke.mjs");
    expect(smoke).toContain('["node_modules", "electron-updater", "package.json"]');
    expect(smoke).toContain('["node_modules", "electron-updater", "out", "main.js"]');
    expect(smoke).toContain("The externalized electron-updater production package is incomplete.");
    expect(smoke).toContain('join(resourcesDirectory, "app-update.yml")');
    expect(smoke).toContain('configuration.provider !== "generic"');
    expect(smoke).toContain(
      '"https://github.com/eduardtomas1/inertia/releases/latest/download"',
    );
    expect(smoke).toContain("capability.delivery === \"in-app\"");
    expect(smoke).toContain("MANUAL_UPDATE_REASONS.has(marker.reason)");
    expect(smoke).toContain('`--proxy-server=${updateNetworkTrap.proxy}`');
    expect(smoke).toContain('"api.github.com"');
    expect(smoke).toContain('"github.com"');
    expect(smoke).toContain('"raw.githubusercontent.com"');
    expect(smoke).toContain('"release-assets.githubusercontent.com"');
    expect(smoke).toContain("updateNetworkTrap.assertNoUpdateRequests()");

    const main = await source("src/main/index.ts");
    const capabilityStart = main.indexOf("const appUpdateCapability =");
    const serviceStart = main.indexOf("initializeReleaseUpdates({", capabilityStart);
    const bootstrapUpdateBoundary = main.slice(capabilityStart, serviceStart + 700);
    expect(capabilityStart).toBeGreaterThanOrEqual(0);
    expect(serviceStart).toBeGreaterThan(capabilityStart);
    expect(bootstrapUpdateBoundary).toContain('process.env.NODE_ENV === "test"');
    expect(bootstrapUpdateBoundary).toContain('delivery: "manual" as const');
    expect(bootstrapUpdateBoundary).toContain("resolveAppUpdateCapability({");
    expect(bootstrapUpdateBoundary).toContain("fetch: net.fetch as typeof globalThis.fetch");
    const releaseUpdates = await source("src/main/release-updates.ts");
    expect(releaseUpdates).toContain('channel === "canary"');
    expect(releaseUpdates).toContain("{ version:");
    expect(releaseUpdates).toContain("{ tag_name:");
    expect(releaseUpdates).toContain("loadElectronAppUpdater(channel)");
  });

  it("registers runtime socket handlers before sending the first hydration frame", async () => {
    const boundary = await source("src/server/runtime/websocket-boundary.ts");
    const start = boundary.indexOf('webSockets.on("connection"');
    const end = boundary.indexOf("\n  return {", start);
    const connectionHandler = boundary.slice(start, end);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(connectionHandler.indexOf('socket.on("message"')).toBeLessThan(
      connectionHandler.indexOf("runtimeSync.connect("),
    );
  });

  it("keeps attachment cleanup behind runtime ownership and shutdown", async () => {
    const main = await source("src/main/index.ts");
    const closedStart = main.indexOf('window.on("closed"');
    const closedEnd = main.indexOf("\n  });", closedStart);
    const closedHandler = main.slice(closedStart, closedEnd);
    expect(closedStart).toBeGreaterThanOrEqual(0);
    expect(closedHandler).not.toContain("disposeImportedAttachments");

    const releaseCoordination = await source(
      "src/main/attachment-release-coordination.ts",
    );
    const releaseFunction = releaseCoordination.slice(
      releaseCoordination.indexOf("export async function releaseRendererAttachment"),
    );
    expect(releaseFunction.indexOf("deferAttachmentRelease")).toBeLessThan(
      releaseFunction.indexOf("releaseFromRenderer"),
    );

    const cleanupStart = main.indexOf("function runPrivilegedCleanup()");
    const cleanupEnd = main.indexOf("\nasync function bootstrap()", cleanupStart);
    const cleanupHandler = main.slice(cleanupStart, cleanupEnd);
    expect(cleanupStart).toBeGreaterThanOrEqual(0);
    expect(cleanupHandler).toContain("cleanupPrivilegedOwners({");
    expect(cleanupHandler).toContain("runtime: supervisorToStop");
    expect(cleanupHandler).toContain(
      "disposeTemporaryAttachments: disposeImportedAttachments",
    );
    expect(cleanupHandler).toContain(
      "Retaining temporary attachments because runtime process exit was not confirmed",
    );
    expect(cleanupHandler.indexOf("conversationAttachments = null"))
      .toBeLessThan(cleanupHandler.indexOf("closeConversationAttachmentAccess"));

    const privilegedShutdown = await source("src/main/privileged-shutdown.ts");
    const sequenceStart = privilegedShutdown.indexOf(
      "export async function runPrivilegedCleanupSequence",
    );
    const sequenceEnd = privilegedShutdown.indexOf(
      "\nexport function cleanupPrivilegedOwners",
      sequenceStart,
    );
    const cleanupSequence = privilegedShutdown.slice(sequenceStart, sequenceEnd);
    expect(sequenceStart).toBeGreaterThanOrEqual(0);
    expect(cleanupSequence.indexOf("stopRuntimeAndPrivateConnect(")).toBeLessThan(
      cleanupSequence.indexOf("options.disposeTemporaryAttachments()"),
    );
    expect(cleanupSequence).toContain("if (runtimeExitConfirmed)");
    const quitStart = main.indexOf('app.on("before-quit"');
    const quitEnd = main.indexOf("\n  });", quitStart);
    const quitHandler = main.slice(quitStart, quitEnd);
    expect(quitHandler).toContain("appUpdateInstallCoordinator?.allowBeforeQuit()");
    expect(quitHandler).toContain("runPrivilegedCleanup().then(finishQuitAfterCleanup");
    expect(main.indexOf("conversationAttachments = null")).toBeLessThan(
      main.indexOf("closeConversationAttachmentAccess(retainedAttachments)"),
    );
    expect(main).not.toContain("finally(finishQuitAfterCleanup)");
    expect(main.indexOf('recordPackageSmokeStage("app-exit")')).toBeLessThan(
      main.indexOf("process.exit(0)"),
    );
    expect(main.indexOf("windowToClose.destroy()")).toBeLessThan(
      main.indexOf('recordPackageSmokeStage("app-exit")'),
    );
    expect(main).not.toContain("app.exit(0)");
    expect(main).toContain("attachmentReservation = orphanReservation");
    expect(main).toContain(
      "reservedRecords: attachmentReservation.records",
    );
    expect(main).toContain(
      "reservedBytes: attachmentReservation.bytes",
    );
  });

  it("destroys native previews when the renderer reloads or exits", async () => {
    const main = await source("src/main/index.ts");
    expect(main).toContain('window.webContents.on("did-start-navigation"');
    expect(main).toContain(
      "if (details.isMainFrame && !details.isSameDocument) previewBroker.close()",
    );
    expect(main).toContain(
      'window.webContents.on("render-process-gone", () => previewBroker.close())',
    );
  });

  it("keeps exact-tag release packages and smoke validation aligned across every platform", async () => {
    const workflow = await source(".github/workflows/release-platforms.yml");
    for (const expected of [
      'tags:',
      '- "v*.*.*"',
      "dist_script: dist:release:mac",
      "dist_script: dist:release:mac:x64",
      "dist_script: dist:release:win",
      "dist_script: dist:release:win:arm64",
      "dist_script: dist:release:linux",
      "dist_script: dist:release:linux:arm64",
      "name: release-macos-x64",
      "name: release-macos-arm64",
      "name: release-windows-x64",
      "name: release-windows-arm64",
      "name: release-linux-x64",
      "name: release-linux-arm64",
      "node scripts/validate-release.mjs",
      "run: npm run test:package-smoke",
      "run: xvfb-run --auto-servernum npm run test:package-smoke",
      "codesign --verify --deep --strict",
      "xcrun stapler validate",
      "Get-AuthenticodeSignature",
      "Install locked release-validation dependencies",
      "run: npm ci --ignore-scripts",
    ]) {
      expect(workflow).toContain(expected);
    }
    expect(workflow).toContain("MACOS_APPLE_API_KEY_BASE64");
    expect(workflow).toContain("WINDOWS_CSC_LINK");
    expect(workflow).not.toContain("BEGIN PRIVATE KEY");
    for (const [label, runner, platform, architecture, distScript] of [
      ["macOS x64", "macos-15-intel", "macos-x64", "x64", "dist:release:mac:x64"],
      ["macOS arm64", "macos-15", "macos-arm64", "arm64", "dist:release:mac"],
      ["Windows x64", "windows-2025", "windows-x64", "x64", "dist:release:win"],
      ["Windows ARM64", "windows-11-arm", "windows-arm64", "arm64", "dist:release:win:arm64"],
      ["Linux x64", "ubuntu-24.04", "linux-x64", "x64", "dist:release:linux"],
      ["Linux ARM64", "ubuntu-24.04-arm", "linux-arm64", "arm64", "dist:release:linux:arm64"],
    ] as const) {
      const entry = workflowMatrixEntry(workflow, label);
      expect(entry).toContain(`runner: ${runner}`);
      expect(entry).toContain(`platform: ${platform}`);
      expect(entry).toContain(`arch: ${architecture}`);
      expect(entry).toContain(`dist_script: ${distScript}`);
    }

    const macBuild = workflowStep(workflow, "Build macOS release package");
    expect(macBuild).toContain("if: runner.os == 'macOS'");
    expect(macBuild).toContain("MACOS_CSC_LINK");
    expect(macBuild).toContain('if [[ -z "${!name:-}" ]]');
    expect(macBuild).toContain('unset "$name"');
    expect(macBuild).not.toContain("WINDOWS_CSC_LINK");

    const windowsBuild = workflowStep(workflow, "Build Windows release package");
    expect(windowsBuild).toContain("if: runner.os == 'Windows'");
    expect(windowsBuild).toContain("WINDOWS_CSC_LINK");
    expect(windowsBuild).toContain('if [[ -z "${!name:-}" ]]');
    expect(windowsBuild).toContain('unset "$name"');
    expect(windowsBuild).not.toContain("MACOS_CSC_LINK");

    const linuxBuild = workflowStep(workflow, "Build Linux release package");
    expect(linuxBuild).toContain("if: runner.os == 'Linux'");
    expect(linuxBuild).not.toContain("_CSC_");
    expect(linuxBuild).not.toContain("APPLE_API_");

    const releaseUpload = workflowStep(
      workflow,
      "Upload without replacing existing assets",
    );
    expect(releaseUpload).toContain(
      'gh api --paginate -H "Cache-Control: no-cache"',
    );
    expect(releaseUpload).toContain(
      '"repos/$GITHUB_REPOSITORY/releases?per_page=100"',
    );
    expect(releaseUpload).toContain(
      'gh api "repos/$GITHUB_REPOSITORY/releases/$release_id"',
    );
    expect(releaseUpload).toContain("load_release_by_tag_with_retry");
    expect(releaseUpload).toContain("for attempt in {1..7}; do");
    expect(releaseUpload).toContain('sleep "$delay"');
    expect(releaseUpload).not.toContain("releases/tags/$RELEASE_TAG");
  });

  it("supervises the native PTY architecture probe outside the binding process", async () => {
    const verifier = await source("scripts/verify-native-architecture.mjs");
    const architectureInspector = await source("scripts/native-binary-architecture.mjs");
    const helper = await source("scripts/native-pty-probe.mjs");
    expect(verifier).not.toContain('from "node-pty"');
    expect(verifier).toContain("inspectNativeBinaryArchitecture(claudeExecutable");
    expect(verifier).not.toContain("claudeExecutable, [\"--version\"]");
    expect(verifier).toContain('"native-pty-probe.mjs"');
    expect(verifier).toContain("probeNativeExecutable(");
    expect(verifier.match(/probeNativeExecutable\(/gu)).toHaveLength(1);
    expect(architectureInspector).toContain("NATIVE_HEADER_READ_LIMIT");
    expect(architectureInspector).toContain("await handle.read(");
    expect(architectureInspector).not.toContain('node:child_process');
    expect(helper).toContain('from "node-pty"');
    expect(helper).toContain("spawnPty(executable, args");
  });

  it("runs the real Kimi suite only when its CI secret is explicitly available", async () => {
    const workflow = await source(".github/workflows/ci.yml");
    expect(workflow).toContain("Run opt-in Kimi through Claude integration");
    expect(workflow).toContain(
      "INERTIA_KIMI_CODE_API_KEY: ${{ secrets.INERTIA_KIMI_CODE_API_KEY }}",
    );
    expect(workflow).toContain('if [[ -z "${INERTIA_KIMI_CODE_API_KEY:-}" ]]');
    expect(workflow).toContain("INERTIA_RUN_KIMI_CLAUDE_INTEGRATION=1");
    expect(workflow).toContain(
      "vitest run tests/server/kimi-claude-real-smoke.test.ts",
    );
  });

  it("reports provider drift even when result collection never runs", async () => {
    const workflow = await source(".github/workflows/provider-contract-drift.yml");
    expect(workflow).toContain(
      "needs.provider-drift.result != 'success' || needs.provider-drift.outputs.failed != 'false'",
    );
    expect(workflow).toContain(
      "PROVIDER_DRIFT_RESULT: ${{ needs.provider-drift.result }}",
    );
    expect(workflow).toContain(
      '["Canary job", process.env.PROVIDER_DRIFT_RESULT]',
    );
    expect(workflow.match(/--connect-timeout 20 --max-time 120/gu)).toHaveLength(2);
  });
});
