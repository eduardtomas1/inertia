import { readFile } from "node:fs/promises";
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
  it("keeps build, Electron E2E, fuse verification, and native smoke on all three CI platforms", async () => {
    const workflow = await source(".github/workflows/ci.yml");
    for (const expected of [
      "runner: ubuntu-24.04",
      "runner: windows-2025",
      "runner: macos-15",
      "run: npm run check",
      "run: npm exec -- playwright test",
      "run: xvfb-run --auto-servernum npm exec -- playwright test",
      "run: npm run dist:dir",
      "run: npm run dist:linux",
      "npm run verify:fuses -- \"$app\"",
      "run: npm run test:package-smoke",
      "run: xvfb-run --auto-servernum npm run test:package-smoke",
    ]) {
      expect(workflow).toContain(expected);
    }
  });

  it("keeps Windows CI bounded through its complete platform gate", async () => {
    const workflow = await source(".github/workflows/ci.yml");
    expect(workflow).toContain(
      "timeout-minutes: ${{ matrix.timeout_minutes }}",
    );
    for (const [label, runner, artifact, timeout] of [
      ["Linux x64", "ubuntu-24.04", "linux-x64", 40],
      ["Windows x64", "windows-2025", "windows-x64", 55],
      ["macOS arm64", "macos-15", "macos-arm64", 40],
    ] as const) {
      const entry = workflowMatrixEntry(workflow, label);
      expect(entry).toContain(`runner: ${runner}`);
      expect(entry).toContain(`artifact: ${artifact}`);
      expect(entry).toContain(`timeout_minutes: ${timeout}`);
    }
  });

  it("shards the full Windows unit suite without restoring native fixture contention", async () => {
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
    expect(windowsPlatformCheck).toContain("if: runner.os == 'Windows'");
    expect(windowsPlatformCheck).toContain("run: npm run check:platform");

    expect(workflow).toContain("name: Windows unit tests (${{ matrix.shard }}/2)");
    expect(workflow).toContain("timeout-minutes: 30");
    expect(workflow).toContain("shard: [1, 2]");
    expect(workflow).toContain(
      "run: npm test -- --shard=${{ matrix.shard }}/2",
    );

    const packageJson = JSON.parse(await source("package.json")) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts["check:platform"]).toBe(
      "npm run check:quality && npm run check:private-connect && npm run build:bundle",
    );
    expect(packageJson.scripts.check).toBe(
      "npm run check:quality && npm run test && npm run check:private-connect && npm run build:bundle",
    );

    const vitest = await source("vitest.config.ts");
    expect(vitest).toContain("maxWorkers: isWindowsCi ? 1 : undefined");
  });

  it("keeps one native smoke implementation for macOS, Windows, and Linux runtime supervision", async () => {
    const smoke = await source("scripts/package-smoke.mjs");
    expect(smoke).toContain('process.platform === "darwin"');
    expect(smoke).toContain('process.platform === "win32"');
    expect(smoke).toContain('process.platform === "linux"');
    expect(smoke).toContain(
      "mkdir(dataDirectory, { recursive: true, mode: 0o700 })",
    );
    expect(smoke).toContain(
      'process.platform === "darwin" ? ["--use-mock-keychain"] : []',
    );
    expect(smoke).toContain("runtimePid === mainPid");
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
    const main = await source("src/main/index.ts");
    expect(main).toContain(
      "codexBinaryPath: packageSmokeCodexExecutable",
    );
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
    expect(smoke).toContain('"release-assets.githubusercontent.com"');
    expect(smoke).toContain("updateNetworkTrap.assertNoUpdateRequests()");

    const main = await source("src/main/index.ts");
    const capabilityStart = main.indexOf("const appUpdateCapability =");
    const serviceStart = main.indexOf("appUpdateService = new AppUpdateService", capabilityStart);
    const bootstrapUpdateBoundary = main.slice(capabilityStart, serviceStart + 900);
    expect(capabilityStart).toBeGreaterThanOrEqual(0);
    expect(serviceStart).toBeGreaterThan(capabilityStart);
    expect(bootstrapUpdateBoundary).toContain('process.env.NODE_ENV === "test"');
    expect(bootstrapUpdateBoundary).toContain('delivery: "manual" as const');
    expect(bootstrapUpdateBoundary).toContain("resolveAppUpdateCapability({");
    expect(bootstrapUpdateBoundary).toContain("tag_name:");
    expect(bootstrapUpdateBoundary).toContain(": net.fetch as typeof globalThis.fetch");
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
      "dist_script: dist:release:win",
      "dist_script: dist:release:linux",
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
