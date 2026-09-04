import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";

import {
  copyLifecycleSupportReport,
  registerLifecycleSupportReportIpc,
} from "../../src/main/lifecycle-support-report";
import {
  RuntimeDiagnostics,
  runtimeDiagnosticsDirectory,
} from "../../src/main/runtime-diagnostics";
import type { RuntimeLifecycleDiagnosticSnapshot } from "../../src/shared/lifecycle-diagnostics";
import type { AppUpdateStatus } from "../../src/shared/desktop";

const roots: string[] = [];

function lifecycle(): RuntimeLifecycleDiagnosticSnapshot {
  return {
    schemaVersion: 1,
    capturedAt: "2030-01-01T00:00:05.000Z",
    runtimeStartedAt: "2030-01-01T00:00:00.000Z",
    runtimeUptimeMs: 5_000,
    runtimeGenerationHash: "123456789abc",
    buildMetadata: null,
    systemBootRelationship: "current",
    startupBlockerCodes: [],
    quarantineReason: null,
    cleanupProofMethod: "current-generation-lease",
    ownedResources: {
      providerRuns: 0,
      turns: 0,
      terminals: 0,
      workspaceRuns: 0,
      interactions: 0,
      maintenanceOperations: 0,
    },
    activeProviders: [],
    providerMaintenance: [],
    updateHandoffPhase: null,
    unresolvedTurnCount: 0,
    unresolvedInteractionCount: 0,
    actionableState: "safe-and-ready",
  };
}

function input(lifecycleInput: unknown, writeClipboard = vi.fn()) {
  const root = mkdtempSync(join(tmpdir(), "inertia-lifecycle-report-"));
  roots.push(root);
  return {
    lifecycleInput,
    diagnostics: new RuntimeDiagnostics(runtimeDiagnosticsDirectory(root)),
    version: "1.2.3",
    channel: "stable" as const,
    platform: "linux",
    architecture: "x64",
    runtime: {
      phase: "ready" as const,
      generation: 1,
      pid: 1234,
      websocketUrl: "ws://127.0.0.1:1234/runtime-capability",
      runtimeGenerationHash: "123456789abc",
      restartAttempt: 0,
      restartScheduled: false,
      lastError: null,
      startupBlockerCode: null,
    },
    dataDirectory: root,
    writeClipboard,
  };
}

function blockedAppUpdate(): AppUpdateStatus {
  return {
    revision: 4,
    channel: "stable",
    state: "downloaded",
    freshness: "fresh",
    delivery: "in-app",
    deliveryReason: null,
    installBlocker: "active-work",
    progress: null,
    currentVersion: "1.2.3",
    latestVersion: "1.2.4",
    releaseUrl: null,
    checkedAt: "2030-01-01T00:00:00.000Z",
    lastAttemptedAt: "2030-01-01T00:00:00.000Z",
    message: "arbitrary renderer-visible update message",
  };
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("lifecycle support report boundary", () => {
  it("copies a validated code-and-count-only lifecycle projection", async () => {
    const writeClipboard = vi.fn();
    await expect(
      copyLifecycleSupportReport(input(lifecycle(), writeClipboard)),
    ).resolves.toMatchObject({ copied: true });
    expect(writeClipboard).toHaveBeenCalledOnce();
    expect(writeClipboard.mock.calls[0]?.[0]).toContain(
      "Lifecycle state: safe-and-ready",
    );
    expect(writeClipboard.mock.calls[0]?.[0]).toContain(
      "Runtime generation hash: 123456789abc",
    );
  });

  it("rejects extra renderer keys before writing the clipboard", async () => {
    const writeClipboard = vi.fn();
    await expect(
      copyLifecycleSupportReport(
        input(
          {
            ...lifecycle(),
            prompt: "private content",
          },
          writeClipboard,
        ),
      ),
    ).rejects.toThrow("snapshot is invalid");
    expect(writeClipboard).not.toHaveBeenCalled();
  });

  it("merges main-owned update and embedded build evidence without messages", async () => {
    const writeClipboard = vi.fn();
    await copyLifecycleSupportReport({
      ...input(lifecycle(), writeClipboard),
      appUpdateStatus: blockedAppUpdate(),
      buildMetadata: {
        source: "github-actions",
        sourceRevision: "c".repeat(40),
        runId: "4567890123",
        runAttempt: 1,
        releaseTag: null,
      },
    });
    const report = writeClipboard.mock.calls[0]?.[0] as string;
    expect(report).toContain(
      "Lifecycle state: update-blocked-by-active-work",
    );
    expect(report).toContain("Update preparation: blocked blocker=active-work");
    expect(report).toContain(`revision=${"c".repeat(40)}`);
    expect(report).not.toContain("arbitrary renderer-visible update message");
  });

  it("registers an exact one-argument IPC boundary and forwards its projection", async () => {
    const handlers = new Map<
      string,
      (event: IpcMainInvokeEvent, ...arguments_: unknown[]) => unknown
    >();
    const writeClipboard = vi.fn();
    const reportInput = input(null, writeClipboard);
    const assertTrustedIpc = vi.fn();
    registerLifecycleSupportReportIpc({
      ipcMain: {
        handle: (channel, handler) => {
          handlers.set(channel, handler);
        },
      },
      channel: "copy-report",
      assertTrustedIpc,
      createInput: () => {
        const { lifecycleInput: _, ...rest } = reportInput;
        return rest;
      },
    });
    const event = {} as IpcMainInvokeEvent;

    await expect(
      handlers.get("copy-report")!(event, lifecycle()),
    ).resolves.toMatchObject({ copied: true });
    expect(assertTrustedIpc).toHaveBeenCalledWith(event, 1, 1);
    expect(writeClipboard.mock.calls[0]?.[0]).toContain(
      "Runtime generation hash: 123456789abc",
    );
  });

  it.each([
    [
      "prior-runtime-cleanup-unconfirmed",
      "previous-runtime-cleanup-unconfirmed",
    ],
    [
      "provider-installation-quarantined",
      "recovery-requires-manual-attention",
    ],
  ] as const)(
    "prefers the main-owned %s blocker over a stale renderer snapshot",
    async (startupBlockerCode, expectedState) => {
      const writeClipboard = vi.fn();
      await copyLifecycleSupportReport({
        ...input(lifecycle(), writeClipboard),
        runtime: {
          phase: "stopped",
          generation: 2,
          pid: null,
          websocketUrl: null,
          runtimeGenerationHash: null,
          restartAttempt: 1,
          restartScheduled: false,
          lastError: "A fixed startup failure.",
          startupBlockerCode,
        },
      });

      const report = writeClipboard.mock.calls[0]?.[0] as string;
      expect(report).toContain(`Lifecycle state: ${expectedState}`);
      expect(report).toContain(`Startup blockers: ${startupBlockerCode}`);
      expect(report).not.toContain("Lifecycle state: safe-and-ready");
    },
  );
});
