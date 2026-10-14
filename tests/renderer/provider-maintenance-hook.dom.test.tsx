import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  AppSnapshot,
  ProviderMaintenanceOperation,
  ProviderMaintenanceStatus,
  ServerEvent,
} from "../../src/shared/contracts";
import { useProviderMaintenance } from "../../src/renderer/src/hooks/useProviderMaintenance";

const running: ProviderMaintenanceOperation = {
  id: "operation", providerId: "codex", status: "running", startedAt: "2030-01-01T00:00:00.000Z", finishedAt: null,
  beforeVersion: "0.124.0", afterVersion: null, targetVersion: "0.125.0", message: "Updating provider.",
  output: null, outputTruncated: false,
};

const available: ProviderMaintenanceStatus = {
  providerId: "codex", installedVersion: "0.124.0", latestVersion: "0.125.0", versionStatus: "update-available",
  freshness: "fresh", checkedAt: "2030-01-01T00:00:00.000Z", installMethod: "homebrew", updateAvailability: "available",
  updateLabel: "Update Codex with Homebrew", instructionsUrl: "https://example.invalid", message: null, manualCommand: null,
};

function snapshotDuringUpdate(): AppSnapshot {
  return {
    conversations: [],
    providers: [{ id: "codex", label: "Codex", maintenance: available }],
    maintenanceOperations: [running],
  } as unknown as AppSnapshot;
}

describe("useProviderMaintenance", () => {
  it("keeps a finished update when a conversation shell update reuses the snapshot taken while it ran", () => {
    let listener: ((event: ServerEvent) => void) | null = null;
    const subscribe = (next: (event: ServerEvent) => void) => {
      listener = next;
      return () => { listener = null; };
    };
    const send = vi.fn<(command: unknown) => Promise<ServerEvent>>();
    const during = snapshotDuringUpdate();
    const { result, rerender } = renderHook(
      ({ snapshot }) => useProviderMaintenance(snapshot, send, subscribe),
      { initialProps: { snapshot: during } },
    );
    expect(result.current.operations.get("codex")?.status).toBe("running");

    act(() => {
      listener?.({ type: "provider.maintenance.updated", providers: [{ ...available, installedVersion: "0.125.0", versionStatus: "current" }] });
      listener?.({ type: "provider.maintenance.operation", operation: {
        ...running, status: "succeeded", finishedAt: "2030-01-01T00:00:02.000Z", afterVersion: "0.125.0", message: "Provider updated.",
      } });
    });
    rerender({ snapshot: { ...during, conversations: [] } });

    expect(result.current.operations.get("codex")).toMatchObject({ status: "succeeded", afterVersion: "0.125.0" });
    expect(result.current.statuses.get("codex")).toMatchObject({ installedVersion: "0.125.0", versionStatus: "current" });
  });
});
