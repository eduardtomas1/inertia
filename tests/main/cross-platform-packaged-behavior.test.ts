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

  it("keeps one native smoke implementation for macOS, Windows, and Linux runtime supervision", async () => {
    const smoke = await source("scripts/package-smoke.mjs");
    expect(smoke).toContain('process.platform === "darwin"');
    expect(smoke).toContain('process.platform === "win32"');
    expect(smoke).toContain('process.platform === "linux"');
    expect(smoke).toContain("runtimePid === mainPid");
    expect(smoke).toContain("runtime-stopped");
    expect(smoke).toContain("process-group cleanup");
    expect(smoke).toContain("Packaged Codex Ω (profile)");
    expect(smoke).toContain('join(root, "codex-bin")');
    expect(smoke).toContain("acknowledged:");
    expect(smoke).toContain('type: "provider.refresh"');
    expect(smoke).toContain('frame?.type === "runtime.event" ? frame.event : frame');
    expect(await source("src/main/index.ts")).toContain(
      "codexBinaryPath: packageSmokeCodexExecutable",
    );
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

    const releaseStart = main.indexOf("ipcMain.handle(IPC.releaseAttachment");
    const releaseEnd = main.indexOf("\n  });", releaseStart);
    const releaseHandler = main.slice(releaseStart, releaseEnd);
    expect(releaseHandler.indexOf("deferAttachmentRelease")).toBeLessThan(
      releaseHandler.indexOf("attachmentRegistry().release"),
    );

    const quitStart = main.indexOf('app.on("before-quit"');
    const quitEnd = main.indexOf("\n  });", quitStart);
    const quitHandler = main.slice(quitStart, quitEnd);
    expect(quitHandler.indexOf("supervisorToStop.stop()")).toBeLessThan(
      quitHandler.indexOf("disposeImportedAttachments()"),
    );
    expect(quitHandler).toContain("if (runtimeExitConfirmed)");
    expect(quitHandler).toContain(
      "Retaining temporary attachments because runtime process exit was not confirmed",
    );
    expect(main.indexOf('recordPackageSmokeStage("app-exit")')).toBeLessThan(
      main.indexOf("app.exit(0)"),
    );
    expect(main).toContain("attachmentReservation = orphanReservation");
    expect(main).toContain(
      "reservedRecords: attachmentReservation.records",
    );
    expect(main).toContain(
      "reservedBytes: attachmentReservation.bytes",
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
