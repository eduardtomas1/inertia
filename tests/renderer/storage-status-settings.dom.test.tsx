import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ACTIVE_TURN_COMPACT_EXPLANATION,
  StorageStatusSettings,
} from "../../src/renderer/src/components/StorageStatusSettings";
import { DataSettings } from "../../src/renderer/src/components/settings/sections/DataSettings";
import { defaultSettings, type ServerEvent } from "../../src/shared/contracts";
import type { DatabaseCompactionSummary, DatabaseStorageStatus } from "../../src/shared/database-storage";
import type { AppHealthSnapshot } from "../../src/shared/desktop";

const baseHealth: AppHealthSnapshot = {
  sampledAt: "2026-11-23T12:00:00.000Z",
  totalMemoryBytes: 256 * 1024 * 1024,
  mainProcess: { pid: 1, cpuPercent: 1, memoryBytes: 128 * 1024 * 1024 },
  rendererProcesses: [{ pid: 2, cpuPercent: 1, memoryBytes: 64 * 1024 * 1024 }],
  runtimeProcess: { pid: 3, cpuPercent: 1, memoryBytes: 64 * 1024 * 1024 },
  runtimePhase: "ready",
  databaseBytes: 120 * 1024 * 1024,
  cacheBytes: 10 * 1024 * 1024,
  temporaryAttachmentBytes: 2 * 1024 * 1024,
  warnings: [],
};

const baseDatabaseStorage: DatabaseStorageStatus = {
  pageSize: 4096,
  pageCount: 30_720,
  freelistCount: 18_432,
  databaseBytes: 125_829_120,
  reclaimableBytes: 75_497_472,
  walBytes: 4 * 1024 * 1024,
  backupCount: 3,
  backupBytes: 240 * 1024 * 1024,
  autoVacuum: "none",
  compactionState: "idle",
  busy: false,
  blockedReason: null,
};

function storageEvent(
  storage: DatabaseStorageStatus = baseDatabaseStorage,
  compaction?: DatabaseCompactionSummary,
): ServerEvent {
  return {
    type: "request.result",
    requestId: "req",
    result: { kind: "database.storage", storage, ...(compaction ? { compaction } : {}) },
  };
}

beforeEach(() => {
  Object.defineProperty(window, "inertia", {
    configurable: true,
    value: {
      getAppHealth: vi.fn(async () => baseHealth),
      clearAppCache: vi.fn(async () => baseHealth),
    },
  });
});

afterEach(() => {
  Reflect.deleteProperty(window, "inertia");
});

describe("StorageStatusSettings", () => {
  it("renders database size, reclaimable space, WAL size, backups total, and accessible Compact now button", () => {
    const onCompactDatabase = vi.fn(async () => undefined);
    render(
      <StorageStatusSettings
        health={baseHealth}
        healthUnavailable={false}
        clearingCache={false}
        clearCacheNotice={null}
        databaseStorage={baseDatabaseStorage}
        onClearCache={vi.fn(async () => undefined)}
        onCompactDatabase={onCompactDatabase}
      />,
    );

    const row = document.querySelector<HTMLElement>('[data-setting-id="database-storage"]')!;
    expect(within(row).getByText("Database storage")).toBeVisible();
    expect(within(row).getByText(
      "Database 120 MiB · Reclaimable 72 MiB · WAL 4.0 MiB · Backups 240 MiB (3 copies)",
    )).toBeVisible();

    const compactButton = within(row).getByRole("button", { name: "Compact now" });
    expect(compactButton).not.toHaveAttribute("aria-disabled");
    compactButton.focus();
    expect(compactButton).toHaveFocus();
    fireEvent.click(compactButton);
    expect(onCompactDatabase).toHaveBeenCalledOnce();
  });

  it("shows loading, unavailable, and singular backup copy states", () => {
    const { rerender } = render(
      <StorageStatusSettings
        health={baseHealth}
        healthUnavailable={false}
        clearingCache={false}
        clearCacheNotice={null}
        databaseStorage={null}
        databaseStorageUnavailable={false}
        onClearCache={vi.fn(async () => undefined)}
      />,
    );
    expect(screen.getByText("Measuring database storage…")).toBeVisible();
    expect(screen.getByRole("button", { name: "Compact now" })).toHaveAttribute("aria-disabled", "true");

    rerender(
      <StorageStatusSettings
        health={baseHealth}
        healthUnavailable={false}
        clearingCache={false}
        clearCacheNotice={null}
        databaseStorage={null}
        databaseStorageUnavailable={true}
        onClearCache={vi.fn(async () => undefined)}
      />,
    );
    expect(screen.getByText("Database storage details are unavailable.")).toBeVisible();

    rerender(
      <StorageStatusSettings
        health={baseHealth}
        healthUnavailable={false}
        clearingCache={false}
        clearCacheNotice={null}
        databaseStorage={{ ...baseDatabaseStorage, backupCount: 1, backupBytes: 80 * 1024 * 1024 }}
        onClearCache={vi.fn(async () => undefined)}
        onCompactDatabase={vi.fn(async () => undefined)}
      />,
    );
    expect(screen.getByText(/Backups 80 MiB \(1 copy\)/u)).toBeVisible();
  });

  it("disables Compact now with a keyboard-reachable explanation while a turn runs", () => {
    const onCompactDatabase = vi.fn(async () => undefined);
    render(
      <StorageStatusSettings
        health={baseHealth}
        healthUnavailable={false}
        clearingCache={false}
        clearCacheNotice={null}
        databaseStorage={baseDatabaseStorage}
        hasActiveTurns={true}
        onClearCache={vi.fn(async () => undefined)}
        onCompactDatabase={onCompactDatabase}
      />,
    );

    const button = screen.getByRole("button", { name: "Compact now" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toBeEnabled();
    button.focus();
    expect(button).toHaveFocus();
    expect(button).toHaveAccessibleDescription(ACTIVE_TURN_COMPACT_EXPLANATION);
    expect(screen.getByText(ACTIVE_TURN_COMPACT_EXPLANATION)).toBeVisible();

    fireEvent.click(button);
    expect(onCompactDatabase).not.toHaveBeenCalled();
  });

  it("displays busy progress states while compacting", () => {
    const { rerender } = render(
      <StorageStatusSettings
        health={baseHealth}
        healthUnavailable={false}
        clearingCache={false}
        clearCacheNotice={null}
        databaseStorage={{ ...baseDatabaseStorage, compactionState: "backing-up", busy: true }}
        compactingDatabase={true}
        onClearCache={vi.fn(async () => undefined)}
        onCompactDatabase={vi.fn(async () => undefined)}
      />,
    );
    expect(screen.getByRole("button", { name: "Backing up…" })).toHaveAttribute("aria-disabled", "true");

    rerender(
      <StorageStatusSettings
        health={baseHealth}
        healthUnavailable={false}
        clearingCache={false}
        clearCacheNotice={null}
        databaseStorage={{ ...baseDatabaseStorage, compactionState: "reclaiming", busy: true }}
        compactingDatabase={true}
        onClearCache={vi.fn(async () => undefined)}
        onCompactDatabase={vi.fn(async () => undefined)}
      />,
    );
    expect(screen.getByRole("button", { name: "Reclaiming space…" })).toHaveAttribute("aria-disabled", "true");
  });
});

describe("DataSettings database compaction workflow", () => {
  it("loads storage metrics, compacts on click, reports reclaimed bytes, and handles failures", async () => {
    let resolveCompact!: (event: ServerEvent) => void;
    let shouldFail = false;
    const afterStorage: DatabaseStorageStatus = {
      ...baseDatabaseStorage,
      pageCount: 12_288,
      freelistCount: 0,
      databaseBytes: 50_331_648,
      reclaimableBytes: 0,
      walBytes: 0,
      autoVacuum: "incremental",
    };
    const request = vi.fn(async (command: { type: string }): Promise<ServerEvent> => {
      if (command.type === "database.storage.get") return storageEvent(baseDatabaseStorage);
      if (command.type === "database.storage.compact") {
        if (shouldFail) throw new Error("Not enough free disk space to compact the database safely.");
        return await new Promise<ServerEvent>((resolve) => { resolveCompact = resolve; });
      }
      return { type: "request.ok", requestId: "other" };
    });

    render(
      <DataSettings
        settings={defaultSettings}
        disabled={false}
        providers={[]}
        archived={[]}
        onReportCommand={request}
        onUpdate={vi.fn(async () => undefined)}
        onUnarchive={vi.fn()}
        onRestoreDefaults={vi.fn(async () => undefined)}
      />,
    );

    expect(await screen.findByText(
      "Database 120 MiB · Reclaimable 72 MiB · WAL 4.0 MiB · Backups 240 MiB (3 copies)",
    )).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Compact now" }));
    expect(await screen.findByRole("button", { name: "Compacting…" })).toHaveAttribute("aria-disabled", "true");

    await act(async () => {
      resolveCompact(storageEvent(afterStorage, {
        mode: "full-vacuum",
        bytesBefore: baseDatabaseStorage.databaseBytes,
        bytesAfter: afterStorage.databaseBytes,
        reclaimedBytes: 79_691_776,
        walBytesBefore: baseDatabaseStorage.walBytes,
        walBytesAfter: 0,
        autoVacuumBefore: "none",
        autoVacuumAfter: "incremental",
      }));
    });

    expect(await screen.findByText("Compacted database and reclaimed 76 MiB.")).toBeVisible();
    expect(screen.getByText(
      "Database 48 MiB · Reclaimable 0 B · WAL 0 B · Backups 240 MiB (3 copies)",
    )).toBeVisible();
    await waitFor(() => expect(window.inertia.getAppHealth).toHaveBeenCalledTimes(2));

    shouldFail = true;
    fireEvent.click(screen.getByRole("button", { name: "Compact now" }));
    const row = document.querySelector<HTMLElement>('[data-setting-id="database-storage"]')!;
    expect(await within(row).findByRole("alert")).toHaveTextContent(
      "Not enough free disk space to compact the database safely.",
    );
  });
});
