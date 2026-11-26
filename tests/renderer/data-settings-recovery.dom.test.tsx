// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AttachmentStorageStatus } from "../../src/shared/attachment-storage";
import type { ServerEvent } from "../../src/shared/contracts";
import { defaultSettings } from "../../src/shared/contracts/app";
import type { AppHealthSnapshot } from "../../src/shared/desktop";
import { DataSettings } from "../../src/renderer/src/components/settings/sections/DataSettings";

const baseHealth: AppHealthSnapshot = {
  sampledAt: "2026-06-01T10:00:00.000Z",
  totalMemoryBytes: 512 * 1024 * 1024,
  mainProcess: null,
  rendererProcesses: [],
  runtimeProcess: null,
  runtimePhase: "ready",
  databaseBytes: 12 * 1024 * 1024,
  cacheBytes: 2 * 1024 * 1024,
  temporaryAttachmentBytes: 0,
  warnings: [],
};

const baseAttachmentStorage: AttachmentStorageStatus = {
  state: "ready",
  bytes: 3 * 1024 * 1024,
  records: 4,
  maxBytes: 16 * 1024 ** 3,
  maxRecords: 65_536,
  availableDiskBytes: 20 * 1024 ** 3,
  removableRecords: 4,
  removableBytes: 3 * 1024 * 1024,
};

function installDesktopMock() {
  const exportRecoveryData = vi.fn(async (options?: { includeAttachments?: boolean }) => ({
    status: "exported" as const,
    summary: {
      includeAttachments: options?.includeAttachments === true,
      attachments: options?.includeAttachments ? 3 : 0,
      missingAttachments: options?.includeAttachments ? 1 : 0,
    },
  }));
  const importRecoveryData = vi.fn(async () => ({
    status: "imported" as const,
    summary: {
      projects: 1,
      conversations: 2,
      messages: 5,
      alreadyImported: false,
      attachments: 3,
      missingAttachments: 1,
    },
  }));
  Object.defineProperty(window, "inertia", {
    configurable: true,
    value: {
      getAppHealth: vi.fn(async () => baseHealth),
      clearAppCache: vi.fn(async () => baseHealth),
      exportRecoveryData,
      importRecoveryData,
    },
  });
  return { exportRecoveryData, importRecoveryData };
}

describe("DataSettings portable recovery export options", () => {
  beforeEach(() => {
    installDesktopMock();
  });

  afterEach(() => {
    cleanup();
  });

  it("shows retained attachment estimate before confirming, defaults to text-only, and reports bundled/missing counts", async () => {
    const { exportRecoveryData, importRecoveryData } = installDesktopMock();
    const request = vi.fn(async (command: { type: string }): Promise<ServerEvent> => {
      if (command.type === "attachment.storage.get") {
        return {
          type: "request.result",
          requestId: "att-1",
          result: { kind: "attachment.storage", storage: baseAttachmentStorage },
        };
      }
      return { type: "request.ok", requestId: "other" };
    });

    render(
      <DataSettings
        settings={defaultSettings}
        disabled={false}
        providers={[]}
        archivedCount={0}
        onReportCommand={request}
        onUpdate={vi.fn(async () => undefined)}
        onUnarchive={vi.fn()}
        onRestoreDefaults={vi.fn(async () => undefined)}
      />,
    );

    const exportTrigger = screen.getByRole("button", { name: "Export recovery file" });
    fireEvent.click(exportTrigger);

    const dialog = screen.getByRole("group", { name: "Export recovery options" });
    const checkbox = within(dialog).getByRole("checkbox", { name: "Include attachments" });
    expect(checkbox).not.toBeChecked();
    expect(document.activeElement).toBe(checkbox);
    expect(await within(dialog).findByText("Retained attachments: 4 attachments (3.0 MiB).")).toBeVisible();

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("group", { name: "Export recovery options" })).toBeNull();
    expect(document.activeElement).toBe(exportTrigger);

    fireEvent.click(exportTrigger);
    const dialogForTextOnly = screen.getByRole("group", { name: "Export recovery options" });
    fireEvent.click(within(dialogForTextOnly).getByRole("button", { name: "Export recovery file…" }));
    await waitFor(() => {
      expect(exportRecoveryData).toHaveBeenCalledWith({ includeAttachments: false });
    });
    expect(
      await screen.findByText(
        "Recovery file exported. Attachments, credentials, provider sessions, and vault data were excluded.",
      ),
    ).toBeVisible();

    fireEvent.click(exportTrigger);
    const dialogForBundle = screen.getByRole("group", { name: "Export recovery options" });
    const bundleCheckbox = within(dialogForBundle).getByRole("checkbox", { name: "Include attachments" });
    fireEvent.click(bundleCheckbox);
    expect(bundleCheckbox).toBeChecked();
    fireEvent.click(within(dialogForBundle).getByRole("button", { name: "Export recovery bundle…" }));

    await waitFor(() => {
      expect(exportRecoveryData).toHaveBeenLastCalledWith({ includeAttachments: true });
    });
    expect(
      await screen.findByText(
        "Recovery bundle exported with 3 attachments (1 unavailable attachment was missing and listed in the manifest). Credentials, provider sessions, and vault data were excluded.",
      ),
    ).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Import recovery file" }));
    await waitFor(() => {
      expect(importRecoveryData).toHaveBeenCalledTimes(1);
    });
    expect(
      await screen.findByText(
        "Imported 1 projects, 2 conversations, 5 messages, and 3 attachments under new identities with supervised access. (1 unavailable attachment was missing from the bundle.)",
      ),
    ).toBeVisible();
  });
});
