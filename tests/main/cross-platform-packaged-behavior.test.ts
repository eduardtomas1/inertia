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
    expect(normalizedReadme).toContain(
      "Building the current source for macOS requires macOS 13 or later.",
    );
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
      "run: npm run check:quality",
      "run: npm run build:packaged",
      "run: npm run test:native-architecture",
      "run: npm exec -- playwright test",
      "run: xvfb-run --auto-servernum npm exec -- playwright test",
      'run: npm run "${{ matrix.release_package_script }}"',
      'run: npm run "${{ matrix.package_script }}"',
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
      ["macOS x64", "macos-15-intel", "macos-x64", "x64", 55],
    ] as const) {
      const entry = workflowMatrixEntry(workflow, label);
      expect(entry).toContain(`runner: ${runner}`);
      expect(entry).toContain(`artifact: ${artifact}`);
      expect(entry).toContain(`arch: ${architecture}`);
      expect(entry).toContain(`timeout_minutes: ${timeout}`);
    }
  });

  it("proves quality once and keeps every platform's unit signal sharded or explicit", async () => {
    const workflow = await source(".github/workflows/ci.yml");

    // Migrations, architecture, lint, and types are platform independent, so
    // one gate job owns them and every expensive job waits on it.
    const qualityGate = workflowStep(
      workflow,
      "Verify migrations, architecture, lint, and types",
    );
    expect(qualityGate).toContain("run: npm run check:quality");
    expect(workflow.match(/^ {4}needs: gate$/gmu)).toHaveLength(3);

    // macOS is the only platform whose unit signal is a plain suite run: Linux
    // gets the same suite through coverage, and Windows gets it sharded.
    const macosUnits = workflowStep(workflow, "Run the unit suite");
    expect(macosUnits).toContain("if: runner.os == 'macOS'");
    expect(macosUnits).toContain("run: npm test");

    const linuxUnits = workflowStep(
      workflow,
      "Run the unit suite and enforce all-source coverage baselines",
    );
    expect(linuxUnits).toContain("if: runner.os == 'Linux'");
    expect(linuxUnits).toContain("run: npm run test:coverage");

    // The sharded windows-2025 job already runs the whole suite, so the x64
    // matrix entry must not repeat the portable subset. ARM64 has no sharded
    // job and therefore keeps it as its only Windows unit signal.
    const portable = workflowStep(
      workflow,
      "Run portable runtime and provider protocol suite",
    );
    expect(portable).toContain(
      "if: runner.os != 'Windows' || matrix.arch != 'x64'",
    );
    expect(portable).toContain("run: npm run test:portable");

    // Exactly one build per job, carrying notices and the guardian but not the
    // typecheck the gate already ran, and consumed by packaging unchanged.
    const build = workflowStep(workflow, "Build the application bundle");
    expect(build).toContain("run: npm run build:packaged");
    expect(workflow).not.toContain('run: npm run "${{ matrix.dist_script }}"');
    expect(workflow).not.toContain("run: npm run check:platform");

    expect(workflow).toContain("name: Windows unit tests (${{ matrix.shard }}/4)");
    expect(workflow).toContain("timeout-minutes: 30");
    expect(workflow).toContain("shard: [1, 2, 3, 4]");
    expect(workflow).toContain(
      "run: npm test -- --shard=${{ matrix.shard }}/4",
    );

    // Real-time scanning dominates hosted Windows install and fixture cost, so
    // both Windows jobs exclude the throwaway workspace without being able to
    // fail the run if the cmdlet is unavailable.
    expect(workflow.match(/Exclude the workspace from Microsoft Defender/gu))
      .toHaveLength(2);
    expect(workflow.match(/Add-MpPreference -ExclusionPath/gu)).toHaveLength(4);

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

    // Packaging consumes the build instead of repeating it, so every dist
    // script must stay a build followed by its own packaging script and no
    // packaging script may rebuild from source.
    for (const [target, packaged] of [
      ["dist:release:win", "package:release:win"],
      ["dist:release:win:arm64", "package:release:win:arm64"],
      ["dist:release:mac", "package:release:mac"],
      ["dist:release:mac:x64", "package:release:mac:x64"],
      ["dist:linux", "package:linux"],
      ["dist:linux:arm64", "package:linux:arm64"],
    ] as const) {
      expect(packageJson.scripts[target]).toBe(
        `npm run build && npm run ${packaged}`,
      );
      expect(packageJson.scripts[packaged]).toContain("electron-builder");
      expect(packageJson.scripts[packaged]).not.toContain("npm run build");
    }
    expect(packageJson.scripts["build:packaged"]).toBe(
      "npm run notices:generate && npm run build:bundle",
    );

    // These suites read the generated guardian, so each one builds it through
    // its own npm pre-hook rather than depending on an earlier CI step having
    // happened to build it first.
    for (const hook of ["pretest", "pretest:coverage", "pretest:portable"]) {
      expect(packageJson.scripts[hook]).toBe(
        "node scripts/build-runtime-process-guardian.mjs",
      );
    }

    // A partially restored dependency tree is worse than none, so the shared
    // install action pins the whole lockfile, runner, and Node identity into
    // one exact key and offers no restore-keys fallback.
    const install = await source(
      ".github/actions/install-dependencies/action.yml",
    );
    expect(install).toContain(
      "key: node-modules-${{ runner.os }}-${{ runner.arch }}-node${{ steps.node.outputs.node-version }}-${{ hashFiles('package-lock.json') }}",
    );
    expect(install).not.toContain("restore-keys");
    expect(install).toContain("if: steps.dependencies.outputs.cache-hit != 'true'");
    expect(install).toContain("run: node scripts/ensure-node-pty-helper.mjs");

    // The minimum-runtime job deliberately keeps an uncached engine-strict
    // install: proving npm ci itself succeeds on Node 22.13 is its purpose.
    const minimumRuntime = workflowStep(
      workflow,
      "Install locked dependencies without a cache",
    );
    expect(minimumRuntime).toContain("run: npm ci --engine-strict");
    expect(workflow.match(/uses: \.\/\.github\/actions\/install-dependencies/gu))
      .toHaveLength(3);

    const vitest = await source("vitest.config.ts");
    expect(vitest).toContain("maxWorkers: isWindowsCi ? windowsCiMaxWorkers : undefined");
    expect(vitest).toContain("INERTIA_VITEST_MAX_WORKERS");
    expect(vitest).toContain("testTimeout: isWindowsCi ? 30_000 : 15_000");

    // Specs that pin a window to the primary display share one machine
    // resource, so they are discovered rather than listed and run to
    // completion before anything else launches Electron.
    const playwright = await source("playwright.config.ts");
    expect(playwright).toContain('windowDisplay: "primary"');
    expect(playwright).toContain('name: "display-sensitive"');
    expect(playwright).toContain("workers: 1");
    expect(playwright).toContain('dependencies: ["display-sensitive"]');
    expect(playwright).toContain("INERTIA_E2E_WORKERS");
    // Deadlines scale with the number of concurrent Electron instances rather
    // than being retried until a flake passes.
    expect(playwright).toContain("const budgetScale = workers;");
    expect(playwright).toContain("timeout: 45_000 * budgetScale");
    expect(playwright).toContain("expect: { timeout: 15_000 * budgetScale }");
    expect(playwright).not.toContain("retries:");
  });

  it("keeps one native smoke implementation for macOS, Windows, and Linux runtime supervision", async () => {
    const smoke = await source("scripts/package-smoke.mjs");
    const launchContract = await source("scripts/package-smoke-launch.mjs");
    const main = await source("src/main/index.ts");
    const windowsJobBootstrap = await source(
      "src/main/runtime-windows-job-bootstrap.ts",
    );
    const windowsJob = await source("src/main/windows-runtime-job.ts");
    const windowsJobNative = await source(
      "native/runtime-process-guardian/windows.cs",
    );
    const processSafety = await source("src/main/runtime-supervisor-process-safety.ts");
    expect(smoke).toContain(
      'import { createHash, randomUUID } from "node:crypto";',
    );
    expect(smoke).toContain('process.platform === "darwin"');
    expect(smoke).toContain('process.platform === "win32"');
    expect(smoke).toContain('process.platform === "linux"');
    expect(smoke).toContain(
      "`The packaged ${process.platform} runtime process guardian is missing or invalid.`",
    );
    expect(smoke).toContain('"runtime-process-guardian"');
    expect(smoke).toContain('"windows-runtime-job.exe"');
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
    expect(windowsJobNative).toContain("FileShare.Read");
    expect(windowsJobNative).toContain("OpenVerifiedExecutable(");
    expect(windowsJobNative).toContain(
      "using (var executable = OpenVerifiedExecutable(",
    );
    expect(windowsJobNative).toContain("Process.GetProcessById(");
    expect(windowsJob).toContain('"guard"');
    expect(windowsJob).toContain('"recover"');
    expect(windowsJob).toContain("[IO.FileShare]::Read");
    expect(windowsJob).toContain("-EncodedCommand");
    expect(windowsJob).toContain(
      "$loadedAssembly = [Reflection.Assembly]::Load($assemblyBytes)",
    );
    expect(windowsJob).toContain("$beginGuardMethod.Invoke(");
    expect(windowsJob).not.toContain("[InertiaRuntimeJob]::");
    expect(windowsJob).not.toContain("Diagnostics.ProcessStartInfo");
    expect(windowsJob).toContain("[Console]::In.ReadLine()");
    expect(windowsJob).toContain("EXECUTABLE_LOCK_SHUTDOWN");
    expect(windowsJob).toContain("EXECUTABLE_LOCK_BYE_MARKER");
    expect(windowsJobNative).toContain("while (Console.In.Read() != -1)");
    expect(main).toContain("await prepareWindowsRuntimeJobExecutableLock(");
    expect(main.indexOf("await prepareWindowsRuntimeJobExecutableLock("))
      .toBeLessThan(main.indexOf("runtimeSupervisor = new RuntimeSupervisor("));
    expect(main).toContain("await disposeWindowsRuntimeJobExecutableLock()");
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
    expect(releaseUpdates).toContain("loadElectronAppUpdater(channel, {");
    expect(releaseUpdates).toContain("activeAppImagePath: options.activeAppImagePath");
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
    expect(workflow).toContain(
      '["Linux guardian toolchain", process.env.GUARDIAN_TOOLCHAIN_OUTCOME]',
    );
    expect(workflow).toContain(
      "sudo apt-get install --no-install-recommends --yes binutils linux-libc-dev musl-tools=1.2.4-2",
    );
    expect(workflow).toContain("npm run pretest");
    expect(workflow.match(/--connect-timeout 20 --max-time 120/gu)).toHaveLength(2);
  });
});
